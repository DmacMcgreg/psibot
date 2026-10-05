/**
 * Hierarchical library search.
 *
 *   1. Classify the query itself down the taxonomy (one Jev call, the same
 *      batched tree questions phrased for a query) → top subtrees from the beam.
 *   2. Lexical prefilter: BM25 over the items filed in those subtrees, topped
 *      up from the whole library when the subtrees are thin → ≤ 40 candidates.
 *   3. One Jev call with a relevance noul per candidate → final ranking.
 *
 * Two Jev calls per search in "full" mode (both cached by payload hash).
 * The default "lean" mode (2026-09-26) usually needs one: when the query has
 * enough lexical matches, the categories of its top BM25 hits pick the
 * subtrees instead of the Jev routing call; the rerank call sends 30 shorter
 * candidates; and the query is normalised so case/spacing variants hit the
 * cache. See vivaldi-home/research/jev-discover-triage.md. Read-only on the DB,
 * so vivaldi-home can call it with its own read-only handle:
 *
 *   import { searchLibrary } from "<psibot>/src/relevance/search.ts";
 *   const res = await searchLibrary(db, "claude code memory plugins");
 */

import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { JevClient, noul, type Questions } from "./jev.ts";
import { loadLibrary, type LibKind } from "./library.ts";
import { canonicalUrl } from "./canon.ts";
import {
  beamSearch,
  edgeProbsFromAnswers,
  inSubtree,
  loadTaxonomy,
  routeByConfidence,
  treePayload,
  type Taxonomy,
} from "./taxonomy.ts";

const REPO = join(dirname(new URL(import.meta.url).pathname), "..", "..");

// ─── BM25 (pure) ────────────────────────────────────────────────────────────

const STOP = new Set(
  "a an and are as at be by for from how i in is it of on or that the this to what when where which who why with about into my me".split(" "),
);

/** Light plural folding so "llms"/"llm" and "macs"/"mac" match: drop one trailing "s" (not "ss"/"us"/"is"). */
export function stem(t: string): string {
  return t.length > 3 && /[^sui]s$/.test(t) ? t.slice(0, -1) : t;
}

export function tokenize(s: string): string[] {
  return (s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [])
    .map((t) => t.replace(/[.-]+$/, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export function bm25(query: string, docs: string[], k1 = 1.2, b = 0.75): number[] {
  const q = [...new Set(tokenize(query))];
  const toks = docs.map(tokenize);
  const N = docs.length || 1;
  const avg = toks.reduce((s, t) => s + t.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  return toks.map((t) => {
    const tf = new Map<string, number>();
    for (const w of t) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w) ?? 0;
      if (!f) continue;
      const n = df.get(w) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * t.length) / avg)));
    }
    return s;
  });
}

// ─── search ─────────────────────────────────────────────────────────────────

export interface SearchOptions {
  /** Final results to return (default 20). */
  limit?: number;
  /** Max candidates sent to the relevance noul (default 40). */
  candidates?: number;
  /** Restrict to kinds. */
  kinds?: LibKind[];
  /** Restrict the candidate pool to these item keys (the caller's active filters, e.g. a date range). */
  onlyKeys?: Set<string>;
  /** Jev client (defaults to one using this repo's cache, budget $0.05). */
  client?: JevClient;
  taxonomy?: Taxonomy;
  /** Edge threshold for turning the query's beam into subtrees (default 0.5). */
  threshold?: number;
  /** "lean" (default): lexical routing when possible, compact rerank. "full": the original two-call pipeline. */
  mode?: "lean" | "full";
}

/** Lean-mode knobs. */
export const LEAN = {
  candidates: 30,
  titleChars: 160,
  aboutChars: 240,
  /** Lexical routing needs at least this many BM25 hits… */
  minLexHits: 8,
  /** …and the winning subtree must hold this share of the top hits' BM25 weight. */
  minShare: 0.35,
  voteTop: 15,
} as const;

/** Lowercase, collapse whitespace, drop trailing punctuation: "Claude Code  memory?" → "claude code memory". */
export function normalizeQuery(q: string): string {
  return q.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").replace(/[\s?!.,;:]+$/, "").trim();
}

/**
 * Route by the categories of the top BM25 hits: each hit votes its BM25 score
 * for its top-level and second-level node. Returns null when the evidence is
 * thin (few hits or no clear winner) so the caller can ask Jev instead.
 */
export function lexicalRoute(
  hits: Array<{ path: string | null; bm: number }>,
  opts: { minHits?: number; minShare?: number; top?: number } = {},
): Array<{ path: string; score: number }> | null {
  const pos = hits.filter((h) => h.bm > 0).sort((a, b) => b.bm - a.bm);
  if (pos.length < (opts.minHits ?? LEAN.minLexHits)) return null;
  const top = pos.slice(0, opts.top ?? LEAN.voteTop).filter((h) => h.path);
  const total = top.reduce((s, h) => s + h.bm, 0);
  if (!total) return null;
  // Every hit votes for each node on its path (all depths).
  const vote = new Map<string, number>();
  for (const h of top) {
    const parts = h.path!.split("/");
    for (let d = 1; d <= parts.length; d++) {
      const node = parts.slice(0, d).join("/");
      vote.set(node, (vote.get(node) ?? 0) + h.bm);
    }
  }
  const share = (p: string) => (vote.get(p) ?? 0) / total;
  const bar = opts.minShare ?? LEAN.minShare;
  // The most specific nodes that still clear the bar: deepest first, and a
  // node is skipped when a deeper qualifying node below it was already taken.
  const qualifying = [...vote.keys()].filter((p) => share(p) >= bar)
    .sort((a, b) => b.split("/").length - a.split("/").length || share(b) - share(a));
  const out: Array<{ path: string; score: number }> = [];
  for (const p of qualifying) {
    if (out.some((o) => o.path.startsWith(`${p}/`) || p.startsWith(`${o.path}/`))) continue;
    out.push({ path: p, score: Math.round(share(p) * 1e4) / 1e4 });
    if (out.length >= 2) break;
  }
  return out.length ? out.sort((a, b) => b.score - a.score) : null;
}

export interface SearchHit {
  item_key: string;
  kind: LibKind;
  title: string;
  url: string | null;
  path: string | null;
  /** Jev P(relevant to the query). */
  relevance: number;
  bm25: number;
  in_subtree: boolean;
}

export interface SearchResult {
  query: string;
  /** Subtrees the query was routed to, best first, with beam score. */
  subtrees: Array<{ path: string; score: number }>;
  /** How the subtrees were chosen. */
  routedBy: "lexical" | "jev";
  hits: SearchHit[];
  jevCalls: number;
  costUsd: number;
}

function defaultClient(): JevClient {
  return new JevClient({ cacheDir: join(REPO, "data/jev-cache"), budgetUsd: 0.05 });
}

/** Query → subtrees: each beam path routed by confidence, deduped by prefix. */
export function subtreesFromBeam(tax: Taxonomy, answers: Parameters<typeof edgeProbsFromAnswers>[1], threshold = 0.5) {
  const beam = beamSearch(tax, edgeProbsFromAnswers(tax, answers));
  const out: Array<{ path: string; score: number }> = [];
  const best = beam[0]?.score ?? 0;
  for (const c of beam) {
    if (c.score < best * 0.5) continue; // far weaker than the best path
    const r = routeByConfidence(c, threshold);
    if (out.some((o) => inSubtree(r.nodeId, o.path))) continue;
    const entry = { path: r.nodeId, score: Math.round(c.score * 1e4) / 1e4 };
    // A broader subtree absorbs narrower ones and takes the best one's rank.
    const first = out.findIndex((o) => inSubtree(o.path, r.nodeId));
    if (first < 0) {
      out.push(entry);
      continue;
    }
    entry.score = out[first].score;
    out[first] = entry;
    for (let i = out.length - 1; i > first; i--) if (inSubtree(out[i].path, r.nodeId)) out.splice(i, 1);
  }
  return out;
}

export async function searchLibrary(db: Database, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const client = opts.client ?? defaultClient();
  const tax = opts.taxonomy ?? loadTaxonomy(join(REPO, "data/relevance/taxonomy.json"));
  const lean = (opts.mode ?? "lean") === "lean";
  if (lean) query = normalizeQuery(query);
  const limit = opts.limit ?? 20;
  const maxCand = opts.candidates ?? (lean ? LEAN.candidates : 40);
  const cost0 = client.totalCost;
  let calls = 0;

  // Lexical scores first: in lean mode they may make the routing call unnecessary.
  const items = loadLibrary(db, opts.kinds).filter((i) => !opts.onlyKeys || opts.onlyKeys.has(i.key));
  const paths = new Map<string, string>();
  for (const r of db.query<{ item_key: string; path: string }, []>(`SELECT item_key, path FROM item_categories`).all()) {
    paths.set(r.item_key, r.path);
  }
  const scores = bm25(query, items.map((i) => i.text));

  // 1. Route the query: lexically when the evidence is clear (lean), else via Jev.
  let subtrees = lean ? lexicalRoute(items.map((it, i) => ({ path: paths.get(it.key) ?? null, bm: scores[i] }))) : null;
  const routedBy: "lexical" | "jev" = subtrees ? "lexical" : "jev";
  if (!subtrees) {
    const qRes = await client.ask(treePayload(tax, { search_query: query }, "query"));
    calls++;
    subtrees = subtreesFromBeam(tax, qRes.answers, opts.threshold ?? 0.5);
  }

  // 2. Lexical prefilter. One copy per page: the same URL saved as a tab, an
  // article and a research note would otherwise fill several of the pool's slots.
  const best = new Map<string, { item: (typeof items)[number]; path: string | null; bm: number; inSub: boolean }>();
  items.forEach((item, i) => {
    const path = paths.get(item.key) ?? null;
    const inSub = !!path && subtrees.some((s) => inSubtree(path, s.path));
    const r = { item, path, bm: scores[i], inSub };
    const k = canonicalUrl(item.url) ?? item.key;
    const prev = best.get(k);
    if (!prev || r.bm > prev.bm || (r.bm === prev.bm && r.inSub && !prev.inSub)) best.set(k, r);
  });
  const ranked = [...best.values()];
  const sub = ranked.filter((r) => r.inSub && r.bm > 0).sort((a, b) => b.bm - a.bm);
  const rest = ranked.filter((r) => !r.inSub && r.bm > 0).sort((a, b) => b.bm - a.bm);
  // Subtree items first; lexical hits elsewhere fill the remaining slots (at
  // least a quarter, so a mis-routed query still finds exact-title matches).
  const subSlots = Math.min(sub.length, maxCand - Math.min(rest.length, Math.floor(maxCand / 4)));
  let pool = [...sub.slice(0, subSlots), ...rest.slice(0, maxCand - subSlots)];
  if (pool.length < maxCand) {
    // Few lexical matches: fill with other subtree items.
    const extra = ranked.filter((r) => r.inSub && r.bm === 0).slice(0, maxCand - pool.length);
    pool = [...pool, ...extra];
  }
  pool = pool.slice(0, maxCand);
  if (!pool.length) return { query, subtrees, routedBy, hits: [], jevCalls: calls, costUsd: client.totalCost - cost0 };

  // 3. Relevance nouls, one batched call.
  const questions: Questions = {};
  pool.forEach((_, i) => {
    questions[`r${i}`] = noul(`Is candidate #${i} a good result for the search query — does it substantially cover what the query asks about?`);
  });
  const state = {
    search_query: query,
    candidates: pool.map((p, i) => ({
      n: i,
      kind: p.item.kind,
      title: p.item.title.slice(0, lean ? LEAN.titleChars : 200),
      about: p.item.text.split(" \n ").slice(1).join(" ").slice(0, lean ? LEAN.aboutChars : 280),
    })),
  };
  const rel = await client.ask({ state, questions });
  calls++;
  const hits: SearchHit[] = pool.map((p, i) => ({
    item_key: p.item.key,
    kind: p.item.kind,
    title: p.item.title,
    url: p.item.url,
    path: p.path,
    relevance: Math.round((rel.answers[`r${i}`]?.noul ?? 0) * 1000) / 1000,
    bm25: Math.round(p.bm * 100) / 100,
    in_subtree: p.inSub,
  }));
  hits.sort((a, b) => b.relevance - a.relevance || b.bm25 - a.bm25);
  return { query, subtrees, routedBy, hits: hits.slice(0, limit), jevCalls: calls, costUsd: client.totalCost - cost0 };
}

