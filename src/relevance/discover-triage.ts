/**
 * Jev auto-triage for the Discover queue.
 *
 * David rates Discover items Interested / Not interested / Skip. This pass
 * reads those ratings as a rubric and asks Jev, once per unrated item, how he
 * would most likely rate it. Confident "not interested" items are hidden from
 * the vivaldi-home /discover "New" queue; confident "interested" ones are
 * sorted first with a "Jev pick" badge.
 *
 * Training-signal isolation (hard rule): decisions go ONLY to
 * `discover_jev_triage`. Nothing here writes discover_feedback, feedback_log,
 * or any other table read by src/discovery/profile.ts, src/relevance/labels.ts,
 * src/relevance/library.ts or src/discover/db.ts. A real rating from David
 * supersedes a triage row because every /discover view requires "no
 * discover_feedback row" first. See discover-triage.test.ts.
 *
 * Keep TRIAGE_DDL in sync with src/db/schema.ts.
 */

import type { Database } from "bun:sqlite";
import { choice, JevBudgetExceeded, noul, type JevClient, type JevResult, type Payload, type RawAnswer } from "./jev.ts";
import { isChosenVideo } from "./labels.ts";
import { loadGoals } from "../assets/goals.ts";

export const TRIAGE_DDL = [
  `CREATE TABLE IF NOT EXISTS discover_jev_triage (
    atlas_item_id INTEGER PRIMARY KEY,
    decision TEXT NOT NULL CHECK(decision IN ('hide','pick','unsure')),
    p_not REAL,
    p_interest REAL,
    p_protected REAL,
    reason TEXT,
    model TEXT,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discover_jev_triage_decision ON discover_jev_triage(decision)`,
  `CREATE INDEX IF NOT EXISTS idx_discover_jev_triage_run ON discover_jev_triage(run_id)`,
];

export function ensureTriageTable(db: Database): void {
  for (const sql of TRIAGE_DDL) db.exec(sql);
}

// ─── thresholds (pure) ──────────────────────────────────────────────────────

export type Decision = "hide" | "pick" | "unsure";

export interface Thresholds {
  /** Minimum P(not interested) to hide. */
  hide: number;
  /** Minimum P(interested) to pick. */
  pick: number;
  /** P(protected interest) at or above which an item is never hidden. */
  guard: number;
  /**
   * Minimum P(not interested) to hide an item David saved himself (Watch
   * Later, GitHub star, Reddit save). All of his ratings so far are on
   * discovery-found videos, so the rubric is extrapolated for these.
   */
  hideSaved: number;
  /**
   * Minimum P(interested) to pick an item from a channel David has chosen
   * videos from. The lean toward pick mostly rides in the Jev state
   * (`david_chose_videos_from_this_channel`); calibration on 2026-09-26 found
   * 0 of 3 channel-prior picks below 0.8 correct, so the default equals `pick`.
   */
  pickKnownChannel: number;
  /** Minimum P(interested) to pick a mainstream news item that passes David's news rule. */
  pickNews: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { hide: 0.85, pick: 0.8, guard: 0.5, hideSaved: 0.95, pickKnownChannel: 0.8, pickNews: 0.6 };

// ─── mainstream news (David's news rule, 2026-09-26) ────────────────────────

/**
 * Mainstream news outlets. Their channel says little about a clip, so they get
 * no channel prior; a topic rule decides instead (NEWS_RULE).
 */
export const NEWS_CHANNEL_RE =
  /^(ctv\b.*|cbc\b.*|global news.*|citynews.*|cp24|ottawa citizen|cpac|dw news|newsnation|ms now|msnbc|bloomberg (television|podcasts|tech|originals|quicktake)|reuters|associated press|pbs newshour|nbc news|cbs news|abc news.*|fox news.*|fox business|cnbc.*|cnn.*|sky news.*|al jazeera.*|bbc news.*|times now|news24|wion|c-span|arizona’s family.*|v6 news.*|the globe and mail|toronto star)$/i;

export const isNewsChannel = (by: string | null | undefined): boolean => !!by && NEWS_CHANNEL_RE.test(by.trim());

/** David's own words, given to Jev with every mainstream-news item. */
export const NEWS_RULE =
  "David lives in Ottawa. From mainstream news channels he wants: Ottawa hyper-local news, Ontario news, and Canadian " +
  "politics or policy of general importance (plus major world geopolitics as short highlights). He does not want generic " +
  "local filler from elsewhere: crime, crashes, weather, fires, sports and human-interest stories from other cities or " +
  "provinces, or full-length market shows.";

export const NEWS_QUESTION =
  "Is this news item Ottawa-local news, Ontario news, or Canadian politics or policy of general importance — the kind David's news rule says to keep?";

export interface DecideContext {
  /** Watch Later, GitHub star or Reddit save: David saved it himself. */
  savedByDavid?: boolean;
  /** Its channel appears among David's chosen videos (never true for a mainstream news channel). */
  knownChannel?: boolean;
  /**
   * Mainstream news item only: P(it is Ottawa-local, Ontario or Canadian
   * politics/policy of general importance) — David's news rule. At or above
   * `guard` it is never hidden and leans pick.
   */
  pCanadianNews?: number;
}

export interface Probs {
  pNot: number;
  pInterest: number;
  pProtected: number;
}

/**
 * Map Jev's probabilities to a decision. Hide wins only when it clears its
 * threshold AND the protected-interest guard is below its bar; the two
 * thresholds are both > 0.5 in practice, so hide and pick cannot both fire,
 * but if a caller sets them low enough to overlap the item stays unsure.
 */
export function decide(p: Probs, t: Thresholds = DEFAULT_THRESHOLDS, ctx: DecideContext = {}): Decision {
  const hideBar = ctx.savedByDavid ? Math.max(t.hide, t.hideSaved) : t.hide;
  // Channel prior: a channel David chose videos from is never hidden, and leans pick.
  const relevantNews = (ctx.pCanadianNews ?? 0) >= t.guard;
  const wantsHide = !ctx.knownChannel && !relevantNews && p.pNot >= hideBar && p.pProtected < t.guard;
  const pickBar = relevantNews ? Math.min(t.pick, t.pickNews) : ctx.knownChannel ? Math.min(t.pick, t.pickKnownChannel) : t.pick;
  const wantsPick = p.pInterest >= pickBar;
  if (wantsHide && wantsPick) return "unsure";
  if (wantsHide) return "hide";
  if (wantsPick) return "pick";
  return "unsure";
}

// ─── rubric: David's own ratings ────────────────────────────────────────────

/** Source label for an eligible Discover item. Mirrors DISCOVER_SOURCE_SQL in src/discover/db.ts. */
const SOURCE_SQL = `CASE
    WHEN a.kind='youtube' AND yv.playlist_item_id IS NOT NULL THEN 'youtube_watchlater'
    WHEN a.kind='youtube' AND a.source_id IN (SELECT video_id FROM discovery_candidates) THEN 'youtube_discovery'
    WHEN a.kind='inbox' AND json_extract(a.metadata_json,'$.source')='github' THEN 'github'
    WHEN a.kind='inbox' AND json_extract(a.metadata_json,'$.source')='reddit' THEN 'reddit'
    ELSE NULL END`;

export const SOURCE_TEXT: Record<string, string> = {
  youtube_discovery: "YouTube video found automatically by PsiBot's discovery crawler (David did not pick it)",
  youtube_watchlater: "YouTube video David saved to his Watch Later playlist himself",
  github: "GitHub repository David starred",
  reddit: "Reddit post David saved",
};
export const SAVED_BY_DAVID = new Set(["youtube_watchlater", "github", "reddit"]);

export interface ItemFacts {
  atlasId: number;
  title: string;
  source: string;
  topicGroup: string | null;
  by: string | null;
  tags: string[];
  durationMin: number | null;
  hasTranscript: boolean | null;
  excerpt: string;
  /** Videos David chose from this item's channel (youtube only; 0 when none). */
  chosenFromChannel?: number;
}

export interface RubricExample extends ItemFacts {
  verdict: "interested" | "not_interested";
  reasons: string[];
  note: string | null;
}

interface ItemRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  metadata_json: string;
  src: string | null;
  group_label: string | null;
  channel_title: string | null;
  transcript_len: number | null;
  duration_seconds: number | null;
}

const ITEM_SELECT = `SELECT a.id, a.kind, a.title, a.body, a.metadata_json, (${SOURCE_SQL}) AS src,
    g.label AS group_label, yv.channel_title, length(yv.transcript_text) AS transcript_len,
    (SELECT MAX(duration_seconds) FROM discovery_candidates dc WHERE dc.video_id = a.source_id) AS duration_seconds
  FROM atlas_items a
  JOIN discover_item_groups ig ON ig.atlas_item_id = a.id
  LEFT JOIN discover_topic_groups g ON g.id = ig.group_id
  LEFT JOIN youtube_videos yv ON a.kind = 'youtube' AND yv.video_id = a.source_id`;

/** Collapse whitespace, drop markdown headings/emphasis, clip. */
export function excerptOf(body: string, n = 420): string {
  const t = (body ?? "")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return (JSON.parse(s ?? "") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function toFacts(r: ItemRow): ItemFacts {
  const meta = parseJson<Record<string, unknown>>(r.metadata_json, {});
  const tags = Array.isArray(meta.tags)
    ? (meta.tags as unknown[]).map(String).filter((t) => t !== "auto-generated" && t !== "fallback").slice(0, 6)
    : [];
  // The overview's first line repeats the title in bold; skip past it.
  let body = r.body ?? "";
  if (r.kind === "youtube") body = body.replace(/^## Overview\s*\*\*[^\n]*\*\*\s*/m, "").split(/\n## /)[0] ?? body;
  return {
    atlasId: r.id,
    title: r.title,
    source: r.src ?? "other",
    topicGroup: r.group_label,
    by: r.channel_title || (typeof meta.channel === "string" ? meta.channel : null),
    tags,
    durationMin: r.duration_seconds ? Math.round(r.duration_seconds / 6) / 10 : null,
    hasTranscript: r.kind === "youtube" ? (r.transcript_len ?? 0) > 200 : null,
    excerpt: excerptOf(body),
  };
}

/** Latest rating per item; skipped is neutral and not part of the rubric. */
export function loadRubric(db: Database): RubricExample[] {
  const rows = db
    .query<ItemRow & { sentiment: string; reasons_json: string; note: string | null }, []>(
      `${ITEM_SELECT.replace("SELECT a.id,", "SELECT f.sentiment, f.reasons_json, f.note, a.id,")}
       JOIN discover_feedback f ON f.atlas_item_id = a.id
       WHERE f.id = (SELECT MAX(id) FROM discover_feedback f2 WHERE f2.atlas_item_id = a.id)
       ORDER BY f.id`,
    )
    .all();
  return rows
    .filter((r) => r.sentiment === "interested" || r.sentiment === "not_interested")
    .map((r) => ({
      ...toFacts(r),
      verdict: r.sentiment as RubricExample["verdict"],
      reasons: parseJson<string[]>(r.reasons_json, []).filter((x) => x && x !== "skipped"),
      note: r.note?.trim() || null,
    }));
}

/**
 * Unrated, un-triaged items currently eligible for /discover. Eligibility
 * mirrors ELIGIBLE_WHERE in vivaldi-home lib/collectors.ts and
 * DISCOVER_SOURCE_SQL in src/discover/db.ts. Deterministic pseudo-random
 * order so `--limit N` samples every source.
 */
export function loadTodo(db: Database, opts: { includeTriaged?: boolean } = {}): ItemFacts[] {
  const triaged = opts.includeTriaged || !hasTable(db, "discover_jev_triage")
    ? ""
    : `AND NOT EXISTS (SELECT 1 FROM discover_jev_triage t WHERE t.atlas_item_id = a.id)`;
  const rows = db
    .query<ItemRow, []>(
      `${ITEM_SELECT}
       WHERE NOT EXISTS (SELECT 1 FROM discover_feedback f WHERE f.atlas_item_id = a.id)
         ${triaged}
         AND (${SOURCE_SQL}) IS NOT NULL
       ORDER BY (a.id * 2654435761) % 4294967296`,
    )
    .all();
  return rows.map(toFacts);
}

// ─── chosen videos: David's own picks (positive side of the rubric) ──────────

export interface ChosenVideo {
  videoId: string;
  title: string;
  channel: string;
  tags: string[];
  /** Stratum: Jev taxonomy top-level topic (item_categories), else the Discover group. */
  topic: string | null;
  topicGroup: string | null;
  atlasId: number | null;
}

/**
 * Videos David chose himself: Watch Later, or sent to PsiBot before (or
 * without) discovery finding them — `isChosenVideo` in labels.ts. Discovery
 * finds are NOT positives.
 */
export function loadChosenVideos(db: Database): ChosenVideo[] {
  const rows = db
    .query<{ video_id: string; title: string; channel_title: string; tags: string; created_at: string; playlist_item_id: string | null; first_discovered_at: string | null; group_label: string | null; atlas_id: number | null; tax_path: string | null }, []>(
      `SELECT yv.video_id, yv.title, yv.channel_title, yv.tags, yv.created_at, yv.playlist_item_id,
              (SELECT MIN(discovered_at) FROM discovery_candidates dc WHERE dc.video_id = yv.video_id) AS first_discovered_at,
              a.id AS atlas_id, g.label AS group_label, ${hasTable(db, "item_categories")
                ? `(SELECT path FROM item_categories c WHERE c.item_key = 'video:' || yv.video_id)`
                : "NULL"} AS tax_path
         FROM youtube_videos yv
         LEFT JOIN atlas_items a ON a.kind = 'youtube' AND a.source_id = yv.video_id
         LEFT JOIN discover_item_groups ig ON ig.atlas_item_id = a.id
         LEFT JOIN discover_topic_groups g ON g.id = ig.group_id`,
    )
    .all();
  return rows.filter(isChosenVideo).map((r) => ({
    videoId: r.video_id,
    title: r.title,
    channel: r.channel_title,
    tags: parseJson<unknown[]>(r.tags, []).map(String).filter((t) => t !== "auto-generated" && t !== "fallback").slice(0, 3),
    topic: r.tax_path?.split("/")[0] ?? r.group_label,
    topicGroup: r.group_label,
    atlasId: r.atlas_id,
  }));
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Topic-stratified, deterministic sample: round-robin over topic groups
 * (largest first), one video at a time, in a stable hashed order, skipping
 * any video in `exclude` (atlas ids still waiting for triage or already rated,
 * so an item never serves as its own example) and repeating channels until
 * every group's fresh channels are used up.
 */
export function sampleChosen(chosen: ChosenVideo[], n: number, exclude: Set<number> = new Set()): ChosenVideo[] {
  const byGroup = new Map<string, ChosenVideo[]>();
  for (const v of chosen) {
    if (v.atlasId !== null && exclude.has(v.atlasId)) continue;
    const g = v.topic ?? "(no topic)";
    const list = byGroup.get(g) ?? [];
    list.push(v);
    byGroup.set(g, list);
  }
  const queues = [...byGroup.values()]
    .sort((a, b) => b.length - a.length)
    .map((l) => l.sort((a, b) => hash32(a.videoId) - hash32(b.videoId)));
  const out: ChosenVideo[] = [];
  const seenChannel = new Set<string>();
  for (let pass = 0; out.length < n && queues.some((q) => q.length); pass++) {
    for (const q of queues) {
      if (out.length >= n) break;
      // Prefer a channel not yet in the sample; fall back to the next video.
      const i = q.findIndex((v) => !seenChannel.has(v.channel));
      const [v] = q.splice(i >= 0 ? i : 0, 1);
      if (!v) continue;
      out.push(v);
      seenChannel.add(v.channel);
    }
  }
  return out;
}

export function hasTable(db: Database, name: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

// ─── Jev payload ────────────────────────────────────────────────────────────

/**
 * Safety floor, from David's own words: his note on a rejected anime recap
 * ("I'm interested in the spiritual philosophical ancient type") and his
 * interested examples (agent harness engineering, coding-agent tools, AI
 * roadmap analysis). Anything that is genuinely about these is never hidden.
 */
export const PROTECTED_INTERESTS =
  "Is this item a genuine, non-fiction treatment of spirituality, esotericism, religion, philosophy, consciousness, " +
  "ancient history or ancient mysteries, or of AI agent engineering (agent harnesses, coding-agent tools and models, " +
  "serious analysis of the AI roadmap or superintelligence)? Fiction, anime or manga recaps, games, and scripted drama " +
  "that merely borrow these themes do not count.";

/**
 * PROTECTED_INTERESTS plus David's money tracks from knowledge/GOALS.md, so a
 * concrete how-to on marketing, TikTok growth, AI or drone video editing,
 * client sites, tenders/grants, datasets or AI services is never hidden
 * either. Read at question-build time, so editing GOALS.md retargets Jev.
 * Falls back to PROTECTED_INTERESTS when the goals file can't be read.
 */
export function protectedInterests(tracks?: Array<{ id: string; description: string }>): string {
  let ts = tracks;
  if (!ts) {
    try {
      ts = loadGoals().tracks;
    } catch {
      ts = [];
    }
  }
  const goals = ts.filter((t) => t.description).map((t) => `${t.id} (${t.description.replace(/\.$/, "")})`);
  if (goals.length === 0) return PROTECTED_INTERESTS;
  return (
    PROTECTED_INTERESTS.replace(/\?\s*Fiction,/, "? Or is it a concrete, practical treatment (tools, techniques, steps, datasets, " +
      "open tenders or grants) of one of David's work goals: " + goals.join("; ") + "? Fiction,")
  );
}

const DECISION_Q =
  "Using David's rated examples, his reasons and his notes as the rubric, how would David most likely rate the item in his Discover queue?";
const DECISION_OPTIONS = {
  interested: "Interested: it matches the kinds of things he marked interested and he would want to watch or read it.",
  not_interested:
    "Not interested: it shares the reasons he gave for rejecting his not-interested examples (format, genre, source, language, length or lack of substance).",
  unsure: "Unsure: the rubric does not clearly settle it, or it is a topic he likes in a form he might or might not want.",
};

function factsState(f: ItemFacts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: f.title,
    source: SOURCE_TEXT[f.source] ?? f.source,
    topic_group: f.topicGroup,
    channel_or_author: f.by,
  };
  if (f.tags.length) out.tags = f.tags;
  if (f.durationMin !== null) out.duration_minutes = f.durationMin;
  if (f.hasTranscript !== null) out.has_transcript = f.hasTranscript;
  if (f.chosenFromChannel) out.david_chose_videos_from_this_channel = f.chosenFromChannel;
  out.excerpt = f.excerpt;
  return out;
}

/** The /discover page's generic reason chips; specific reasons carry more signal. */
const GENERIC_REASONS = new Set([
  "Exactly my interest", "Great source", "Want more like this", "Save for later",
  "Not interested", "Don't care", "Not my genre", "Wrong topic", "Already know this", "Too long", "Low quality",
]);

/** Specific reasons first, generic chips last, duplicates dropped. */
export function rankReasons(reasons: string[]): string[] {
  const uniq = [...new Set(reasons)];
  return [...uniq.filter((r) => !GENERIC_REASONS.has(r)), ...uniq.filter((r) => GENERIC_REASONS.has(r))];
}

/** Stable option key for a rubric example. */
export const exampleKey = (e: RubricExample) => `${e.verdict === "interested" ? "l" : "r"}_${e.atlasId}`;

export interface TriageQuestionSet {
  payloadFor(item: ItemFacts): Payload;
  examples: Map<string, RubricExample>;
}

export const chosenKey = (v: ChosenVideo) => `c_${v.videoId}`;

function ratedState(e: RubricExample, nReasons: number): Record<string, unknown> {
  return {
    title: e.title.slice(0, 80),
    channel: e.by,
    ...(e.durationMin !== null ? { minutes: e.durationMin } : {}),
    ...(e.reasons.length ? { reasons: rankReasons(e.reasons).slice(0, nReasons) } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

export function buildQuestions(rubric: RubricExample[], chosenSample: ChosenVideo[] = []): TriageQuestionSet {
  const liked = rubric.filter((e) => e.verdict === "interested");
  const rejected = rubric.filter((e) => e.verdict === "not_interested");
  if (rejected.length === 0 || liked.length === 0) {
    throw new Error(`rubric needs at least one interested and one not-interested rating (have ${liked.length}/${rejected.length})`);
  }
  const examples = new Map<string, RubricExample>(rubric.map((e) => [exampleKey(e), e]));
  // Chosen videos double as "liked" examples for the pick reason.
  for (const v of chosenSample) {
    examples.set(chosenKey(v), {
      atlasId: v.atlasId ?? 0, title: v.title, source: "youtube_chosen", topicGroup: v.topicGroup, by: v.channel,
      tags: v.tags, durationMin: null, hasTranscript: null, excerpt: "", verdict: "interested", reasons: ["a video you chose"], note: null,
    });
  }
  const opts = (xs: RubricExample[]) => {
    const o: Record<string, string> = {};
    for (const e of xs) o[exampleKey(e)] = `"${e.title.slice(0, 50)}"`;
    return o;
  };
  const likedOpts = { ...opts(liked) };
  for (const v of chosenSample) likedOpts[chosenKey(v)] = `"${v.title.slice(0, 40)}"`;
  likedOpts.none = "None of these is a close match.";
  const rejectedOpts = { ...opts(rejected), none: "None of these is a close match." };
  // Compact on purpose: the rubric rides in every call's state, so its size
  // sets the per-item cost. The item itself gets the full facts.
  const rubricState = {
    task:
      "David curates a Discover queue of videos, repositories and posts. david_chosen_videos are videos he picked " +
      "himself (saved to Watch Later or sent in), so they show the breadth of what he likes. david_rated_examples are " +
      "Discover items he rated, with his reasons and notes. Predict how he would rate a new item, judging it the way " +
      "he judged these.",
    sources: SOURCE_TEXT,
    // Every one of these is a positive: David picked it himself.
    david_chosen_videos: chosenSample.map((v) => ({
      title: v.title.slice(0, 80),
      channel: v.channel,
      ...(v.topic ? { topic: v.topic } : {}),
      ...(v.tags.length ? { tags: v.tags.slice(0, 2) } : {}),
    })),
    david_rated_examples: {
      interested: liked.map((e) => ratedState(e, 2)),
      not_interested: rejected.map((e) => ratedState(e, 3)),
    },
  };
  const questions = {
    decision: choice(DECISION_Q, DECISION_OPTIONS),
    closest_rejected: choice(
      "Which of David's not-interested examples is the item most like, in the sense that he would reject it for the same reason?",
      rejectedOpts,
    ),
    closest_liked: choice(
      "Which of David's interested examples is the item most like, in the sense that he would want it for the same reason?",
      likedOpts,
    ),
    protected_interest: noul(protectedInterests()),
  };
  return {
    examples,
    // Non-news payloads are unchanged, so their Jev cache stays valid.
    payloadFor: (item) =>
      isNewsChannel(item.by)
        ? { state: { ...rubricState, david_news_rule: NEWS_RULE, item: factsState(item) }, questions: { ...questions, canadian_news: noul(NEWS_QUESTION) } }
        : { state: { ...rubricState, item: factsState(item) }, questions },
  };
}

// ─── answers → decision + reason (pure) ─────────────────────────────────────

export interface Triaged {
  item: ItemFacts;
  decision: Decision;
  probs: Probs;
  reason: string;
}

function prob(a: RawAnswer | undefined, key: string): number {
  if (!a) return 0;
  const p = a.probabilities?.[key];
  if (typeof p === "number") return p;
  return a.choice === key ? (a.confidence ?? 1) : 0;
}

export function probsFrom(answers: Record<string, RawAnswer>): Probs {
  const g = answers.protected_interest;
  return {
    pNot: prob(answers.decision, "not_interested"),
    pInterest: prob(answers.decision, "interested"),
    pProtected: typeof g?.noul === "number" ? g.noul : 0,
  };
}

export function newsProbFrom(answers: Record<string, RawAnswer>): number | undefined {
  const n = answers.canadian_news?.noul;
  return typeof n === "number" ? n : undefined;
}

function closest(a: RawAnswer | undefined, examples: Map<string, RubricExample>): RubricExample | null {
  if (!a?.choice || a.choice === "none") return null;
  return examples.get(a.choice) ?? null;
}

export function reasonFor(
  decision: Decision,
  p: Probs,
  answers: Record<string, RawAnswer>,
  examples: Map<string, RubricExample>,
  keptBy: "guard" | "channel" | "news" | null = null,
  item?: ItemFacts,
  knownChannel = false,
): string {
  const rej = closest(answers.closest_rejected, examples);
  const lik = closest(answers.closest_liked, examples);
  const why = (e: RubricExample) =>
    e.note ? e.note : e.reasons.length ? rankReasons(e.reasons).slice(0, 2).join("; ") : e.verdict === "interested" ? "rated interested" : "rated not interested";
  const like = (e: RubricExample) =>
    e.source === "youtube_chosen"
      ? `like “${e.title.slice(0, 60)}${e.title.length > 60 ? "…" : ""}” (a video you chose)`
      : `like “${e.title.slice(0, 60)}${e.title.length > 60 ? "…" : ""}”: ${why(e)}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (decision === "hide") return rej ? `Not interested ${pct(p.pNot)} — ${like(rej)}` : `Not interested ${pct(p.pNot)}`;
  if (decision === "pick") {
    const base = lik ? `Interested ${pct(p.pInterest)} — ${like(lik)}` : `Interested ${pct(p.pInterest)}`;
    return knownChannel && item?.chosenFromChannel && p.pInterest < 0.8 ? `${base} · channel you've chosen before` : base;
  }
  const n = item?.chosenFromChannel ?? 0;
  const guard = keptBy === "news"
    ? " (kept: Ottawa / Ontario / Canadian politics news)"
    : keptBy === "guard"
    ? " (kept: core-interest topic)"
    : keptBy === "channel"
      ? ` (kept: you chose ${n} video${n === 1 ? "" : "s"} from ${item?.by})`
      : "";
  const lean = p.pNot >= p.pInterest ? (rej ? ` — leans ${like(rej)}` : "") : lik ? ` — leans ${like(lik)}` : "";
  return `Unsure: not ${pct(p.pNot)}, interested ${pct(p.pInterest)}${guard}${lean}`;
}

// ─── run ────────────────────────────────────────────────────────────────────

export type TriageClient = Pick<JevClient, "askMany" | "model">;

export interface TriageOptions {
  dryRun?: boolean;
  limit?: number | null;
  /** Only items in these topic groups (labels) — calibration spot checks. */
  groups?: string[] | null;
  /** Only items from these sources (youtube_discovery, youtube_watchlater, github, reddit). */
  sources?: string[] | null;
  /** How many chosen videos to put in the rubric (0 disables). */
  chosenSample?: number;
  /**
   * Re-triage items that already have a triage row when their channel matches
   * (e.g. NEWS_CHANNEL_RE). Their rows are replaced; everything else is still
   * skipped. Rated items are never touched.
   */
  retriageChannels?: RegExp | null;
  thresholds?: Thresholds;
  runId?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface TriageResult {
  runId: string;
  rubric: { interested: number; notInterested: number; chosenSample: number; chosenTotal: number; knownChannels: number; newsChannelsExcluded: number };
  /** Previous decision for re-triaged items (atlas id → decision). */
  previous: Map<number, string>;
  considered: number;
  triaged: Triaged[];
  written: number;
  errors: Array<{ atlasId: number; error: string }>;
  budgetHit: boolean;
}

export function newRunId(now = new Date()): string {
  return `jt-${now.toISOString().replace(/[:.]/g, "-")}`;
}

export async function triageDiscover(db: Database, client: TriageClient, opts: TriageOptions = {}): Promise<TriageResult> {
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  if (!opts.dryRun) ensureTriageTable(db);
  const rubric = loadRubric(db);
  const previous = new Map<number, string>();
  let allTodo = loadTodo(db);
  if (opts.retriageChannels && hasTable(db, "discover_jev_triage")) {
    const re = opts.retriageChannels;
    const again = loadTodo(db, { includeTriaged: true }).filter((i) => re.test(i.by ?? ""));
    const prev = db.query<{ atlas_item_id: number; decision: string }, []>(`SELECT atlas_item_id, decision FROM discover_jev_triage`).all();
    const prevBy = new Map(prev.map((r) => [r.atlas_item_id, r.decision]));
    const have = new Set(allTodo.map((i) => i.atlasId));
    for (const i of again) {
      if (have.has(i.atlasId)) continue;
      previous.set(i.atlasId, prevBy.get(i.atlasId) ?? "none");
      allTodo.push(i);
    }
  }
  const chosen = loadChosenVideos(db);
  // Channel prior. Mainstream news channels get none: one chosen clip says
  // little about the next; NEWS_RULE decides those instead.
  const chosenByChannel = new Map<string, number>();
  for (const v of chosen) chosenByChannel.set(v.channel, (chosenByChannel.get(v.channel) ?? 0) + 1);
  // Exclude every still-unrated queue item (triaged or not) and every rated
  // one, so the sample — and so Jev's cache key — stays the same from run to run.
  const unrated = hasTable(db, "discover_jev_triage") ? loadTodo(db, { includeTriaged: true }) : allTodo;
  const exclude = new Set<number>([...unrated.map((i) => i.atlasId), ...allTodo.map((i) => i.atlasId), ...rubric.map((e) => e.atlasId)]);
  const sample = sampleChosen(chosen, opts.chosenSample ?? 40, exclude);
  const qs = buildQuestions(rubric, sample);
  for (const i of allTodo) if (i.by && i.source.startsWith("youtube")) i.chosenFromChannel = chosenByChannel.get(i.by) ?? 0;
  const todo = allTodo.filter(
    (i) => (!opts.groups?.length || opts.groups.includes(i.topicGroup ?? "")) && (!opts.sources?.length || opts.sources.includes(i.source)),
  );
  const batch = opts.limit ? todo.slice(0, opts.limit) : todo;
  const res: TriageResult = {
    runId: opts.runId ?? newRunId(),
    rubric: {
      interested: rubric.filter((e) => e.verdict === "interested").length,
      notInterested: rubric.filter((e) => e.verdict === "not_interested").length,
      chosenSample: sample.length,
      chosenTotal: chosen.length,
      knownChannels: chosenByChannel.size,
      newsChannelsExcluded: [...chosenByChannel.keys()].filter(isNewsChannel).length,
    },
    previous,
    considered: todo.length,
    triaged: [],
    written: 0,
    errors: [],
    budgetHit: false,
  };
  // Only ever this table. INSERT OR IGNORE keeps an existing triage row,
  // except for items the caller explicitly asked to re-triage.
  const ins = opts.dryRun
    ? null
    : db.prepare(
        `INSERT OR IGNORE INTO discover_jev_triage (atlas_item_id, decision, p_not, p_interest, p_protected, reason, model, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
  const CHUNK = 64;
  for (let s = 0; s < batch.length; s += CHUNK) {
    const chunk = batch.slice(s, s + CHUNK);
    const out = await client.askMany(chunk.map((i) => qs.payloadFor(i)));
    const rows: Triaged[] = [];
    chunk.forEach((item, j) => {
      const a = out[j] as JevResult | Error;
      if (a instanceof Error) {
        if (a instanceof JevBudgetExceeded) res.budgetHit = true;
        else res.errors.push({ atlasId: item.atlasId, error: a.message.slice(0, 200) });
        return;
      }
      const probs = probsFrom(a.answers);
      const saved = SAVED_BY_DAVID.has(item.source);
      const news = isNewsChannel(item.by);
      const knownChannel = !!item.chosenFromChannel && !news;
      const pCanadianNews = news ? newsProbFrom(a.answers) : undefined;
      const decision = decide(probs, t, { savedByDavid: saved, knownChannel, pCanadianNews });
      // Why a would-be hide was kept: the news rule, the topic guard, or the channel prior.
      const hideBar = saved ? Math.max(t.hide, t.hideSaved) : t.hide;
      const keptBy = decision === "hide" || probs.pNot < hideBar
        ? null
        : (pCanadianNews ?? 0) >= t.guard ? "news" : probs.pProtected >= t.guard ? "guard" : knownChannel ? "channel" : null;
      rows.push({ item, decision, probs, reason: reasonFor(decision, probs, a.answers, qs.examples, keptBy, item, knownChannel) });
    });
    res.triaged.push(...rows);
    if (ins && rows.length) {
      db.transaction(() => {
        for (const r of rows) {
          if (res.previous.has(r.item.atlasId)) db.run(`DELETE FROM discover_jev_triage WHERE atlas_item_id = ?`, [r.item.atlasId]);
          const c = ins.run(r.item.atlasId, r.decision, r.probs.pNot, r.probs.pInterest, r.probs.pProtected, r.reason, client.model, res.runId);
          res.written += c.changes;
        }
      })();
    }
    opts.onProgress?.(Math.min(s + CHUNK, batch.length), batch.length);
    if (res.budgetHit) break;
  }
  return res;
}

/** Remove triage rows for one run, or all of them. Returns rows deleted. */
export function undoTriage(db: Database, runId: string): number {
  if (!hasTable(db, "discover_jev_triage")) return 0;
  const r = runId === "all"
    ? db.run(`DELETE FROM discover_jev_triage`)
    : db.run(`DELETE FROM discover_jev_triage WHERE run_id = ?`, [runId]);
  return r.changes;
}

export function triageCounts(db: Database): Array<{ run_id: string; decision: string; n: number }> {
  if (!hasTable(db, "discover_jev_triage")) return [];
  return db
    .query<{ run_id: string; decision: string; n: number }, []>(
      `SELECT run_id, decision, COUNT(*) AS n FROM discover_jev_triage GROUP BY run_id, decision ORDER BY run_id, decision`,
    )
    .all();
}
