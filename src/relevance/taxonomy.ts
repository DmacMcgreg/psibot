/**
 * Library topic taxonomy + hierarchical classification (pure parts).
 *
 * The taxonomy lives in data/relevance/taxonomy.json as
 * [{ id, label, description, children: [...] }]. Ids are prefix-closed slugs:
 * a child's id is its parent's id + "/" + a local slug, so a node id IS the
 * slash-joined path from the root ("ai-agents/claude-code/skills-plugins"),
 * and `path LIKE 'ai-agents/%'` selects a subtree.
 *
 * Classification follows Jev example 16 (greedy vs width-3 beam over Choice
 * distributions) with the confidence routing of example 18 (stop at a parent
 * when the child edge is uncertain). All Choice questions for the whole tree —
 * the root plus one per internal node — go in ONE Jev call per item, so the
 * beam, greedy and routing all run locally over the same answers; comparing
 * greedy with beam costs nothing extra.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { choice, type Payload, type Questions, type RawAnswer } from "./jev.ts";

// ─── tree ───────────────────────────────────────────────────────────────────

export interface TaxNode {
  id: string;
  label: string;
  description: string;
  children: TaxNode[];
}

export interface Taxonomy {
  roots: TaxNode[];
  /** Stable content hash; bump invalidates stored categories. */
  version: string;
  byId: Map<string, TaxNode>;
  parentOf: Map<string, string | null>;
}

/** Bump when the classifier's question wording or routing semantics change. */
export const CLASSIFIER_VERSION = "c1";

export const ROOT = "";

export function buildTaxonomy(roots: TaxNode[]): Taxonomy {
  const byId = new Map<string, TaxNode>();
  const parentOf = new Map<string, string | null>();
  const visit = (n: TaxNode, parent: string | null) => {
    if (!n.id || byId.has(n.id)) throw new Error(`taxonomy: missing or duplicate id "${n.id}"`);
    if (parent !== null && !n.id.startsWith(`${parent}/`)) {
      throw new Error(`taxonomy: child id "${n.id}" must start with "${parent}/"`);
    }
    if (parent === null && n.id.includes("/")) throw new Error(`taxonomy: top-level id "${n.id}" contains "/"`);
    byId.set(n.id, n);
    parentOf.set(n.id, parent);
    for (const c of n.children ?? []) visit(c, n.id);
  };
  for (const r of roots) visit(r, null);
  const version = `${CLASSIFIER_VERSION}-${createHash("sha256").update(JSON.stringify(roots)).digest("hex").slice(0, 10)}`;
  return { roots, version, byId, parentOf };
}

export function loadTaxonomy(path = "data/relevance/taxonomy.json"): Taxonomy {
  return buildTaxonomy(JSON.parse(readFileSync(path, "utf-8")) as TaxNode[]);
}

/** Children of a node id ("" = root). */
export function childrenOf(tax: Taxonomy, id: string): TaxNode[] {
  if (id === ROOT) return tax.roots;
  return tax.byId.get(id)?.children ?? [];
}

/** Every node with children, root first ("" stands for the root). */
export function internalNodes(tax: Taxonomy): string[] {
  const out = [ROOT];
  for (const [id, n] of tax.byId) if (n.children.length > 0) out.push(id);
  return out;
}

export function leaves(tax: Taxonomy): string[] {
  return [...tax.byId.values()].filter((n) => n.children.length === 0).map((n) => n.id);
}

/** Ancestors-and-self ids of a node, top-down: "a/b/c" → ["a","a/b","a/b/c"]. */
export function lineage(id: string): string[] {
  const parts = id.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** True when `id` equals `prefix` or lies inside its subtree. */
export function inSubtree(id: string, prefix: string): boolean {
  return prefix === ROOT || id === prefix || id.startsWith(`${prefix}/`);
}

/** Depth-first walk with depth (top-level = 1). */
export function* walk(tax: Taxonomy): Generator<{ node: TaxNode; depth: number }> {
  const stack: Array<{ node: TaxNode; depth: number }> = tax.roots.map((node) => ({ node, depth: 1 })).reverse();
  while (stack.length) {
    const cur = stack.pop()!;
    yield cur;
    for (let i = cur.node.children.length - 1; i >= 0; i--) stack.push({ node: cur.node.children[i], depth: cur.depth + 1 });
  }
}

// ─── questions ──────────────────────────────────────────────────────────────

/** Jev question key for an internal node. */
export function questionKey(id: string): string {
  return id === ROOT ? "root" : `n_${id.replace(/[^a-z0-9]+/gi, "_")}`;
}

/** Option key for a child inside its parent's Choice (its local slug). */
export function optionKey(childId: string): string {
  const local = childId.split("/").pop()!;
  return local.replace(/[^a-z0-9]+/gi, "_");
}

export type ClassifyMode = "item" | "query";

/**
 * One Choice per internal node, conditional on the parent ("suppose it
 * belongs under X — which sub-category?"), so the beam can multiply edges.
 */
export function treeQuestions(tax: Taxonomy, mode: ClassifyMode = "item"): Questions {
  const subject = mode === "item" ? "this library item" : "this search query";
  const verb = mode === "item" ? "is mainly about" : "is looking for";
  const qs: Questions = {};
  for (const id of internalNodes(tax)) {
    const kids = childrenOf(tax, id);
    if (kids.length < 2) continue; // single-child edges are non-decisions
    const criteria: Record<string, string> = {};
    for (const k of kids) criteria[optionKey(k.id)] = `${k.label}: ${k.description}`;
    const instructions = id === ROOT
      ? `Which top-level topic area of David's personal library best matches what ${subject} ${verb}?`
      : `Suppose ${subject} belongs under "${tax.byId.get(id)!.label}". Which of its sub-categories best matches what it ${verb}?`;
    qs[questionKey(id)] = choice(instructions, criteria);
  }
  return qs;
}

export function treePayload(tax: Taxonomy, state: unknown, mode: ClassifyMode = "item"): Payload {
  return { state, questions: treeQuestions(tax, mode) };
}

/** Child-probability table per internal node id, from a Jev answer set. */
export type EdgeProbs = Map<string, Map<string, number>>;

export function edgeProbsFromAnswers(tax: Taxonomy, answers: Record<string, RawAnswer>): EdgeProbs {
  const out: EdgeProbs = new Map();
  for (const id of internalNodes(tax)) {
    const kids = childrenOf(tax, id);
    const m = new Map<string, number>();
    if (kids.length === 1) {
      m.set(kids[0].id, 1);
    } else {
      const a = answers[questionKey(id)];
      const p = a?.probabilities ?? {};
      let tot = 0;
      for (const k of kids) tot += Math.max(0, p[optionKey(k.id)] ?? 0);
      for (const k of kids) {
        let v = p[optionKey(k.id)] ?? 0;
        // No distribution but a pick: treat the pick as certain.
        if (tot === 0 && a?.choice === optionKey(k.id)) v = 1;
        m.set(k.id, tot > 0 ? Math.max(0, v) / tot : v);
      }
    }
    out.set(id, m);
  }
  return out;
}

// ─── search: greedy + beam (example 16) ─────────────────────────────────────

export const BEAM_WIDTH = 3;
const EPSILON = 1e-9;

export interface Candidate {
  /** Node ids top-down; the last is the candidate's node. */
  path: string[];
  /** Edge probabilities aligned with `path` (1 for single-child edges). */
  edges: number[];
  product: number;
  decisions: number;
  /** Geometric mean of decision edges (length-normalised). */
  score: number;
}

function extend(c: Candidate, childId: string, p: number, isDecision: boolean): Candidate {
  const product = c.product * (isDecision ? Math.max(p, EPSILON) : 1);
  const decisions = c.decisions + (isDecision ? 1 : 0);
  return {
    path: [...c.path, childId],
    edges: [...c.edges, isDecision ? p : 1],
    product,
    decisions,
    score: decisions ? product ** (1 / decisions) : 1,
  };
}

const nodeOf = (c: Candidate) => (c.path.length ? c.path[c.path.length - 1] : ROOT);

export function beamSearch(tax: Taxonomy, probs: EdgeProbs, width = BEAM_WIDTH, maxDepth = 12): Candidate[] {
  let beam: Candidate[] = [{ path: [], edges: [], product: 1, decisions: 0, score: 1 }];
  for (let d = 0; d < maxDepth; d++) {
    const expandable = beam.filter((c) => childrenOf(tax, nodeOf(c)).length > 0);
    if (!expandable.length) break;
    const finished = beam.filter((c) => childrenOf(tax, nodeOf(c)).length === 0);
    const expanded: Candidate[] = [];
    for (const c of expandable) {
      const dist = probs.get(nodeOf(c)) ?? new Map();
      const kids = childrenOf(tax, nodeOf(c));
      for (const k of kids) expanded.push(extend(c, k.id, dist.get(k.id) ?? 0, kids.length > 1));
    }
    beam = [...finished, ...expanded].sort(byScore).slice(0, width);
  }
  return beam.sort(byScore);
}

function byScore(a: Candidate, b: Candidate): number {
  return b.score - a.score || b.product - a.product || a.path.join("/").localeCompare(b.path.join("/"));
}

export function greedySearch(tax: Taxonomy, probs: EdgeProbs, maxDepth = 12): Candidate {
  let c: Candidate = { path: [], edges: [], product: 1, decisions: 0, score: 1 };
  for (let d = 0; d < maxDepth; d++) {
    const kids = childrenOf(tax, nodeOf(c));
    if (!kids.length) break;
    const dist = probs.get(nodeOf(c)) ?? new Map();
    let best = kids[0];
    for (const k of kids) if ((dist.get(k.id) ?? 0) > (dist.get(best.id) ?? 0)) best = k;
    c = extend(c, best.id, dist.get(best.id) ?? 0, kids.length > 1);
  }
  return c;
}

// ─── confidence routing (example 18) ────────────────────────────────────────

export const DEFAULT_STOP_THRESHOLD = 0.5;

export interface Routed {
  /** Node the item is filed under (a leaf, or a parent when routing stopped early). */
  nodeId: string;
  /** Edge probabilities for the kept levels. */
  levels: Array<{ id: string; p: number }>;
  /** Product of the kept edges: P(item belongs under nodeId). */
  confidence: number;
  stoppedEarly: boolean;
}

/**
 * Walk the best path top-down and stop at the parent when the next edge is
 * below `threshold`. The top level is always kept (there is no parent above
 * it); its low probability shows up in `confidence`.
 */
export function routeByConfidence(c: Candidate, threshold = DEFAULT_STOP_THRESHOLD): Routed {
  const levels: Array<{ id: string; p: number }> = [];
  let conf = 1;
  for (let i = 0; i < c.path.length; i++) {
    const p = c.edges[i];
    if (i > 0 && p < threshold) {
      return { nodeId: c.path[i - 1], levels, confidence: conf, stoppedEarly: true };
    }
    levels.push({ id: c.path[i], p });
    conf *= p;
  }
  return { nodeId: c.path[c.path.length - 1] ?? ROOT, levels, confidence: conf, stoppedEarly: false };
}

// ─── full result for one item ───────────────────────────────────────────────

export interface Classification {
  /** Filed node id = slash-joined path (item_categories.path). */
  path: string;
  /** Best full-depth leaf from the beam, even when `path` stopped at a parent. */
  leaf: string;
  confidence: number;
  levels: Array<{ id: string; p: number }>;
  stoppedEarly: boolean;
  beam: Array<{ leaf: string; score: number; product: number }>;
  greedyLeaf: string;
}

export function classifyFromProbs(tax: Taxonomy, probs: EdgeProbs, threshold = DEFAULT_STOP_THRESHOLD): Classification {
  const beam = beamSearch(tax, probs);
  const best = beam[0];
  const routed = routeByConfidence(best, threshold);
  const greedy = greedySearch(tax, probs);
  return {
    path: routed.nodeId,
    leaf: nodeOf(best),
    confidence: routed.confidence,
    levels: routed.levels,
    stoppedEarly: routed.stoppedEarly,
    beam: beam.map((c) => ({ leaf: nodeOf(c), score: round(c.score), product: round(c.product) })),
    greedyLeaf: nodeOf(greedy),
  };
}

function round(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

// ─── overrides ──────────────────────────────────────────────────────────────

export interface StoredCategory {
  path: string;
  leaf: string;
  confidence: number;
  altJson: string | null;
}

/**
 * Human overrides always win: when a /library user moved an item, the stored
 * category is the override (confidence 1) and the model's opinion is kept in
 * alt_json for later threshold/taxonomy tuning. Latest override wins.
 */
export function resolveCategory(
  model: Classification | null,
  overrides: Array<{ path: string; created_at: string }>,
): StoredCategory | null {
  const latest = [...overrides].sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  if (latest) {
    return {
      path: latest.path,
      leaf: latest.path,
      confidence: 1,
      altJson: JSON.stringify({ source: "override", override_at: latest.created_at, model: model ? modelAlt(model) : null }),
    };
  }
  if (!model) return null;
  return { path: model.path, leaf: model.leaf, confidence: round(model.confidence), altJson: JSON.stringify({ source: "jev", ...modelAlt(model) }) };
}

function modelAlt(m: Classification) {
  return {
    levels: m.levels.map((l) => ({ id: l.id, p: round(l.p) })),
    stopped_early: m.stoppedEarly,
    best_leaf: m.leaf,
    alternatives: m.beam.slice(1, 3),
    beam: m.beam,
    greedy_leaf: m.greedyLeaf,
  };
}
