import { describe, it, expect } from "bun:test";
import { embedText, embedBatch, EMBEDDING_DIMENSIONS } from "./embeddings.ts";

describe("embedText", () => {
  it("returns a 768-dim Float32Array for a single text", async () => {
    const result = await embedText("quantum computing breakthroughs");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBEDDING_DIMENSIONS);
    // Values should be normalized (not all zero)
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeGreaterThan(0.5);
  }, 15_000);
});

describe("embedBatch", () => {
  it("returns empty array for empty input", async () => {
    const results = await embedBatch([]);
    expect(results).toEqual([]);
  });

  it("embeds multiple texts in a single batch", async () => {
    const texts = [
      "machine learning fundamentals",
      "cooking Italian pasta recipes",
      "quantum physics experiments",
    ];
    const results = await embedBatch(texts);
    expect(results.length).toBe(3);
    for (const emb of results) {
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb.length).toBe(EMBEDDING_DIMENSIONS);
    }
  }, 15_000);

  it("produces different embeddings for different texts", async () => {
    const [a, b] = await embedBatch(["cats and dogs", "quantum physics"]);
    // Compute cosine similarity - should be < 1 for different topics
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const cosineSim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    expect(cosineSim).toBeLessThan(0.95); // Different topics should not be near-identical
    expect(cosineSim).toBeGreaterThan(-1); // But still valid
  }, 15_000);
});
