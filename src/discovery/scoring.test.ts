import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  recencyScore,
  nicheScore,
  mmrRerank,
  epsilonGreedy,
  profileSimilarity,
  rescaleSimilarity,
  passesRelevanceGate,
  MIN_RELEVANCE_SIMILARITY,
  SIMILARITY_BASELINE,
  SIMILARITY_CEILING,
  WEIGHTS,
  resolveCandidateVectors,
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
      similarity: 0, similarityRaw: 0, recency: 0, niche: 0, channel: 0, total,
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

// --- profileSimilarity / relevance gate ---

describe("profileSimilarity", () => {
  const topics = [
    { topicId: 1, weight: 1.0, vector: unitVec(0) },
    { topicId: 2, weight: 0.2, vector: unitVec(1) },
  ];

  it("matches a multi-modal profile on its nearest topic, not the average", () => {
    // Exactly on topic 1 → full cosine. The centroid of topics 1+2 would give
    // only ~0.98 here, but a vector on topic 2 would drop to ~0.2 against it.
    expect(profileSimilarity(unitVec(0), topics)).toBeCloseTo(1, 5);
    expect(profileSimilarity(unitVec(1), topics)).toBeGreaterThan(0.75);
  });

  it("scales by topic weight between 0.75× and 1×", () => {
    // topic 2 has weight 0.2 → multiplier 0.75 + 0.25·0.2 = 0.8
    expect(profileSimilarity(unitVec(1), topics)).toBeCloseTo(0.8, 5);
  });

  it("is 0 for a vector orthogonal to every topic", () => {
    expect(profileSimilarity(unitVec(5), topics)).toBe(0);
  });

  it("is 0 for an empty profile", () => {
    expect(profileSimilarity(unitVec(0), [])).toBe(0);
  });
});

describe("rescaleSimilarity", () => {
  it("maps baseline → 0 and ceiling → 1, clamped", () => {
    expect(rescaleSimilarity(SIMILARITY_BASELINE)).toBeCloseTo(0, 5);
    expect(rescaleSimilarity(SIMILARITY_CEILING)).toBeCloseTo(1, 5);
    expect(rescaleSimilarity(0)).toBe(0);
    expect(rescaleSimilarity(0.99)).toBe(1);
  });
});

describe("passesRelevanceGate", () => {
  it("passes at or above the threshold and blocks below it", () => {
    expect(passesRelevanceGate({ similarityRaw: MIN_RELEVANCE_SIMILARITY })).toBe(true);
    expect(passesRelevanceGate({ similarityRaw: MIN_RELEVANCE_SIMILARITY + 0.1 })).toBe(true);
    expect(passesRelevanceGate({ similarityRaw: MIN_RELEVANCE_SIMILARITY - 0.001 })).toBe(false);
  });

  it("blocks NaN (e.g. a zero-length vector)", () => {
    expect(passesRelevanceGate({ similarityRaw: Number.NaN })).toBe(false);
  });
});

// --- resolveCandidateVectors (batched title embeddings) ---

describe("resolveCandidateVectors", () => {
  /** Fake embedder: records each call and encodes the title's number in dim 0. */
  function fakeEmbed(failOnCall?: number) {
    const calls: string[][] = [];
    const embed = async (texts: string[]) => {
      calls.push(texts);
      if (calls.length === failOnCall) throw new Error("API down");
      return texts.map((t) => Float32Array.of(Number(t.replace("Video ", ""))));
    };
    return { calls, embed };
  }

  it("embeds a 200-candidate run in 2 API calls, mapping vectors back by position", async () => {
    const candidates = Array.from({ length: 200 }, (_, i) => makeCandidate(i, 0));
    const { calls, embed } = fakeEmbed();
    const vectors = await resolveCandidateVectors(candidates, embed);
    expect(calls.map((c) => c.length)).toEqual([100, 100]);
    expect(vectors.map((v) => v![0])).toEqual(candidates.map((c) => c.id));
  });

  it("skips titleless candidates without sending them", async () => {
    const candidates = [makeCandidate(1, 0), { ...makeCandidate(2, 0), title: null }, { ...makeCandidate(3, 0), title: " x " }];
    const { calls, embed } = fakeEmbed();
    const vectors = await resolveCandidateVectors(candidates, embed);
    expect(calls).toEqual([["Video 1"]]);
    expect(vectors[0]![0]).toBe(1);
    expect(vectors[1]).toBeNull();
    expect(vectors[2]).toBeNull();
  });

  it("leaves only the failed batch unembedded", async () => {
    const candidates = Array.from({ length: 150 }, (_, i) => makeCandidate(i, 0));
    const { embed } = fakeEmbed(1);
    const vectors = await resolveCandidateVectors(candidates, embed);
    expect(vectors.slice(0, 100).every((v) => v === null)).toBe(true);
    expect(vectors.slice(100).map((v) => v![0])).toEqual(candidates.slice(100).map((c) => c.id));
  });
});

describe("WEIGHTS", () => {
  it("sums to 1 and has no topicOverlap component", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    expect("topicOverlap" in WEIGHTS).toBe(false);
  });
});
