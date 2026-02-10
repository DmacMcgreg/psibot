import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("youtube:embeddings");

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

interface EmbeddingResponse {
  embedding: { values: number[] };
}

interface GeminiEmbedResponse {
  embeddings?: Array<EmbeddingResponse>;
}

interface GeminiBatchEmbedResponse {
  embeddings?: Array<{ values: number[] }>;
}

let cachedApiKey: string | null = null;

function getGeminiApiKey(): string {
  if (cachedApiKey) return cachedApiKey;

  const envKey = process.env.GEMINI_API_KEY;
  if (envKey) {
    cachedApiKey = envKey;
    return envKey;
  }

  const configPath = join(process.env.HOME ?? "", ".openclaw", "openclaw.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as {
      skills?: { entries?: { "nano-banana-pro"?: { apiKey?: string } } };
    };
    const key = config.skills?.entries?.["nano-banana-pro"]?.apiKey;
    if (key) {
      cachedApiKey = key;
      return key;
    }
  } catch {
    // fall through
  }

  throw new Error("No Gemini API key found. Set GEMINI_API_KEY or configure ~/.openclaw/openclaw.json");
}

/**
 * Generate an embedding vector for a single text string.
 * Returns a Float32Array of 768 dimensions.
 */
export async function embedText(text: string): Promise<Float32Array> {
  const apiKey = getGeminiApiKey();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `models/${EMBEDDING_MODEL}`,
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini embedding API error ${response.status}: ${errorText.slice(0, 300)}`);
  }

  const data = (await response.json()) as { embedding?: { values?: number[] } };
  const values = data.embedding?.values;

  if (!values || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Unexpected embedding dimensions: got ${values?.length ?? 0}, expected ${EMBEDDING_DIMENSIONS}`);
  }

  return new Float32Array(values);
}

/**
 * Generate embeddings for multiple texts in a single batch request.
 * Returns an array of Float32Arrays.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embedText(texts[0])];

  const apiKey = getGeminiApiKey();

  // Gemini batchEmbedContents supports up to 100 texts per request
  const BATCH_SIZE = 100;
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini batch embedding API error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as GeminiBatchEmbedResponse;
    const embeddings = data.embeddings;

    if (!embeddings || embeddings.length !== batch.length) {
      throw new Error(`Batch embedding count mismatch: got ${embeddings?.length ?? 0}, expected ${batch.length}`);
    }

    for (const emb of embeddings) {
      if (!emb.values || emb.values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Unexpected embedding dimensions in batch: ${emb.values?.length ?? 0}`);
      }
      results.push(new Float32Array(emb.values));
    }

    log.info("Batch embedded", { batchIndex: i, count: batch.length });
  }

  return results;
}

export { EMBEDDING_DIMENSIONS };
