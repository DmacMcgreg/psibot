import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { embedText, embedBatch } from "./embeddings.ts";

const log = createLogger("youtube:tags-canonical");

/**
 * Maximum L2 distance for matching an incoming tag against the canonical
 * vocabulary. Tighter than TOPIC_MATCH_THRESHOLD (0.45) because tags are
 * shorter/noisier and we want high precision — a false merge permanently
 * pollutes the canonical set.
 *
 * Empirical sanity: after the Apr 2026 LLM consolidation (1878 → 184), the
 * canonical vocabulary has clear semantic gaps. 0.40 keeps strong matches
 * (e.g. "llm-safety" → "ai-safety") while rejecting borderline cases.
 */
export const TAG_MATCH_THRESHOLD = 0.4;

export interface CanonicalTag {
  id: number;
  name: string;
  usage_count: number;
  created_at: string;
}

export interface SimilarTag extends CanonicalTag {
  distance: number;
}

// --- Tag normalization (mirrors scripts/normalize-youtube-tags.ts) ---

/**
 * Normalize a raw tag string: lowercase, hyphen-joined, ascii only.
 * This must match normalize-youtube-tags.ts so the backfilled canonicals
 * agree with what gets produced at ingestion time.
 */
export function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_\-/.&]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// --- CRUD ---

export function getCanonicalTag(name: string): CanonicalTag | null {
  const db = getDb();
  return db
    .prepare<CanonicalTag, [string]>(
      `SELECT * FROM youtube_tag_canonicals WHERE name = ?`
    )
    .get(name) ?? null;
}

export function createCanonicalTag(name: string): CanonicalTag {
  const db = getDb();
  return db
    .prepare<CanonicalTag, [string]>(
      `INSERT INTO youtube_tag_canonicals (name, usage_count) VALUES (?, 0) RETURNING *`
    )
    .get(name)!;
}

export function incrementTagUsage(tagId: number, delta: number = 1): void {
  const db = getDb();
  db.prepare(`UPDATE youtube_tag_canonicals SET usage_count = usage_count + ? WHERE id = ?`)
    .run(delta, tagId);
}

// --- Embeddings ---

export function upsertTagEmbedding(tagId: number, embedding: Float32Array): void {
  const db = getDb();
  db.prepare(`DELETE FROM youtube_tag_vec WHERE rowid = ?`).run(BigInt(tagId));
  db.prepare(`INSERT INTO youtube_tag_vec (rowid, embedding) VALUES (?, ?)`)
    .run(BigInt(tagId), embedding);
}

export function findSimilarTags(queryEmbedding: Float32Array, k: number): SimilarTag[] {
  const db = getDb();
  const rows = db
    .prepare<{ rowid: number; distance: number }, [Float32Array, number]>(
      `SELECT rowid, distance FROM youtube_tag_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(queryEmbedding, k);

  if (rows.length === 0) return [];

  const results: SimilarTag[] = [];
  for (const row of rows) {
    const tag = db
      .prepare<CanonicalTag, [number]>(`SELECT * FROM youtube_tag_canonicals WHERE id = ?`)
      .get(row.rowid);
    if (tag) {
      results.push({ ...tag, distance: row.distance });
    }
  }
  return results;
}

// --- Match-or-create ---

/**
 * Embedding text for a tag. Hyphens replaced with spaces so "ai-safety" and
 * "ai safety" embed similarly; this mirrors how cluster-youtube-tags.ts
 * fed tags into the embedder during the backfill.
 */
function embeddingTextForTag(name: string): string {
  return name.replace(/-/g, " ");
}

export function matchOrCreateTagFromEmbedding(
  name: string,
  embedding: Float32Array
): { tag: CanonicalTag; reused: boolean; distance: number | null } {
  const normalized = normalizeTag(name);
  if (normalized.length === 0) {
    throw new Error(`Tag normalizes to empty string: "${name}"`);
  }

  // Exact hit short-circuits the vector search.
  const exact = getCanonicalTag(normalized);
  if (exact) {
    return { tag: exact, reused: true, distance: 0 };
  }

  const neighbors = findSimilarTags(embedding, 1);
  if (neighbors.length > 0 && neighbors[0].distance <= TAG_MATCH_THRESHOLD) {
    const match = neighbors[0];
    const { distance, ...tag } = match;
    log.info("Matched tag by embedding", {
      input: normalized,
      matchedTo: match.name,
      distance: distance.toFixed(4),
    });
    return { tag, reused: true, distance };
  }

  const tag = createCanonicalTag(normalized);
  upsertTagEmbedding(tag.id, embedding);
  log.info("Created canonical tag", {
    name: normalized,
    tagId: tag.id,
    nearestDistance: neighbors[0]?.distance.toFixed(4) ?? "none",
  });
  return { tag, reused: false, distance: neighbors[0]?.distance ?? null };
}

export async function matchOrCreateTag(
  name: string
): Promise<{ tag: CanonicalTag; reused: boolean; distance: number | null }> {
  const normalized = normalizeTag(name);
  if (normalized.length === 0) {
    throw new Error(`Tag normalizes to empty string: "${name}"`);
  }
  const embedding = await embedText(embeddingTextForTag(normalized));
  return matchOrCreateTagFromEmbedding(normalized, embedding);
}

/**
 * Resolve a list of raw tags from analyzer output into canonical form.
 * Batch-embeds all unknown tags at once. Returns canonical tag names
 * (deduplicated, insertion-ordered).
 */
export async function canonicalizeTags(rawTags: string[]): Promise<string[]> {
  const normalized = rawTags
    .map((t) => normalizeTag(t))
    .filter((t) => t.length > 0);

  if (normalized.length === 0) return [];

  const db = getDb();
  const needEmbedding: string[] = [];
  const resolved = new Map<string, string>(); // normalized -> canonical name

  for (const n of normalized) {
    if (resolved.has(n)) continue;
    const exact = getCanonicalTag(n);
    if (exact) {
      resolved.set(n, exact.name);
    } else {
      needEmbedding.push(n);
    }
  }

  if (needEmbedding.length > 0) {
    const embeddings = await embedBatch(needEmbedding.map((n) => embeddingTextForTag(n)));
    for (let i = 0; i < needEmbedding.length; i++) {
      const { tag } = matchOrCreateTagFromEmbedding(needEmbedding[i], embeddings[i]);
      resolved.set(needEmbedding[i], tag.name);
    }
  }

  // Bump usage counts + return in insertion order, deduplicated.
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of normalized) {
    const canonical = resolved.get(n);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
    const row = db
      .prepare<{ id: number }, [string]>(`SELECT id FROM youtube_tag_canonicals WHERE name = ?`)
      .get(canonical);
    if (row) incrementTagUsage(row.id, 1);
  }

  return out;
}

/**
 * Return top-k nearest canonical tags for a free-form text (e.g., video
 * title). Used to prime the analyzer with tag vocabulary hints.
 */
export async function getCandidateTagsForText(text: string, k: number): Promise<SimilarTag[]> {
  const embedding = await embedText(text.slice(0, 2000));
  return findSimilarTags(embedding, k);
}

// --- Listing ---

export function listCanonicalTags(limit: number = 200): CanonicalTag[] {
  const db = getDb();
  return db
    .prepare<CanonicalTag, [number]>(
      `SELECT * FROM youtube_tag_canonicals ORDER BY usage_count DESC, name ASC LIMIT ?`
    )
    .all(limit);
}

export function countCanonicalTags(): number {
  const db = getDb();
  return db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_tag_canonicals`).get()!.c;
}
