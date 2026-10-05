import { describe, expect, it } from "bun:test";
import { bm25, lexicalRoute, normalizeQuery, stem, tokenize } from "./search.ts";

describe("lean search helpers", () => {
  it("normalises queries so case and spacing variants share a cache key", () => {
    expect(normalizeQuery("  Claude Code   Memory Plugins? ")).toBe("claude code memory plugins");
    expect(normalizeQuery("Iran oil shock")).toBe(normalizeQuery("iran  OIL shock."));
  });

  it("folds simple plurals", () => {
    expect(stem("llms")).toBe("llm");
    expect(stem("macs")).toBe("mac");
    expect(stem("class")).toBe("class");
    expect(stem("status")).toBe("status");
    expect(stem("gas")).toBe("gas");
    expect(tokenize("Local LLMs on Macs")).toEqual(["local", "llm", "mac"]);
    expect(bm25("mac", ["runs on macs", "windows only"])[0]).toBeGreaterThan(0);
  });

  it("routes lexically to the most specific node that holds enough of the vote", () => {
    const hits = [
      ...Array.from({ length: 6 }, () => ({ path: "ai-models/local-inference", bm: 5 })),
      ...Array.from({ length: 3 }, () => ({ path: "ai-models/open-weights", bm: 3 })),
      { path: "software/dev-tools", bm: 1 },
    ];
    expect(lexicalRoute(hits)?.map((r) => r.path)).toEqual(["ai-models/local-inference"]);
  });

  it("falls back (null) when lexical evidence is thin or split", () => {
    expect(lexicalRoute([{ path: "a/b", bm: 3 }, { path: "a/b", bm: 2 }])).toBeNull();
    const split = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((p) => ({ path: p, bm: 1 }));
    expect(lexicalRoute(split)).toBeNull();
  });
});
