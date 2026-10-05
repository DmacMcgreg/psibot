import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildQuestions, DEFAULT_THRESHOLDS, type RubricExample } from "../relevance/discover-triage.ts";
import { JevBudgetExceeded, type JevResult, type Payload } from "../relevance/jev.ts";
import {
  candidateFacts,
  recordGateSpend,
  runJevGate,
  spentToday,
  vaultAsker,
  type GateCandidate,
  type GateContext,
  type JevAsker,
} from "./jev-gate.ts";

const example = (atlasId: number, verdict: RubricExample["verdict"], title: string, by: string): RubricExample => ({
  atlasId, title, source: "youtube_discovery", topicGroup: null, by, tags: [], durationMin: 20, hasTranscript: true,
  excerpt: "", verdict, reasons: verdict === "interested" ? ["Exactly my interest"] : ["Scripted fiction"], note: null,
});

function ctx(): GateContext {
  const rubric = [example(1, "interested", "Claude Code agent harness deep dive", "AI Engineer"), example(2, "not_interested", "Billionaire revenge story", "Drama Now")];
  return {
    qs: buildQuestions(rubric),
    chosenByChannel: new Map([["AI Engineer", 4], ["CTV News", 1]]),
    rejectedChannels: new Set(["CTV News"]),
  };
}

const cand = (id: number, title: string, channelTitle: string | null = "Unknown"): GateCandidate => ({
  id, videoId: `v${id}`, title, channelTitle, durationSeconds: 1234, description: "## Heading\n**Bold** description text", tags: ["ai", "x".repeat(60)],
});

const answer = (pNot: number, pInt: number, pProt = 0): JevResult => ({
  answers: {
    decision: { choice: pNot > pInt ? "not_interested" : "interested", probabilities: { not_interested: pNot, interested: pInt, unsure: Math.max(0, 1 - pNot - pInt) } },
    protected_interest: { noul: pProt },
  },
  source: "live", cost: 0.0005, inputTokens: 100, model: "test",
});

/** Fake asker: answers by title keyword, records what it was asked. */
function fakeAsker(byTitle: (title: string) => JevResult | Error): JevAsker & { asked: Payload[] } {
  const asked: Payload[] = [];
  return {
    model: "test", kind: "in-process", asked,
    async askMany(payloads) {
      asked.push(...payloads);
      const answers = payloads.map((p) => byTitle(((p.state as Record<string, unknown>).item as { title: string }).title));
      return { answers, cost: answers.filter((a) => !(a instanceof Error)).length * 0.0005, liveCalls: payloads.length };
    },
  };
}

describe("candidateFacts", () => {
  test("maps a candidate to triage item facts without a summary", () => {
    const f = candidateFacts(cand(7, "Title", "AI Engineer"), new Map([["AI Engineer", 4]]));
    expect(f).toMatchObject({ atlasId: -7, source: "youtube_discovery", by: "AI Engineer", durationMin: 20.6, chosenFromChannel: 4, hasTranscript: null });
    expect(f.tags).toEqual(["ai"]); // over-long tag dropped
    expect(f.excerpt).toBe("Bold description text");
  });
});

describe("runJevGate", () => {
  test("maps probabilities to hide / pick / unsure with the triage thresholds", async () => {
    const asker = fakeAsker((t) =>
      t.startsWith("drama") ? answer(0.95, 0.02) : t.startsWith("agents") ? answer(0.05, 0.9) : answer(0.4, 0.4),
    );
    const run = await runJevGate(ctx(), [cand(1, "drama one"), cand(2, "agents two"), cand(3, "meh three")], asker);
    expect(run.results.map((r) => [r.candidateId, r.decision])).toEqual([[1, "hide"], [2, "pick"], [3, "unsure"]]);
    expect(run.cost).toBeCloseTo(0.0015);
    expect(run.results[0].reason).toMatch(/^Not interested 95%/);
    // The payload is the triage rubric plus this item.
    const state = asker.asked[0].state as Record<string, unknown>;
    expect(state).toHaveProperty("david_rated_examples");
    expect((state.item as Record<string, unknown>).source).toMatch(/discovery crawler/);
  });

  test("a channel David chose from is never hidden, unless he rejected that channel", async () => {
    const asker = fakeAsker(() => answer(0.97, 0.01));
    const run = await runJevGate(ctx(), [cand(1, "x", "AI Engineer"), cand(2, "y", "CTV News")], asker);
    expect(run.results.map((r) => r.decision)).toEqual(["unsure", "hide"]);
  });

  test("the protected-interest guard keeps genuine spiritual/agent content from being hidden", async () => {
    const run = await runJevGate(ctx(), [cand(1, "gnostic lecture")], fakeAsker(() => answer(0.9, 0.05, 0.8)));
    expect(run.results[0].decision).toBe("unsure");
  });

  test("a lower pick threshold is honoured", async () => {
    const run = await runJevGate(ctx(), [cand(1, "x")], fakeAsker(() => answer(0.1, 0.72)), { ...DEFAULT_THRESHOLDS, pick: 0.7 });
    expect(run.results[0].decision).toBe("pick");
  });

  test("errors and budget stops leave candidates unanswered", async () => {
    const asker = fakeAsker((t) => (t === "a" ? new Error("HTTP 500") : t === "b" ? new JevBudgetExceeded("cap") : answer(0.1, 0.9)));
    const run = await runJevGate(ctx(), [cand(1, "a"), cand(2, "b"), cand(3, "c")], asker);
    expect(run.results.map((r) => r.candidateId)).toEqual([3]);
    expect(run.errors).toEqual([{ candidateId: 1, error: "HTTP 500" }]);
    expect(run.budgetHit).toBe(true);
  });

  test("an empty pool asks nothing", async () => {
    const asker = fakeAsker(() => answer(0, 1));
    expect((await runJevGate(ctx(), [], asker)).results).toEqual([]);
    expect(asker.asked).toHaveLength(0);
  });
});

describe("vaultAsker subprocess plumbing", () => {
  test("runs the child through the vault wrapper and maps its errors back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-gate-test-"));
    // Stand-in for `vault run --env … -- cmd…`: drop everything up to "--", run the rest without a key.
    const fakeVault = join(dir, "vault");
    writeFileSync(fakeVault, `#!/bin/bash\nwhile [ "$1" != "--" ]; do shift; done; shift\nunset OPENROUTER_API_KEY\nexec "$@"\n`);
    chmodSync(fakeVault, 0o755);
    const asker = vaultAsker({ item: "Test Item", budgetUsd: 0.01, vaultBin: fakeVault, timeoutMs: 30_000 });
    const payload = { state: { nonce: `${Date.now()}-${Math.random()}` }, questions: {} } as Payload;
    const out = await asker.askMany([payload, payload]);
    // No key and nothing cached: the child answers each item with an offline-miss error.
    expect(out.answers).toHaveLength(2);
    expect(out.answers.every((a) => a instanceof Error && /OPENROUTER_API_KEY/.test(a.message))).toBe(true);
    expect(out.cost).toBe(0);
  }, 30_000);
});

describe("spend ledger", () => {
  test("spentToday sums today's entries only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "jev-ledger-")), "spend.jsonl");
    recordGateSpend({ runId: 1, items: 10, liveCalls: 10, cost: 0.005, kind: "vault" }, path);
    recordGateSpend({ runId: 2, items: 10, liveCalls: 8, cost: 0.004, kind: "vault" }, path);
    writeFileSync(path, `${JSON.stringify({ ts: "2020-01-01T00:00:00Z", cost: 5 })}\n{torn`, { flag: "a" });
    expect(spentToday(path)).toBeCloseTo(0.009);
    expect(spentToday(join(path, "missing"))).toBe(0);
  });
});
