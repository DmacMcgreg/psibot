import { describe, it, expect, afterAll } from "bun:test";
import { embedText, embedBatch, decodeVecBlob, EMBEDDING_DIMENSIONS } from "./embeddings.ts";

/**
 * Offline contract suite. The previous version of this file called the live
 * Gemini embedding API (15s timeouts, GEMINI_API_KEY from the developer's
 * gitignored .env), so a clean git-archive checkout failed 3 tests with
 * "No Gemini API key found". These tests stub globalThis.fetch instead and
 * pin the request/response contract of src/shared/embeddings.ts.
 *
 * Order matters: getGeminiApiKey caches the first resolved key module-wide,
 * so the no-key rejection runs before any fetch-stubbed call sets the cache.
 * No other test file in this repo calls embedText/embedBatch, so the cache
 * is owned by this file (bun runs all test files in one process).
 */

const TEST_KEY = "test-key-offline-suite";
let calls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
const realEnvKey = process.env.GEMINI_API_KEY;

/** Deterministic 768-dim vector; distinct per seed, non-zero norm. */
function fakeVector(seed: number, dims = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dims }, (_, i) => ((i + seed * 7) % 17) - 8);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- type guards for the captured request bodies (JSON.parse output) ---

interface EmbedContentBody {
  model: string;
  content: { parts: Array<{ text: string }> };
  outputDimensionality: number;
}

interface BatchBody {
  requests: Array<{ content: { parts: Array<{ text: string }> } }>;
}

// Body shape is produced by the module under test itself (JSON.parse of its
// request body) and only read back by these two named boundary assertions.
function readEmbedContentBody(body: unknown): EmbedContentBody {
  return body as EmbedContentBody;
}

function readBatchBody(body: unknown): BatchBody {
  return body as BatchBody;
}

function readRequestTexts(body: unknown): string[] {
  return readBatchBody(body).requests.map((r) => r.content?.parts?.[0]?.text ?? "");
}

/** Fetch input type without naming a DOM lib symbol (repo tsconfig has no DOM). */
type FetchInput = Parameters<typeof globalThis.fetch>[0];

/**
 * Single boundary cast: Bun's `typeof fetch` carries a `preconnect()` member
 * the stubs deliberately omit; the call signature is exact.
 */
function installFetch(stub: (input: FetchInput, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
}

// --- fetch stubs ---

/** Route embedContent vs batchEmbedContents, return canned payloads. */
async function stubbedFetch(input: FetchInput, init?: RequestInit): Promise<Response> {
  const url = String(input);
  const body: unknown = init?.body != null ? JSON.parse(String(init.body)) : null;
  calls.push({ url, body });

  if (url.includes(":embedContent")) {
    const text = readEmbedContentBody(body).content.parts[0]?.text ?? "";
    return jsonResponse({ embedding: { values: fakeVector(text.length) } });
  }
  if (url.includes(":batchEmbedContents")) {
    const texts = readRequestTexts(body);
    return jsonResponse({ embeddings: texts.map((_, i) => ({ values: fakeVector(i + 1) })) });
  }
  return jsonResponse({}, 500);
}

/** Fixed-response stub factory for error-path tests; restored right after each use. */
function respondWith(payload: unknown, status = 200): (input: FetchInput, init?: RequestInit) => Promise<Response> {
  return async () => jsonResponse(payload, status);
}

describe("key resolution", () => {
  it("rejects embedText with no key in env or config", async () => {
    delete process.env.GEMINI_API_KEY;
    process.env.HOME = "/tmp/tcc-embeddings-no-home";
    await expect(embedText("anything")).rejects.toThrow("No Gemini API key found");
  });

  it("resolves the key from GEMINI_API_KEY after being set", async () => {
    process.env.GEMINI_API_KEY = TEST_KEY;
    calls = [];
    installFetch(stubbedFetch);
    const result = await embedText("hello");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBEDDING_DIMENSIONS);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain(`key=${TEST_KEY}`);
  });
});

describe("embedText request contract", () => {
  it("POSTs the documented shape to gemini-embedding-001:embedContent", async () => {
    calls = [];
    const text = "quantum computing breakthroughs";
    const result = await embedText(text);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${TEST_KEY}`
    );
    expect(calls[0].body).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    });
    // Values are copied verbatim into a Float32Array of 768 dims.
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(EMBEDDING_DIMENSIONS);
    expect(result[0]).toBe(fakeVector(text.length)[0]);
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeGreaterThan(0.5);
  });

  it("throws Gemini embedding API error on a non-ok response", async () => {
    installFetch(respondWith({ error: "boom" }, 500));
    try {
      await expect(embedText("fails")).rejects.toThrow("Gemini embedding API error 500");
    } finally {
      installFetch(stubbedFetch);
    }
  });

  it("throws on an unexpected dimension count", async () => {
    installFetch(respondWith({ embedding: { values: [0.1, 0.2, 0.3] } }));
    try {
      await expect(embedText("short")).rejects.toThrow("Unexpected embedding dimensions: got 3, expected 768");
    } finally {
      installFetch(stubbedFetch);
    }
  });
});

describe("embedBatch", () => {
  it("returns [] for empty input without touching fetch", async () => {
    calls = [];
    const results = await embedBatch([]);
    expect(results).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("routes a single text through the embedContent endpoint", async () => {
    calls = [];
    const results = await embedBatch(["only one"]);
    expect(results.length).toBe(1);
    expect(results[0]).toBeInstanceOf(Float32Array);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain(":embedContent");
  });

  it("sends one batchEmbedContents request preserving input order", async () => {
    calls = [];
    const texts = ["machine learning fundamentals", "cooking Italian pasta recipes", "quantum physics experiments"];
    const results = await embedBatch(texts);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain(":batchEmbedContents");
    expect(readRequestTexts(calls[0].body)).toEqual(texts);
    // Each result maps 1:1 to its request index (distinct vectors per seed).
    expect(results.length).toBe(3);
    expect(results[0][0]).not.toBe(results[1][0]);
    for (const emb of results) {
      expect(emb).toBeInstanceOf(Float32Array);
      expect(emb.length).toBe(EMBEDDING_DIMENSIONS);
    }
  });

  it("splits more than 100 texts into 100-sized batches", async () => {
    calls = [];
    const texts = Array.from({ length: 101 }, (_, i) => `text ${i}`);
    const results = await embedBatch(texts);
    expect(calls.length).toBe(2);
    expect(readBatchBody(calls[0].body).requests.length).toBe(100);
    expect(readBatchBody(calls[1].body).requests.length).toBe(1);
    expect(results.length).toBe(101);
  });

  it("throws on a batch count mismatch", async () => {
    installFetch(respondWith({ embeddings: [{ values: fakeVector(1) }] }));
    try {
      await expect(embedBatch(["a", "b", "c"])).rejects.toThrow("Batch embedding count mismatch: got 1, expected 3");
    } finally {
      installFetch(stubbedFetch);
    }
  });
});

describe("decodeVecBlob (vec0 float[N] column decode)", () => {
  it("returns null for null/undefined", () => {
    expect(decodeVecBlob(null)).toBeNull();
    expect(decodeVecBlob(undefined)).toBeNull();
  });

  it("passes through a dimension-checked Float32Array", () => {
    const vec = new Float32Array(EMBEDDING_DIMENSIONS);
    vec[0] = 0.5;
    expect(decodeVecBlob(vec)).toBe(vec);
  });

  it("returns null for a wrong-length Float32Array", () => {
    expect(decodeVecBlob(new Float32Array(3))).toBeNull();
  });

  it("decodes raw BLOB bytes into floats without byte-indexing", () => {
    const floats = fakeVector(2);
    const bytes = new Uint8Array(EMBEDDING_DIMENSIONS * 4);
    const view = new DataView(bytes.buffer);
    floats.forEach((f, i) => view.setFloat32(i * 4, f, true));
    const decoded = decodeVecBlob(bytes);
    expect(decoded).toBeInstanceOf(Float32Array);
    const out = Array.from(decoded ?? new Float32Array(0));
    for (let i = 0; i < floats.length; i++) {
      expect(Math.abs(out[i] - floats[i])).toBeLessThan(1e-6);
    }
  });

  it("returns null for a wrong byte length", () => {
    expect(decodeVecBlob(new Uint8Array(12))).toBeNull();
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.env.HOME = realHome;
  if (realEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = realEnvKey;
});
