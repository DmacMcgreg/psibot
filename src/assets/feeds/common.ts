/**
 * Shared plumbing for the asset feeds (CanadaBuys, Ontario funding, GC news,
 * IRAP leads, Hugging Face, GitHub, Hacker News, skills.sh, Kaggle).
 *
 * Every feed follows one pipeline, implemented by `runFeed`:
 *   1. collect: fetch the source and apply cheap rules → candidates;
 *   2. skip candidates already judged (asset_extractions, keyed on source_ref + version);
 *   3. score the rest in batched `askJson` calls with `goalsPromptBlock()`;
 *   4. upsert every item scoring ≥ KEEP_SCORE as an asset, record the rest as "gated";
 *   5. write per-run counts to ops_state (`assets:feed:<name>` and `assets:feeds`).
 *
 * A feed never throws out of a run: errors land in the stats row.
 */

import { goalsPromptBlock, trackIds } from "../goals.ts";
import { askJson, type AskOptions } from "../llm.ts";
import { upsertAsset, getExtraction, recordExtraction, assetKey } from "../store.ts";
import { markOwned, dismissIfOwned } from "../owned.ts";
import type { AssetInput, AssetKind, AssetSourceInput, Effort } from "../types.ts";
import { ASSET_KINDS } from "../types.ts";
import { getOpsState, setOpsState } from "../../db/queries.ts";
import { getDb } from "../../db/index.ts";
import { createLogger } from "../../shared/logger.ts";

const log = createLogger("asset-feeds");

/** Only items the scorer rates at or above this become assets. */
export const KEEP_SCORE = 40;
/** Items per scoring call. Keeps each reply short enough to parse reliably. */
export const SCORE_BATCH = 15;

export const UA = "Mozilla/5.0 (compatible; PsiBot-feeds/1.0)"; // open.canada.ca's WAF rejected a longer descriptive UA

// ---------------------------------------------------------------- fetching

export interface FetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
}

export async function fetchWithTimeout(url: string, opts: FetchOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, ...(opts.headers ?? {}) }, signal: ac.signal });
      if (res.status >= 500 && attempt < retries) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      return res;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
    await Bun.sleep(1500 * (attempt + 1));
  }
  throw new Error(`fetch ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetchWithTimeout(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function fetchJson<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithTimeout(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- small utils

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const daysAgo = (n: number, from = new Date()) => new Date(from.getTime() - n * 86_400_000);

export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function humanBytes(n: number | null | undefined): string | undefined {
  if (!n || !Number.isFinite(n) || n <= 0) return undefined;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Stable short hash for "did this item change" versions. */
export function shortHash(s: string): string {
  return new Bun.CryptoHasher("sha1").update(s).digest("hex").slice(0, 10);
}

/**
 * Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, embedded
 * newlines, CRLF, and a leading UTF-8 BOM. Returns one object per row keyed by
 * the header line.
 */
export function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------------------------------------------------------------- stats

export interface FeedStats {
  feed: string;
  started_at: string;
  finished_at?: string;
  ms?: number;
  /** Raw items the source returned. */
  seen: number;
  /** Items that passed the rules. */
  candidates: number;
  /** Candidates not judged before (sent to the scorer this run, up to the cap). */
  scored: number;
  /** Items at or above KEEP_SCORE, upserted as assets. */
  kept: number;
  /** Of the kept, how many were new rows. */
  created: number;
  /** Candidates the scorer rated below KEEP_SCORE. */
  dropped: number;
  /** All-time for this feed: items judged, and items kept as assets. */
  judged_total?: number;
  kept_total?: number;
  errors: string[];
  notes: string[];
}

export function newStats(feed: string): FeedStats {
  return { feed, started_at: new Date().toISOString(), seen: 0, candidates: 0, scored: 0, kept: 0, created: 0, dropped: 0, errors: [], notes: [] };
}

export const FEEDS_STATE_KEY = "assets:feeds";
export const feedStateKey = (feed: string) => `assets:feed:${feed}`;

/** Persist one run: per-feed key (with the last 10 runs) plus the all-feeds map the UI reads. */
export function saveStats(s: FeedStats): void {
  try {
    const prev = readFeedState(s.feed);
    const history = [summarize(s), ...(prev?.history ?? [])].slice(0, 10);
    setOpsState(feedStateKey(s.feed), JSON.stringify({ last: s, history }));
    const all = JSON.parse(getOpsState(FEEDS_STATE_KEY) ?? "{}") as Record<string, unknown>;
    all[s.feed] = summarize(s);
    setOpsState(FEEDS_STATE_KEY, JSON.stringify(all));
  } catch (e) {
    log.error("could not save feed stats", { feed: s.feed, error: String(e) });
  }
}

function summarize(s: FeedStats) {
  return {
    at: s.finished_at ?? s.started_at, ms: s.ms, seen: s.seen, candidates: s.candidates, scored: s.scored,
    kept: s.kept, created: s.created, dropped: s.dropped, judged_total: s.judged_total, kept_total: s.kept_total,
    errors: s.errors.length, error: s.errors[0] ?? null,
  };
}

export function readFeedState(feed: string): { last: FeedStats; history: ReturnType<typeof summarize>[] } | null {
  try {
    const raw = getOpsState(feedStateKey(feed));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Feed-private state (snapshots, cursors, ETags) in ops_state. */
export function getFeedMemo<T>(feed: string, name: string): T | null {
  try {
    const raw = getOpsState(`assets:feed:${feed}:${name}`);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function setFeedMemo(feed: string, name: string, value: unknown): void {
  setOpsState(`assets:feed:${feed}:${name}`, JSON.stringify(value));
}

// ---------------------------------------------------------------- scoring

/** What the scorer returns for one item. Feeds read the fields they asked for. */
export interface Judgment {
  i: number;
  score: number;
  track?: string;
  tracks?: string[];
  kind?: string;
  title?: string;
  summary?: string;
  reason?: string;
  next_action?: string;
  effort?: string;
  deadline?: string | null;
  amount?: string | null;
  eligibility?: string | null;
  install?: string | null;
  contents?: string | null;
  opportunity_type?: string | null;
}

export interface Candidate<T> {
  /** Stable id within the source (reference number, repo id, story id…). */
  ref: string;
  /** Changes when the item changes enough to deserve a re-score. */
  version: string;
  /** Rule-based priority; higher candidates are scored first when capped. */
  prior?: number;
  /** Compact JSON-able description handed to the scorer. */
  brief: Record<string, unknown>;
  raw: T;
}

export interface FeedSpec<T> {
  name: string;
  sourceKind: string;
  /** Extra scoring instructions for this feed: what to reward, disqualifiers, fields to fill. */
  instructions: string;
  /** Keep floor for this feed; defaults to KEEP_SCORE (40). Feeds whose items are cheap to find but costly to read use a higher bar. */
  keepScore?: number;
  /** Max candidates scored per run (rest wait for the next run). */
  maxScore?: number;
  askOptions?: AskOptions;
  collect(stats: FeedStats): Promise<Candidate<T>[]>;
  /**
   * Optional per-candidate enrichment (fetch an article, a README…), run only
   * for candidates about to be scored, so already-judged items cost nothing.
   * It may mutate `brief` and `raw`; a throw only skips the enrichment.
   */
  enrich?(c: Candidate<T>, stats: FeedStats): Promise<void>;
  toAsset(c: Candidate<T>, j: Judgment): { asset: AssetInput; source: AssetSourceInput };
}

const RUBRIC = `Score each item 0–100 for how much it moves David toward paid work THIS WEEK, judged only against the goals above. Paid work outranks tooling: a bid he can win beats any skill pack.
- 85–90 (up to 100 only for an exceptional fit): a winnable open bid, RFP or grant a 1–3 person shop qualifies for, or a warm lead with a named contact and a deadline.
- 70–80: a dataset or technique that directly powers a paid Cloud Nexus offer (the $2,260 small-business website package, WCAG accessibility audits, AI automation at $85/hr), or a bid, grant or lead with some doubt about fit or eligibility.
- 55–70: an installable skill, tool, block library or model that fits a track. Cap generic skill and tool packs at 70; go higher only when the pack itself delivers one of those paid offers.
- 45–54: real fit but smaller payoff or more effort.
- 40–44: marginal; worth a glance only.
- 0–39: drop. Most items belong here. Generic, off-track, news-only, or anything matching a "not:" line.
Be strict: when unsure, score below 40. Never invent facts: only use what the item states.`;

function buildPrompt(spec: { instructions: string }, briefs: Record<string, unknown>[]): string {
  const ids = trackIds().join(", ");
  return `You are the scorer for David's research feeds. Turn raw feed items into assets he can act on, or drop them.

${goalsPromptBlock()}

${RUBRIC}

Track ids: ${ids}.

Feed-specific instructions:
${spec.instructions.trim()}

Items (JSON, "i" is the index):
${JSON.stringify(briefs, null, 0)}

Reply with ONLY a JSON array, one object per item, in this shape:
[{"i":0,"score":0,"track":"<track id>","tracks":["<track id>"],"title":"<clean title>","summary":"<1–2 sentences: what it IS>","reason":"<one sentence: why this score>","next_action":"<one imperative sentence>","effort":"S|M|L", ...feed-specific fields}]
For items scoring below 40 you may reply with just {"i":N,"score":N,"reason":"…"}.`;
}

type Ask = (prompt: string, opts: AskOptions) => Promise<unknown>;
let ask: Ask = askJson;

/** Swap the model call (tests). Pass null to restore askJson. */
export function setAskForTesting(fn: Ask | null): void {
  ask = fn ?? askJson;
}

export async function scoreBatch(spec: { instructions: string; askOptions?: AskOptions }, briefs: Record<string, unknown>[]): Promise<Judgment[]> {
  const indexed = briefs.map((b, i) => ({ i, ...b }));
  const reply = (await ask(buildPrompt(spec, indexed), { timeoutMs: 300_000, ...spec.askOptions })) as Judgment[] | { items: Judgment[] };
  const list = Array.isArray(reply) ? reply : Array.isArray(reply?.items) ? reply.items : [];
  return list.filter((j) => j && Number.isInteger(Number(j.i)) && Number.isFinite(Number(j.score)))
    .map((j) => ({ ...j, i: Number(j.i), score: Number(j.score) }));
}

// ---------------------------------------------------------------- asset helpers

export function pickTrack(j: Judgment, fallback: string): { track: string; tracks: string[] } {
  const ids = new Set(trackIds());
  const track = j.track && ids.has(j.track) ? j.track : fallback;
  const tracks = [...new Set([track, ...(j.tracks ?? []).filter((t) => ids.has(t))])];
  return { track, tracks };
}

export function pickEffort(e: string | undefined): Effort | null {
  return e === "S" || e === "M" || e === "L" ? e : null;
}

export function pickKind(k: string | undefined, allowed: AssetKind[], fallback: AssetKind): AssetKind {
  return k && (ASSET_KINDS as readonly string[]).includes(k) && allowed.includes(k as AssetKind) ? (k as AssetKind) : fallback;
}

/** ISO date (YYYY-MM-DD) or null. Accepts ISO strings and "September 9, 2026". */
export function toIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const iso = String(s).match(/\b(20\d\d)-(\d\d)-(\d\d)(?!\d)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = String(s).match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d\d)\b/i);
  if (!m) return null;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(m[1].toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export function textOr(s: string | null | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return t || fallback;
}

// ---------------------------------------------------------------- the pipeline

const VERSION_PREFIX = "feed-v1";

/** True when an asset with this dedupe key is already in the registry. */
function knownKey(key: string): boolean {
  return !!getDb().prepare<{ id: number }, [string]>(`SELECT id FROM assets WHERE key = ?`).get(key);
}

export async function runFeed<T>(spec: FeedSpec<T>): Promise<FeedStats> {
  const stats = newStats(spec.name);
  const t0 = Date.now();
  try {
    const candidates = await spec.collect(stats);
    stats.candidates = candidates.length;
    const fresh = candidates
      .filter((c) => !getExtraction(spec.sourceKind, c.ref, `${VERSION_PREFIX}:${c.version}`))
      .sort((a, b) => (b.prior ?? 0) - (a.prior ?? 0));
    const cap = spec.maxScore ?? 60;
    if (fresh.length > cap) stats.notes.push(`${fresh.length - cap} fresh candidates deferred to the next run`);
    const batch = fresh.slice(0, cap);
    if (spec.enrich) {
      for (const c of batch) {
        try { await spec.enrich(c, stats); } catch (e) { stats.notes.push(`enrich ${c.ref}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }

    for (let off = 0; off < batch.length; off += SCORE_BATCH) {
      const chunk = batch.slice(off, off + SCORE_BATCH);
      let judgments: Judgment[];
      try {
        judgments = await scoreBatch(spec, chunk.map((c) => c.brief));
      } catch (e) {
        stats.errors.push(`scoring batch ${off / SCORE_BATCH}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      stats.scored += chunk.length;
      const byIndex = new Map(judgments.map((j) => [j.i, j]));
      for (const [i, c] of chunk.entries()) {
        const j = byIndex.get(i);
        if (!j) continue; // left unrecorded: re-scored next run
        const version = `${VERSION_PREFIX}:${c.version}`;
        if (j.score < Math.max(KEEP_SCORE, spec.keepScore ?? KEEP_SCORE)) {
          stats.dropped++;
          recordExtraction({ source_kind: spec.sourceKind, source_ref: c.ref, version, status: "gated", gate_score: j.score, model: "feed" });
          // An amended tender already in the registry takes its new, lower score
          // (store.ts lets a feed re-score lower an opportunity), so it sinks
          // instead of staying live on the old judgment.
          try {
            const { asset, source } = spec.toAsset(c, j);
            if (asset.kind === "opportunity" && knownKey(assetKey(asset))) upsertAsset(asset, source);
          } catch (e) {
            stats.errors.push(`re-score ${c.ref}: ${e instanceof Error ? e.message : String(e)}`);
          }
          continue;
        }
        try {
          const { asset, source } = spec.toAsset(c, j);
          const marked = markOwned(asset);
          const r = upsertAsset(marked, source);
          await dismissIfOwned(r.id, marked);
          stats.kept++;
          if (r.created) stats.created++;
          recordExtraction({ source_kind: spec.sourceKind, source_ref: c.ref, version, status: "done", gate_score: j.score, n_assets: 1, model: "feed" });
        } catch (e) {
          stats.errors.push(`upsert ${c.ref}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e) {
    stats.errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    const t = getDb().prepare<{ judged: number; kept: number }, [string]>(
      `SELECT COUNT(*) AS judged, COALESCE(SUM(status = 'done'), 0) AS kept FROM asset_extractions WHERE source_kind = ?`,
    ).get(spec.sourceKind);
    stats.judged_total = t?.judged ?? 0;
    stats.kept_total = t?.kept ?? 0;
  } catch { /* totals are cosmetic */ }
  stats.finished_at = new Date().toISOString();
  stats.ms = Date.now() - t0;
  saveStats(stats);
  log.info("feed run", { feed: spec.name, seen: stats.seen, candidates: stats.candidates, scored: stats.scored, kept: stats.kept, created: stats.created, errors: stats.errors.length });
  return stats;
}
