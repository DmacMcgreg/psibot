import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import {
  clearInterestWeights,
  setInterestWeight,
  getInterestWeights,
  setState,
  getState,
} from "./db.ts";

const log = createLogger("discovery:profile");

export const EMBEDDING_DIMENSIONS = 768;

/**
 * Half-life (days) for temporal decay of interest signal from watched videos.
 * A video watched 30 days ago carries ~half the weight of one watched today;
 * at 90 days it's ~one-eighth. This lets new interests emerge naturally.
 */
const RECENCY_HALFLIFE_DAYS = 30;

/**
 * How many of the top-weighted topics to keep in the profile. The rest are
 * dropped to keep the centroid focused and the scoring query cheap.
 */
const MAX_PROFILE_TOPICS = 60;

export interface ProfileBuildResult {
  topicsConsidered: number;
  topicsKept: number;
  centroidRecomputed: boolean;
}

interface TopicWeightRow {
  topic_id: number;
  raw_weight: number;
}

/**
 * Build the user interest profile from two signals:
 *   1. The knowledge graph — every video linked to a topic contributes a
 *      recency-decayed weight to that topic. Topics covered by many recent
 *      videos rank highest.
 *   2. Explicit feedback — `feedback_log` entries with user_action indicating
 *      interest in a topic (positive) or disinterest (negative). These are
 *      rare but high-signal.
 *
 * Writes normalized weights into discovery_interest_weights and caches a
 * centroid vector in discovery_state. The centroid is the weighted average of
 * the topic embeddings (reused from youtube_topic_vec).
 */
export async function buildInterestProfile(): Promise<ProfileBuildResult> {
  const db = getDb();

  // --- Signal 1: topic links with temporal decay ---
  const graphRows = db
    .prepare<{ topic_id: number; weight: number }, []>(
      `SELECT tl.topic_id,
              SUM(
                exp(
                  -1.0 * (julianday('now') - julianday(v.processed_at)) / ${RECENCY_HALFLIFE_DAYS}
                )
              ) as weight
       FROM youtube_topic_links tl
       JOIN youtube_videos v ON v.video_id = tl.video_id
       GROUP BY tl.topic_id`,
    )
    .all();

  const weights = new Map<number, number>();
  for (const row of graphRows) {
    weights.set(row.topic_id, (weights.get(row.topic_id) ?? 0) + row.weight);
  }

  // --- Signal 2: explicit feedback ---
  // feedback_log currently joins pending_items -> themes, not directly to
  // youtube_topics, so the topic weights above already capture the strongest
  // signal (what the user actually watched + had processed). Feedback-driven
  // topic bumps are a Phase 2 enhancement once we link feedback to topics.

  // --- Normalize + keep top-K ---
  clearInterestWeights();
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked.slice(0, MAX_PROFILE_TOPICS);
  const maxWeight = top[0]?.[1] ?? 1;
  for (const [topicId, w] of top) {
    setInterestWeight(topicId, maxWeight > 0 ? w / maxWeight : w);
  }

  // --- Centroid: weighted average of topic embeddings ---
  const centroidRecomputed = await recomputeCentroid();

  log.info("Interest profile built", {
    topicsConsidered: weights.size,
    topicsKept: top.length,
    centroidRecomputed,
  });

  return {
    topicsConsidered: weights.size,
    topicsKept: top.length,
    centroidRecomputed,
  };
}

/**
 * Compute the profile centroid as the weighted average of topic embeddings
 * (read from youtube_topic_vec, keyed by rowid = topic id). Cache as a
 * base64 Float32 blob in discovery_state so scoring runs don't recompute.
 *
 * Returns true if the centroid was (re)computed and cached.
 */
export async function recomputeCentroid(): Promise<boolean> {
  const db = getDb();
  const weights = getInterestWeights();
  if (weights.length === 0) {
    setState("centroid", "");
    return false;
  }

  const centroid = new Float32Array(EMBEDDING_DIMENSIONS);
  let totalWeight = 0;
  let missing = 0;

  for (const w of weights) {
    const row = db
      .prepare<{ embedding: Float32Array }, [number]>(
        `SELECT embedding FROM youtube_topic_vec WHERE rowid = ?`,
      )
      .get(w.topic_id);
    if (!row?.embedding) {
      missing++;
      continue;
    }
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      centroid[i] += row.embedding[i] * w.weight;
    }
    totalWeight += w.weight;
  }

  if (totalWeight === 0) {
    log.warn("Centroid: no topic embeddings found (need backfill?)", {
      weights: weights.length,
      missing,
    });
    setState("centroid", "");
    return false;
  }

  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    centroid[i] /= totalWeight;
  }

  setState("centroid", float32ToBase64(centroid));
  log.info("Centroid recomputed", { topics: weights.length - missing, missing });
  return true;
}

/**
 * Load the cached centroid (Float32Array of 768 dims) or null if unset/empty.
 */
export function loadCentroid(): Float32Array | null {
  const raw = getState("centroid");
  if (!raw) return null;
  try {
    return base64ToFloat32(raw);
  } catch {
    return null;
  }
}

// --- Float32 <-> base64 codec (compact, no JSON array overhead) ---

export function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  // Bun has btoa; use it. Output is ~1.3x the raw byte length.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToFloat32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}
