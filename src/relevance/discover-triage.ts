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
 * Split by responsibility (2026-10-05): this module keeps the run loop and
 * remains the public import path; the store layer (triage-store.ts), the pure
 * decision layer (triage-decide.ts), the Jev payload builder
 * (triage-questions.ts) and the pure answer mapping (triage-answers.ts) are
 * re-exported below unchanged.
 */

import type { Database } from "bun:sqlite";
import { JevBudgetExceeded, type JevClient, type JevResult } from "./jev.ts";
import { DEFAULT_THRESHOLDS, decide, isNewsChannel, type Thresholds } from "./triage-decide.ts";
import { buildQuestions } from "./triage-questions.ts";
import { probsFrom, newsProbFrom, reasonFor, type Triaged } from "./triage-answers.ts";
import { ensureTriageTable, hasTable, loadChosenVideos, loadRubric, loadTodo, SAVED_BY_DAVID, sampleChosen } from "./triage-store.ts";

export * from "./triage-decide.ts";
export * from "./triage-questions.ts";
export * from "./triage-answers.ts";
export * from "./triage-store.ts";

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
