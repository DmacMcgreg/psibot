import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  recencyScore,
  nicheScore,
  mmrRerank,
  epsilonGreedy,
  type ScoredCandidate,
} from "./scoring.ts";

// Helpers --------------------------------------------------------------

function makeCandidate(id: number, total: number): ScoredCandidate {
  return {
    id,
    video_id: `vid${id}`,
    channel_id: null,
    title: `Video ${id}`,
    published_at: null,
    source: "search",
    source_detail: null,
    view_count: null,
    duration_seconds: null,
    score: total,
    score_breakdown_json: null,
    status: "candidate",
    reason: null,
    discovered_at: "",
    processed_at: null,
    surfaced_at: null,
    breakdown: {
      similarity: 0, topicOverlap: 0, recency: 0, niche: 0, channel: 0, total,
    },
  };
}

/** A unit vector pointing along a single dimension, for deterministic similarity. */
function unitVec(dim: number, size = 8): Float32Array {
  const v = new Float32Array(size);
  v[dim] = 1.0;
  return v;
}

// --- cosineSimilarity ---

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    const v = unitVec(0);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity(unitVec(0), unitVec(1))).toBeCloseTo(0, 5);
  });

  it("is invariant to scaling", () => {
    const a = unitVec(0);
    const b = new Float32Array(8);
    b[0] = 5; // same direction, scaled
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("returns 0 for a zero vector (no division by zero)", () => {
    expect(cosineSimilarity(new Float32Array(8), unitVec(0))).toBe(0);
  });
});

// --- recencyScore / nicheScore ---

describe("recencyScore", () => {
  it("decays exponentially with age", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 1000).toISOString();
    const week = new Date(now.getTime() - 14 * 86400_000).toISOString();
    expect(recencyScore(recent)).toBeGreaterThan(recencyScore(week));
    // 14-day-old ~ e^-1 ≈ 0.368
    expect(recencyScore(week)).toBeCloseTo(Math.exp(-1), 2);
  });

  it("returns 0 for missing/invalid dates", () => {
    expect(recencyScore(null)).toBe(0);
    expect(recencyScore("not-a-date")).toBe(0);
  });

  it("clamps future dates to 1", () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    expect(recencyScore(future)).toBe(1);
  });
});

describe("nicheScore", () => {
  it("gives higher scores to lower view counts", () => {
    expect(nicheScore(100)).toBeGreaterThan(nicheScore(1_000_000));
  });

  it("returns a neutral 0.5 for unknown view counts", () => {
    expect(nicheScore(null)).toBe(0.5);
  });

  it("is always in (0, 1]", () => {
    expect(nicheScore(0)).toBeLessThanOrEqual(1);
    expect(nicheScore(10 ** 9)).toBeGreaterThan(0);
  });
});

// --- MMR ---

describe("mmrRerank", () => {
  it("returns all candidates when k >= length, preserving order", () => {
    const cs = [makeCandidate(1, 0.9), makeCandidate(2, 0.5)];
    const out = mmrRerank(cs, [unitVec(0), unitVec(1)], 5);
    expect(out.map((c) => c.id)).toEqual([1, 2]);
  });

  it("picks the most relevant first, then diversifies", () => {
    // Three candidates: A is most relevant (0.9), B and C are identical to A.
    // With lambda=0.7, after picking A the most-similar (B/C) get penalized.
    const a = makeCandidate(1, 0.9);
    const b = makeCandidate(2, 0.8);
    const c = makeCandidate(3, 0.8);
    // B identical to A (dim 0); C orthogonal (dim 1).
    const out = mmrRerank([a, b, c], [unitVec(0), unitVec(0), unitVec(1)], 2);
    expect(out[0].id).toBe(1); // top relevance always first
    expect(out[1].id).toBe(3); // C chosen over B because it's more diverse
  });

  it("does not penalize candidates lacking a vector", () => {
    const a = makeCandidate(1, 0.9);
    const b = makeCandidate(2, 0.8);
    // b has no vector — max similarity treated as 0, so it's not penalized.
    const out = mmrRerank([a, b], [unitVec(0), null], 2);
    expect(out.map((c) => c.id)).toEqual([1, 2]);
  });
});

// --- epsilonGreedy ---

describe("epsilonGreedy", () => {
  it("always keeps the top exploit pick", () => {
    const selected = [makeCandidate(1, 0.99), makeCandidate(2, 0.5), makeCandidate(3, 0.4)];
    const pool = selected;
    const out = epsilonGreedy(selected, pool, 3, 1.0, () => 0.0); // always explore
    expect(out[0].id).toBe(1); // top slot never swapped
  });

  it("does not explore when epsilon is 0", () => {
    const selected = [makeCandidate(1, 0.99), makeCandidate(2, 0.5)];
    const pool = [makeCandidate(1, 0.99), makeCandidate(2, 0.5), makeCandidate(3, 0.3)];
    const out = epsilonGreedy(selected, pool, 2, 0.0, () => 0.99);
    expect(out.map((c) => c.id)).toEqual([1, 2]); // unchanged
  });

  it("can swap in an unselected candidate when exploring", () => {
    const selected = [makeCandidate(1, 0.99), makeCandidate(2, 0.5)];
    const pool = [makeCandidate(1, 0.99), makeCandidate(2, 0.5), makeCandidate(3, 0.3)];
    const out = epsilonGreedy(selected, pool, 2, 1.0, () => 0.5);
    expect(out[0].id).toBe(1); // exploit slot kept
    expect(out[1].id).toBe(3); // exploration pulled in unselected candidate 3
  });

  it("returns fewer items if pool is smaller than slots", () => {
    const selected = [makeCandidate(1, 0.9)];
    const out = epsilonGreedy(selected, selected, 3);
    expect(out.length).toBe(1);
  });
});
