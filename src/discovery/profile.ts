import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { decodeVecBlob } from "../shared/embeddings.ts";
import {
  clearInterestWeights,
  setInterestWeight,
  getInterestWeights,
  setState,
  getState,
} from "./db.ts";

const log = createLogger("discovery:profile");

// Re-exported so existing callers and tests keep importing it from here.
export { decodeVecBlob };

export const EMBEDDING_DIMENSIONS = 768;

/**
 * Recency decay constant (days) for interest signal: a signal `t` days old
 * contributes exp(-t / 30). That is an e-folding time of 30 days (half-life
 * ≈ 21 days): a video picked 30 days ago carries ~37% of today's weight, one
 * picked 60 days ago ~14%. This lets new interests emerge naturally.
 */
const RECENCY_DECAY_DAYS = 30;

/**
 * Floor on the decay so long-standing interests never vanish entirely. User
 * picks are sparse and bursty (in 2026-09: 16 Watch Later videos all processed
 * in one batch, nothing sent manually for 60+ days), so pure exponential decay
 * made the whole profile equal the latest batch — measured on real data, the
 * top 10 was 100% religion topics and AI/agent topics fell out entirely even
 * though ~400 earlier picks were about them. At 0.1, an old pick counts a
 * tenth of a fresh one: the recent batch still leads, older themes survive.
 */
const RECENCY_FLOOR = 0.1;

/**
 * How many of the top-weighted topics to keep in the profile. The rest are
 * dropped to keep the centroid focused and the scoring query cheap.
 */
const MAX_PROFILE_TOPICS = 60;

// --- Interest signal rules ---------------------------------------------------
//
// Why these rules exist: discovery itself summarises hundreds of videos a
// month into youtube_videos, versus a few dozen the user actually picks. When
// every row in youtube_videos counted, discovery's own picks dominated the
// profile, the profile seeded the next searches, and the loop fed itself
// (by 2026-09 the top topics were "General Content" and revenge-drama tropes).
//
// So only these count:
//   - videos the user chose (sent manually, or synced from Watch Later): +1 each
//   - explicit discover_feedback on any video: interested +1.5, not_interested −2
//   - a discovery pick the user dropped in Telegram (status 'dismissed'): −2
// A discovery-processed video with no feedback contributes nothing.
// Every contribution is multiplied by recencyDecay(age), floored at 0.1.

/** Contribution of one user-chosen video to each of its topics (before decay). */
export const USER_CHOSEN_VIDEO_WEIGHT = 1.0;

/**
 * Contribution of one explicit feedback row to each of the video's topics
 * (before decay). "interested" is worth a bit more than a passive pick because
 * it's a deliberate judgement; "not_interested" is stronger still so a single
 * rejection outweighs a single accidental pick, but a topic backed by several
 * user-chosen videos survives one rejection.
 */
export const FEEDBACK_WEIGHTS = {
  interested: 1.5,
  not_interested: -2.0,
  skipped: 0,
} as const;

export type FeedbackSentiment = keyof typeof FEEDBACK_WEIGHTS;

/**
 * Where a processed video came from:
 *   - watch_later: youtube_videos.playlist_item_id IS NOT NULL (user-chosen)
 *   - discovery:   discovery itself processed it (see VIDEO_SIGNALS_SQL)
 *   - sent:        everything else — the user sent it manually (user-chosen)
 */
export type VideoProvenance = "watch_later" | "sent" | "discovery";

export interface VideoTopicSignal {
  topicId: number;
  topicName: string;
  provenance: VideoProvenance;
  ageDays: number;
}

export interface FeedbackTopicSignal {
  topicId: number;
  topicName: string;
  sentiment: FeedbackSentiment;
  ageDays: number;
}

// --- Non-topics ----------------------------------------------------------------
//
// The analyzer emits fallback themes when it can't find a real subject
// ("General Content" is hard-coded in src/youtube/analyzer.ts; the others are
// LLM-invented catch-alls). They link to hundreds of unrelated videos, so they
// soak up interest weight, and as YouTube search queries they return pure noise.
// They must never be interest topics or search seeds.
//
// Two layers: an exact denylist of the names seen in the wild, plus a pattern
// for close variants. The pattern is deliberately narrow — it must NOT match
// real topics like "Claude Code General-Purpose Agent", "Music Generation" or
// "Weaponized Inspectors General".

/** Lower-cased topic names (youtube_topics.name) that are never real topics. */
export const NON_TOPIC_NAMES: ReadonlySet<string> = new Set([
  "general content",
  "generic content catchall",
  "transcript unavailable / music-only content",
]);

export const NON_TOPIC_PATTERN =
  /^(general|generic)\s+(content|topics?|videos?|discussion)\b|catch[\s-]?all|transcript\s+(unavailable|missing|not\s+available)|no\s+(spoken\s+content|transcript)|music[\s-]only|^(misc(ellaneous)?|uncategori[sz]ed|other|unknown)(\s+(content|topics?))?$/i;

export function isNonTopic(name: string | null | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  if (n.length === 0) return true;
  return NON_TOPIC_NAMES.has(n) || NON_TOPIC_PATTERN.test(n);
}

// --- Pure weighting ------------------------------------------------------------

export function recencyDecay(ageDays: number): number {
  const age = Number.isFinite(ageDays) ? Math.max(0, ageDays) : 0;
  return Math.max(RECENCY_FLOOR, Math.exp(-age / RECENCY_DECAY_DAYS));
}

/**
 * Combine per-video and per-feedback signals into a raw (un-normalized) weight
 * per topic. Net weight can be negative when rejections outweigh picks.
 * Non-topics are dropped entirely.
 */
export function computeTopicWeights(
  videoSignals: VideoTopicSignal[],
  feedbackSignals: FeedbackTopicSignal[],
): Map<number, number> {
  const weights = new Map<number, number>();
  const add = (topicId: number, w: number) => {
    if (w === 0) return;
    weights.set(topicId, (weights.get(topicId) ?? 0) + w);
  };

  for (const s of videoSignals) {
    if (isNonTopic(s.topicName)) continue;
    if (s.provenance === "discovery") continue; // no feedback → no signal
    add(s.topicId, USER_CHOSEN_VIDEO_WEIGHT * recencyDecay(s.ageDays));
  }

  for (const f of feedbackSignals) {
    if (isNonTopic(f.topicName)) continue;
    add(f.topicId, (FEEDBACK_WEIGHTS[f.sentiment] ?? 0) * recencyDecay(f.ageDays));
  }

  return weights;
}

/**
 * Normalize raw weights for storage in discovery_interest_weights:
 *   - the top `maxTopics` positive topics, scaled so the strongest is 1.0
 *   - every negative topic, scaled by the same factor (clamped to −1)
 * Positive rows drive search seeds and the centroid (getInterestWeights()
 * filters weight > 0); negative rows are kept for inspection and so nothing
 * downstream mistakes a rejected topic for an unseen one.
 */
export function rankInterestWeights(
  raw: Map<number, number>,
  maxTopics = MAX_PROFILE_TOPICS,
): Array<{ topicId: number; weight: number }> {
  const positive = [...raw.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]);
  const negative = [...raw.entries()].filter(([, w]) => w < 0).sort((a, b) => a[1] - b[1]);
  const top = positive.slice(0, maxTopics);
  const scale = top[0]?.[1] ?? Math.abs(negative[0]?.[1] ?? 1);
  return [
    ...top.map(([topicId, w]) => ({ topicId, weight: w / scale })),
    ...negative.map(([topicId, w]) => ({ topicId, weight: Math.max(-1, w / scale) })),
  ];
}

// --- DB loaders ----------------------------------------------------------------

/**
 * One row per (video, topic). A video counts as discovery-found only when a
 * discovery_candidates row for it actually reached processing. Plain
 * membership in discovery_candidates is not enough: RSS routinely re-finds
 * videos the user already sent months earlier (they sit there as 'candidate'
 * or 'expired_stale'), and those are still user-chosen.
 */
const VIDEO_SIGNALS_SQL = `
  SELECT tl.topic_id AS topicId,
         t.name AS topicName,
         CASE
           WHEN v.playlist_item_id IS NOT NULL THEN 'watch_later'
           WHEN EXISTS (
             SELECT 1 FROM discovery_candidates dc
              WHERE dc.video_id = v.video_id
                AND (dc.status IN ('processing','processed','surfaced','dismissed')
                     OR dc.reason LIKE 'processing_failed%')
           ) THEN 'discovery'
           ELSE 'sent'
         END AS provenance,
         julianday('now') - julianday(v.processed_at) AS ageDays
    FROM youtube_topic_links tl
    JOIN youtube_videos v ON v.video_id = tl.video_id
    JOIN youtube_topics t ON t.id = tl.topic_id`;

/**
 * Explicit feedback linked to topics: discover_feedback → atlas_items
 * (kind='youtube', source_id = video_id) → youtube_topic_links. Only the latest
 * feedback row per atlas item counts, so a user who changes their mind isn't
 * double-counted. Telegram "Drop" on a discovery pick (candidate status
 * 'dismissed', no timestamp of its own) counts as not_interested, aged from
 * when the video was processed.
 */
const FEEDBACK_SIGNALS_SQL = `
  SELECT tl.topic_id AS topicId,
         t.name AS topicName,
         f.sentiment AS sentiment,
         julianday('now') - julianday(f.created_at) AS ageDays
    FROM discover_feedback f
    JOIN (SELECT atlas_item_id, MAX(id) AS id FROM discover_feedback GROUP BY atlas_item_id) latest
      ON latest.id = f.id
    JOIN atlas_items a ON a.id = f.atlas_item_id AND a.kind = 'youtube'
    JOIN youtube_topic_links tl ON tl.video_id = a.source_id
    JOIN youtube_topics t ON t.id = tl.topic_id
  UNION ALL
  SELECT tl.topic_id, t.name, 'not_interested',
         julianday('now') - julianday(COALESCE(MAX(v.processed_at), MAX(dc.discovered_at)))
    FROM discovery_candidates dc
    LEFT JOIN youtube_videos v ON v.video_id = dc.video_id
    JOIN youtube_topic_links tl ON tl.video_id = dc.video_id
    JOIN youtube_topics t ON t.id = tl.topic_id
   WHERE dc.status = 'dismissed'
     AND NOT EXISTS (
       SELECT 1 FROM discover_feedback f2
         JOIN atlas_items a2 ON a2.id = f2.atlas_item_id AND a2.kind = 'youtube'
        WHERE a2.source_id = dc.video_id)
   GROUP BY dc.video_id, tl.topic_id`;

export function loadVideoTopicSignals(): VideoTopicSignal[] {
  return getDb().prepare<VideoTopicSignal, []>(VIDEO_SIGNALS_SQL).all();
}

export function loadFeedbackTopicSignals(): FeedbackTopicSignal[] {
  return getDb().prepare<FeedbackTopicSignal, []>(FEEDBACK_SIGNALS_SQL).all();
}

export interface ProfileBuildResult {
  topicsConsidered: number;
  topicsKept: number;
  negativeTopics: number;
  centroidRecomputed: boolean;
}

/**
 * Build the user interest profile from user-chosen videos plus explicit
 * feedback (rules above). Writes normalized weights into
 * discovery_interest_weights and caches a centroid vector in discovery_state.
 * The centroid is the weighted average of the (unit-normalized) topic
 * embeddings from youtube_topic_vec.
 */
export async function buildInterestProfile(): Promise<ProfileBuildResult> {
  const raw = computeTopicWeights(loadVideoTopicSignals(), loadFeedbackTopicSignals());
  const ranked = rankInterestWeights(raw);

  clearInterestWeights();
  for (const { topicId, weight } of ranked) setInterestWeight(topicId, weight);

  const centroidRecomputed = await recomputeCentroid();
  const negativeTopics = ranked.filter((r) => r.weight < 0).length;
  const topicsKept = ranked.length - negativeTopics;

  log.info("Interest profile built", {
    topicsConsidered: raw.size,
    topicsKept,
    negativeTopics,
    centroidRecomputed,
  });

  return { topicsConsidered: raw.size, topicsKept, negativeTopics, centroidRecomputed };
}

/** Scale a vector to unit L2 norm in place; returns it (unchanged if zero). */
export function normalizeInPlace(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/**
 * One interest topic's unit-normalized embedding plus its profile weight in
 * (0, 1]. Scoring compares a candidate against each of these individually —
 * see profileSimilarity() in scoring.ts for why a single centroid isn't enough.
 */
export interface ProfileTopicVector {
  topicId: number;
  weight: number;
  vector: Float32Array;
}

/**
 * Cache the profile for scoring, from the positive rows in
 * discovery_interest_weights and their embeddings in youtube_topic_vec
 * (rowid = topic id):
 *   - "profile_topics": every topic's unit-normalized vector + weight
 *   - "centroid": the weighted average of those vectors, unit-normalized
 * Both live in discovery_state so scoring never reads a vec0 table (see the
 * bun:sqlite note in scoring.ts).
 *
 * History: until 2026-09 this read the vec0 column as if bun:sqlite returned a
 * Float32Array. It returns a Uint8Array of raw bytes, so the "centroid" was
 * the average of byte values 0..255 over the first 192 floats — a constant
 * positive vector unrelated to any topic — and every candidate's similarity
 * came out ≈ 0. decodeVecBlob() fixes the decode; normalizing each topic
 * first stops gemini-embedding-001's uneven 768-dim norms from skewing weights.
 *
 * Returns true if the profile was (re)computed and cached.
 */
export async function recomputeCentroid(): Promise<boolean> {
  const db = getDb();
  const weights = getInterestWeights();
  if (weights.length === 0) {
    clearProfileCache();
    return false;
  }

  const stmt = db.prepare<{ embedding: Uint8Array }, [number]>(
    `SELECT embedding FROM youtube_topic_vec WHERE rowid = ?`,
  );
  const topics: ProfileTopicVector[] = [];
  for (const w of weights) {
    const vec = decodeVecBlob(stmt.get(w.topic_id)?.embedding);
    if (vec) topics.push({ topicId: w.topic_id, weight: w.weight, vector: normalizeInPlace(vec) });
  }
  const missing = weights.length - topics.length;

  const centroid = weightedCentroid(topics);
  if (!centroid) {
    log.warn("Centroid: no topic embeddings found (need backfill?)", {
      weights: weights.length,
      missing,
    });
    clearProfileCache();
    return false;
  }

  setState("centroid", float32ToBase64(centroid));
  setState("profile_topics", encodeProfileTopics(topics));
  log.info("Centroid recomputed", { topics: topics.length, missing });
  return true;
}

function clearProfileCache(): void {
  setState("centroid", "");
  setState("profile_topics", "");
}

/** Weighted mean of unit vectors, unit-normalized. Null if no positive weight. */
export function weightedCentroid(topics: ProfileTopicVector[]): Float32Array | null {
  const centroid = new Float32Array(EMBEDDING_DIMENSIONS);
  let total = 0;
  for (const t of topics) {
    if (t.weight <= 0) continue;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) centroid[i] += t.vector[i] * t.weight;
    total += t.weight;
  }
  return total > 0 ? normalizeInPlace(centroid) : null;
}

export function encodeProfileTopics(topics: ProfileTopicVector[]): string {
  const flat = new Float32Array(topics.length * EMBEDDING_DIMENSIONS);
  topics.forEach((t, i) => flat.set(t.vector, i * EMBEDDING_DIMENSIONS));
  return JSON.stringify({
    ids: topics.map((t) => t.topicId),
    weights: topics.map((t) => t.weight),
    vectors: float32ToBase64(flat),
  });
}

export function decodeProfileTopics(raw: string | null): ProfileTopicVector[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { ids: number[]; weights: number[]; vectors: string };
    const flat = base64ToFloat32(parsed.vectors);
    if (flat.length !== parsed.ids.length * EMBEDDING_DIMENSIONS) return [];
    return parsed.ids.map((topicId, i) => ({
      topicId,
      weight: parsed.weights[i],
      vector: flat.slice(i * EMBEDDING_DIMENSIONS, (i + 1) * EMBEDDING_DIMENSIONS),
    }));
  } catch {
    return [];
  }
}

/** Load the cached per-topic profile vectors ([] if unset — run buildInterestProfile). */
export function loadProfileTopics(): ProfileTopicVector[] {
  return decodeProfileTopics(getState("profile_topics"));
}

/**
 * Load the cached centroid (Float32Array of 768 dims) or null if unset/empty.
 */
export function loadCentroid(): Float32Array | null {
  const raw = getState("centroid");
  if (!raw) return null;
  try {
    const v = base64ToFloat32(raw);
    return v.length === EMBEDDING_DIMENSIONS ? v : null;
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
