import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  beamSearch,
  buildTaxonomy,
  classifyFromProbs,
  edgeProbsFromAnswers,
  greedySearch,
  inSubtree,
  internalNodes,
  leaves,
  lineage,
  loadTaxonomy,
  optionKey,
  questionKey,
  resolveCategory,
  routeByConfidence,
  treeQuestions,
  walk,
  type EdgeProbs,
  type TaxNode,
} from "./taxonomy.ts";
import { categorize, loadOverrides, recordOverride } from "./categorize.ts";
import { ensureCategoryTables, researchLead, type LibItem } from "./library.ts";
import { bm25, subtreesFromBeam, tokenize } from "./search.ts";
import { JevClient } from "./jev.ts";

const leaf = (id: string): TaxNode => ({ id, label: id, description: `about ${id}`, children: [] });
const node = (id: string, children: TaxNode[]): TaxNode => ({ id, label: id, description: `about ${id}`, children });

// a ─ a/x ─ a/x/1, a/x/2
//   └ a/y
// b ─ b/p, b/q
// c ─ c/only            (single-child edge: a non-decision)
const TREE = [
  node("a", [node("a/x", [leaf("a/x/1"), leaf("a/x/2")]), leaf("a/y")]),
  node("b", [leaf("b/p"), leaf("b/q")]),
  node("c", [leaf("c/only")]),
];
const tax = buildTaxonomy(TREE);

function probs(entries: Record<string, Record<string, number>>): EdgeProbs {
  const m: EdgeProbs = new Map();
  for (const [k, v] of Object.entries(entries)) m.set(k, new Map(Object.entries(v)));
  m.set("c", new Map([["c/only", 1]]));
  return m;
}

describe("tree", () => {
  it("indexes nodes, parents, leaves and internal nodes", () => {
    expect(tax.byId.size).toBe(10);
    expect(tax.parentOf.get("a/x/1")).toBe("a/x");
    expect(tax.parentOf.get("a")).toBeNull();
    expect(leaves(tax).sort()).toEqual(["a/x/1", "a/x/2", "a/y", "b/p", "b/q", "c/only"]);
    expect(internalNodes(tax)).toEqual(["", "a", "a/x", "b", "c"]);
    expect([...walk(tax)].map((w) => `${w.node.id}@${w.depth}`).slice(0, 5)).toEqual(["a@1", "a/x@2", "a/x/1@3", "a/x/2@3", "a/y@2"]);
  });

  it("rejects non-prefix-closed or duplicate ids", () => {
    expect(() => buildTaxonomy([node("a", [leaf("b/x"), leaf("a/y")])])).toThrow();
    expect(() => buildTaxonomy([leaf("a"), leaf("a")])).toThrow();
    expect(() => buildTaxonomy([leaf("a/b")])).toThrow();
  });

  it("lineage and subtree membership", () => {
    expect(lineage("a/x/1")).toEqual(["a", "a/x", "a/x/1"]);
    expect(inSubtree("a/x/1", "a")).toBe(true);
    expect(inSubtree("ab/x", "a")).toBe(false);
    expect(inSubtree("a", "a")).toBe(true);
  });

  it("version changes with content", () => {
    const t2 = buildTaxonomy([...TREE.slice(0, 2), node("c", [leaf("c/only"), leaf("c/new")])]);
    expect(t2.version).not.toBe(tax.version);
    expect(buildTaxonomy(TREE).version).toBe(tax.version);
  });

  // data/ is gitignored wholesale: the shipped-artifact assertion runs only where
  // the local data tree exists; a clean checkout skips it (no ENOENT fail).
  it.skipIf(!existsSync("data/relevance/taxonomy.json"))(
    "the shipped taxonomy is well-formed and sized as planned",
    () => {
      const real = loadTaxonomy("data/relevance/taxonomy.json");
    expect(real.roots.length).toBeGreaterThanOrEqual(8);
    expect(real.roots.length).toBeLessThanOrEqual(14);
    for (const r of real.roots) {
      expect(r.children.length).toBeGreaterThanOrEqual(3);
      expect(r.children.length).toBeLessThanOrEqual(10);
      expect(r.children.some((c) => c.id === `${r.id}/other`)).toBe(true);
    }
    // One Choice per internal node with ≥ 2 children, ≤ 255 options each.
    const qs = treeQuestions(real);
    expect(Object.keys(qs).length).toBe(internalNodes(real).length);
  });
});

describe("questions + answers", () => {
  it("builds one Choice per decision node with local-slug options", () => {
    const qs = treeQuestions(tax);
    expect(Object.keys(qs).sort()).toEqual(["n_a", "n_a_x", "n_b", "root"]); // c has one child → no question
    expect(Object.keys((qs.n_a_x as { criteria: Record<string, string> }).criteria)).toEqual(["1", "2"]);
    expect(questionKey("a/x")).toBe("n_a_x");
    expect(optionKey("a/x/2")).toBe("2");
  });

  it("maps probabilities back to node ids and renormalises", () => {
    const p = edgeProbsFromAnswers(tax, {
      root: { choice: "a", probabilities: { a: 0.6, b: 0.3, c: 0.1 } },
      n_a: { choice: "x", probabilities: { x: 2, y: 2 } },
      n_a_x: { choice: "1" }, // no distribution → the pick is certain
    });
    expect(p.get("")!.get("a")).toBeCloseTo(0.6);
    expect(p.get("a")!.get("a/x")).toBeCloseTo(0.5);
    expect(p.get("a/x")!.get("a/x/1")).toBe(1);
    expect(p.get("c")!.get("c/only")).toBe(1);
    expect(p.get("b")!.get("b/p")).toBe(0);
  });
});

describe("greedy vs beam", () => {
  // Greedy takes a (0.55) then gets stuck on a flat split; beam finds b/p.
  const P = probs({
    "": { a: 0.55, b: 0.45, c: 0 },
    a: { "a/x": 0.5, "a/y": 0.5 },
    "a/x": { "a/x/1": 0.5, "a/x/2": 0.5 },
    b: { "b/p": 0.98, "b/q": 0.02 },
  });

  it("greedy follows the local maximum", () => {
    const g = greedySearch(tax, P);
    expect(g.path[0]).toBe("a");
    expect(g.path.length).toBeGreaterThanOrEqual(2);
  });

  it("beam (width 3) recovers the leaf greedy misses", () => {
    const beam = beamSearch(tax, P, 3);
    expect(beam[0].path).toEqual(["b", "b/p"]);
    expect(beam[0].score).toBeCloseTo(Math.sqrt(0.45 * 0.98));
    expect(beam.length).toBe(3);
  });

  it("single-child edges are non-decisions", () => {
    const beam = beamSearch(tax, probs({ "": { a: 0, b: 0, c: 1 }, a: {}, "a/x": {}, b: {} }), 3);
    expect(beam[0].path).toEqual(["c", "c/only"]);
    expect(beam[0].decisions).toBe(1);
    expect(beam[0].score).toBe(1);
  });

  it("classifyFromProbs reports disagreement and alternatives", () => {
    const c = classifyFromProbs(tax, P, 0.5);
    expect(c.leaf).toBe("b/p");
    expect(c.greedyLeaf.startsWith("a/")).toBe(true);
    expect(c.beam.length).toBe(3);
  });
});

describe("confidence routing (stop at parent)", () => {
  const cand = { path: ["a", "a/x", "a/x/2"], edges: [0.9, 0.8, 0.4], product: 0.288, decisions: 3, score: 0.66 };

  it("stops at the parent when the child edge is below threshold", () => {
    const r = routeByConfidence(cand, 0.5);
    expect(r.nodeId).toBe("a/x");
    expect(r.stoppedEarly).toBe(true);
    expect(r.confidence).toBeCloseTo(0.72);
    expect(r.levels.map((l) => l.id)).toEqual(["a", "a/x"]);
  });

  it("keeps the full path when every edge clears the threshold", () => {
    expect(routeByConfidence(cand, 0.3).nodeId).toBe("a/x/2");
  });

  it("always keeps the top level", () => {
    const r = routeByConfidence({ ...cand, edges: [0.2, 0.9, 0.9] }, 0.5);
    expect(r.nodeId).toBe("a/x/2");
    expect(r.confidence).toBeCloseTo(0.162);
  });
});

describe("override precedence", () => {
  const P = probs({ "": { a: 0, b: 1, c: 0 }, a: {}, "a/x": {}, b: { "b/p": 0.9, "b/q": 0.1 } });
  const model = classifyFromProbs(tax, P);

  it("the model result is stored when there is no override", () => {
    const s = resolveCategory(model, [])!;
    expect(s.path).toBe("b/p");
    expect(JSON.parse(s.altJson!).source).toBe("jev");
  });

  it("the latest override wins and keeps the model opinion", () => {
    const s = resolveCategory(model, [
      { path: "a/y", created_at: "2026-09-26T10:00:00Z" },
      { path: "a/x/1", created_at: "2026-09-25T10:00:00Z" },
    ])!;
    expect(s.path).toBe("a/y");
    expect(s.confidence).toBe(1);
    const alt = JSON.parse(s.altJson!);
    expect(alt.source).toBe("override");
    expect(alt.model.best_leaf).toBe("b/p");
  });

  it("categorize never overwrites an override (DB round trip, cached Jev)", async () => {
    const db = new Database(":memory:");
    ensureCategoryTables(db);
    const items: LibItem[] = [
      { key: "video:v1", kind: "video", title: "t1", url: null, content: { title: "t1" }, text: "t1" },
      { key: "video:v2", kind: "video", title: "t2", url: null, content: { title: "t2" }, text: "t2" },
    ];
    // Fake transport: every item answers root=b, b=p.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ answers: { root: { choice: "b", probabilities: { a: 0, b: 1, c: 0 } }, n_b: { choice: "p", probabilities: { p: 0.9, q: 0.1 } } }, usage: { cost: 0.0001 } }));
    }) as unknown as typeof fetch;
    const dir = `${require("node:os").tmpdir()}/tax-test-${Date.now()}`;
    const client = new JevClient({ apiKey: "k", cacheDir: dir, fetchImpl, budgetUsd: 1 });
    recordOverride(db, "video:v2", "a/y");
    const res = await categorize(db, client, tax, items);
    expect(res.written).toBe(2);
    const rows = db.query<{ item_key: string; path: string }, []>(`SELECT item_key, path FROM item_categories ORDER BY item_key`).all();
    expect(rows).toEqual([{ item_key: "video:v1", path: "b/p" }, { item_key: "video:v2", path: "a/y" }]);
    // Incremental: a second run skips both (current version).
    const again = await categorize(db, client, tax, items);
    expect(again.skippedCurrent).toBe(2);
    expect(loadOverrides(db).get("video:v2")![0].path).toBe("a/y");
    // --force re-classifies but the override still wins.
    await categorize(db, client, tax, items, { force: true });
    expect(db.query<{ path: string }, []>(`SELECT path FROM item_categories WHERE item_key='video:v2'`).get()!.path).toBe("a/y");
    expect(calls).toBe(2); // identical payloads per item hit the cache on re-runs
    require("node:fs").rmSync(dir, { recursive: true, force: true });
  });
});

describe("search helpers", () => {
  it("tokenizes and ranks with BM25", () => {
    expect(tokenize("What is Claude-Code's MCP?")).toEqual(["claude-code", "mcp"]);
    const s = bm25("gnostic demiurge", ["the demiurge in gnostic texts", "react hooks", "gnostic gospel"]);
    expect(s[0]).toBeGreaterThan(s[2]);
    expect(s[1]).toBe(0);
  });

  it("routes a query to deduplicated subtrees", () => {
    const sub = subtreesFromBeam(tax, {
      root: { choice: "b", probabilities: { a: 0.4, b: 0.6, c: 0 } },
      n_b: { choice: "p", probabilities: { p: 0.55, q: 0.45 } },
      n_a: { choice: "y", probabilities: { x: 0.3, y: 0.7 } },
      n_a_x: { choice: "1", probabilities: { "1": 0.5, "2": 0.5 } },
    });
    // b/p is best, but b/q's weak edge routes to "b", which absorbs b/p at rank 1.
    expect(sub.map((s) => s.path)).toEqual(["b", "a/y"]);
    expect(sub.every((s, i) => sub.every((t, j) => i === j || !inSubtree(s.path, t.path)))).toBe(true);
  });

  it("research lead skips tool-call noise and uses the Summary section", () => {
    const body = "# T\n\n## Summary\n**🌐 Z.ai Built-in Tool: webReader**\n```json\n{}\n```\n*Executing on server...*\nA real summary about agent memory systems that is long enough to keep.\n\n## Key Findings\n- x";
    expect(researchLead(body)).toBe("A real summary about agent memory systems that is long enough to keep.");
  });
});
