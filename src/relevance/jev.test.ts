import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JevBudgetExceeded,
  JevClient,
  JevOfflineMiss,
  OPENROUTER_ALPHA,
  buildBody,
  cacheKey,
  canonicalJson,
  choice,
  costOf,
  expectedScore,
  noul,
  score,
} from "./jev.ts";
import { contentBattery, featureNames, gateOnly, profileBattery } from "./questions.ts";
import type { RelItem } from "./labels.ts";

const dirs: string[] = [];
function tmpCache(): string {
  const d = mkdtempSync(join(tmpdir(), "jev-test-"));
  dirs.push(d);
  return d;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("wire format", () => {
  it("builds noul / choice / score questions like the reference client", () => {
    expect(noul("Is it?")).toEqual({ type: "noul", instructions: "Is it?" });
    expect(noul("Is it?", { true: "yes" })).toEqual({ type: "noul", instructions: "Is it?", criteria: { true: "yes", false: "" } });
    expect(choice("Which?", { a: "A", b: "B" })).toEqual({ type: "choice", instructions: "Which?", criteria: { a: "A", b: "B" } });
    expect(score("How?", ["low", "high"])).toEqual({ type: "score", instructions: "How?", criteria: ["low", "high"] });
    expect(() => choice("Which?", { a: "A" })).toThrow();
  });

  it("body is {model, state, questions} and the cache key ignores key order", () => {
    const p1 = { state: { b: 1, a: 2 }, questions: { q: noul("x") } };
    const p2 = { state: { a: 2, b: 1 }, questions: { q: noul("x") } };
    expect(Object.keys(buildBody(p1, "m"))).toEqual(["model", "state", "questions"]);
    expect(cacheKey(p1, "m")).toBe(cacheKey(p2, "m"));
    expect(cacheKey(p1, "m")).not.toBe(cacheKey(p1, "other-model"));
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: 1 })).toBe('{"a":1,"b":[{"c":2,"d":1}]}');
  });

  it("reads cost from usage and expected score from probabilities", () => {
    expect(costOf({ usage: { cost: 0.001 } })).toBe(0.001);
    expect(costOf({ usage: { input_tokens: 1_000_000 } })).toBeCloseTo(0.042);
    expect(expectedScore({ probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 } })).toBeCloseTo(1.3);
    expect(expectedScore({ score: 1.5 })).toBe(1.5);
  });
});

describe("JevClient", () => {
  const payload = { state: { video: { title: "t" } }, questions: { relevant: noul("?") } };

  it("posts to the alpha endpoint, caches, and meters cost", async () => {
    let calls = 0;
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls++;
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: "typesafe/jev-x", answers: { relevant: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 100, cost: 0.0002 } }));
    }) as unknown as typeof fetch;
    const c = new JevClient({ apiKey: "k", cacheDir: tmpCache(), fetchImpl, budgetUsd: 1 });
    const r1 = await c.ask(payload);
    const r2 = await c.ask(payload);
    expect(seenUrl).toBe(OPENROUTER_ALPHA);
    expect(seenBody.model).toBe("~typesafe/jev-latest");
    expect(r1.answers.relevant.noul).toBe(0.8);
    expect(r1.source).toBe("live");
    expect(r2.source).toBe("cache");
    expect(calls).toBe(1);
    expect(c.totalCost).toBeCloseTo(0.0002);
  });

  it("offline mode replays cache and throws on a miss", async () => {
    const c = new JevClient({ apiKey: null, cacheDir: tmpCache() });
    expect(c.mode).toBe("offline");
    await expect(c.ask(payload)).rejects.toBeInstanceOf(JevOfflineMiss);
  });

  it("refuses live calls past the budget cap", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ answers: {}, usage: { cost: 0.01 } }))) as unknown as typeof fetch;
    const c = new JevClient({ apiKey: "k", cacheDir: tmpCache(), fetchImpl, budgetUsd: 0.015 });
    await c.ask(payload);
    await expect(c.ask({ ...payload, state: { other: 1 } })).rejects.toBeInstanceOf(JevBudgetExceeded);
  });

  it("does not retry 4xx and reports per-item errors from askMany", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("bad", { status: 400 });
    }) as unknown as typeof fetch;
    const c = new JevClient({ apiKey: "k", cacheDir: tmpCache(), fetchImpl, retries: 2 });
    const out = await c.askMany([payload]);
    expect(out[0]).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });
});

describe("question batteries", () => {
  const video: RelItem = {
    key: "video:x", type: "video", label: 1, labelKind: "chosen", reason: null, title: "T",
    content: { title: "T", channel: "C", tags: [], summary: "S" }, baselines: {}, existingCategory: null, decidedAt: null,
  };
  it("keeps the profile out of the content battery (cacheable across profile changes)", () => {
    const c = contentBattery(video, { a: "A", b: "B" });
    expect(JSON.stringify(c.state)).not.toContain("user_interest_profile");
    expect(c.questions.category.type).toBe("choice");
    const p = profileBattery(video, "PROFILE")!;
    expect((p.state as Record<string, unknown>).user_interest_profile).toBe("PROFILE");
    expect(Object.keys(gateOnly(video, "PROFILE")!.questions)).toEqual(["relevant"]);
  });
  it("feature names cover every noul the batteries ask", () => {
    const names = featureNames("video");
    const asked = [
      ...Object.keys(contentBattery(video, { a: "A", b: "B" }).questions).filter((k) => k !== "category"),
      ...Object.keys(profileBattery(video, "P")!.questions),
    ];
    expect(new Set(names)).toEqual(new Set(asked));
  });
});
