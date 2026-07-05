import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { embedText } from "../shared/embeddings.ts";
import { loadCentroid } from "./profile.ts";
import {
  getInterestWeights,
  updateCandidate,
  type DiscoveryCandidate,
} from "./db.ts";
import { getChannel } from "./db.ts";

const log = createLogger("discovery:scoring");

// Weighting for the additive score. Components are normalized to roughly [0,1]
// before being combined, so these weights express relative importance.
const WEIGHTS = {
  similarity: 0.40,   // cosine(video-summary-embedding, profile centroid)
  topicOverlap: 0.25, // fraction of the profile's topics this video touches
  recency: 0.15,      // exp(-age_days / 14)
  niche: 0.10,        // 1 / log10(view_count + 10) — boosts smaller channels
  channel: 0.10,      // normalized watch_count of the source channel
} as const;

const RECENCY_LAMBDA_DAYS = 14;

export interface ScoreBreakdown {
  similarity: number;
  topicOverlap: number;
  recency: number;
  niche: number;
  channel: number;
  total: number;
}

export interface ScoredCandidate extends DiscoveryCandidate {
  breakdown: ScoreBreakdown;
}

/**
 * Score every unscored 'candidate' against the user interest profile and
 * persist score + breakdown. Returns the scored set sorted desc.
 *
 * Scoring needs each candidate's summary embedding. For candidates whose video
 * is already processed (and thus has a 'summary' chunk in youtube_vec), we read
 * that vector directly. For raw candidates (not yet processed), we fall back to
 * embedding the title (cheap, one embedText call) — this is the cheap pre-filter
 * that decides which candidates are worth the expensive full process step.
 */
export async function scoreCandidates(candidates: DiscoveryCandidate[]): Promise<ScoredCandidate[]> {
  const centroid = loadCentroid();
  const profileSize = getInterestWeights().length;
  const profileTopicIds = new Set(getInterestWeights().map((w) => w.topic_id));

  if (!centroid || profileSize === 0) {
    log.warn("No interest profile/centroid — candidates left unscored", { count: candidates.length });
    return [];
  }

  // Preload max channel watch_count for normalization.
  const db = getDb();
  const maxWatchRow = db
    .prepare(`SELECT MAX(watch_count) as m FROM discovery_channels`)
    .get() as { m: number } | undefined;
  const maxChannelWatch = maxWatchRow?.m ?? 1;

  const scored: ScoredCandidate[] = [];

  for (const c of candidates) {
    const vector = await resolveCandidateVector(c);
    if (!vector) {
      // Can't score without a vector — leave it for the next run.
      continue;
    }

    const similarity = cosineSimilarity(vector, centroid);

    // Topic overlap: which of the profile's topics does this video touch?
    let topicOverlap = 0;
    if (c.status === "processed" || c.video_id) {
      const linkRows = db
        .prepare(`SELECT topic_id FROM youtube_topic_links WHERE video_id = ?`)
        .all(c.video_id) as Array<{ topic_id: number }>;
      if (linkRows.length > 0 && profileSize > 0) {
        const overlap = linkRows.filter((r) => profileTopicIds.has(r.topic_id)).length;
        topicOverlap = overlap / profileSize;
      }
    }

    const recency = recencyScore(c.published_at);
    const niche = nicheScore(c.view_count);
    const channelAffinity = channelScore(c.channel_id, maxChannelWatch);

    const total =
      WEIGHTS.similarity * similarity +
      WEIGHTS.topicOverlap * topicOverlap +
      WEIGHTS.recency * recency +
      WEIGHTS.niche * niche +
      WEIGHTS.channel * channelAffinity;

    const breakdown: ScoreBreakdown = { similarity, topicOverlap, recency, niche, channel: channelAffinity, total };

    updateCandidate(c.id, {
      score: total,
      score_breakdown_json: JSON.stringify(breakdown),
    });

    scored.push({ ...c, score: total, breakdown });
  }

  scored.sort((a, b) => b.breakdown.total - a.breakdown.total);
  log.info("Scored candidates", { scored: scored.length, total: candidates.length });
  return scored;
}

/**
 * Resolve an embedding vector for a candidate by embedding its title.
 *
 * We deliberately do NOT read the 'summary' chunk vector from youtube_vec here,
 * even for already-processed videos. Reason: on a long-lived bun:sqlite
 * connection, interleaving vec0 virtual-table reads with regular table queries
 * corrupts Bun's column-count metadata for subsequent statements (throws
 * "SQLite query expected 1 values, received 2" non-deterministically). The
 * title embedding is one cheap Gemini call and is a perfectly good proxy for
 * ranking candidates, so we use it uniformly and keep the vec tables untouched
 * in the scoring hot path.
 */
async function resolveCandidateVector(c: DiscoveryCandidate): Promise<Float32Array | null> {
  if (!c.title || c.title.trim().length < 3) return null;
  try {
    return await embedText(c.title.slice(0, 200));
  } catch (err) {
    log.warn("Title embedding failed", { videoId: c.video_id, error: String(err) });
    return null;
  }
}

export function recencyScore(publishedAt: string | null): number {
  if (!publishedAt) return 0;
  const ts = Date.parse(publishedAt);
  if (Number.isNaN(ts)) return 0;
  const ageDays = (Date.now() - ts) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1; // future-dated / clock skew
  return Math.exp(-ageDays / RECENCY_LAMBDA_DAYS);
}

export function nicheScore(viewCount: number | null): number {
  if (viewCount == null) return 0.5; // unknown — neutral
  return 1 / Math.log10((viewCount || 0) + 10);
}

export function channelScore(channelId: string | null, maxChannelWatch: number): number {
  if (!channelId) return 0;
  const channel = getChannel(channelId);
  if (!channel) return 0;
  if (maxChannelWatch <= 0) return 0;
  return channel.watch_count / maxChannelWatch;
}

// --- Maximal Marginal Relevance (diversity re-rank) ---

/**
 * Re-rank candidates for diversity using MMR:
 *   score = λ·relevance − (1−λ)·max_similarity_to_selected
 *
 * Greedily picks candidates that are both relevant AND dissimilar to what's
 * already been chosen, preventing a top-N that's all variations on one theme.
 *
 * `vectors` is a parallel array to `candidates` providing each candidate's
 * embedding (used to measure pairwise similarity). Candidates without a vector
 * are treated as maximally diverse (similarity 0) so they aren't penalized.
 *
 * Returns the reordered top `k`.
 */
export function mmrRerank(
  candidates: ScoredCandidate[],
  vectors: (Float32Array | null)[],
  k: number,
  lambda = 0.7,
): ScoredCandidate[] {
  if (candidates.length <= k) return [...candidates];

  const remaining = candidates.map((_, i) => i);
  const selected: number[] = [];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = remaining[0];
    let bestScore = -Infinity;

    for (const i of remaining) {
      const relevance = candidates[i].breakdown.total;
      let maxSim = 0;
      const vi = vectors[i];
      if (vi) {
        for (const j of selected) {
          const vj = vectors[j];
          if (vj) {
            const sim = cosineSimilarity(vi, vj);
            if (sim > maxSim) maxSim = sim;
          }
        }
      }
      const mmr = lambda * relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }

    selected.push(bestIdx);
    remaining.splice(remaining.indexOf(bestIdx), 1);
  }

  return selected.map((i) => candidates[i]);
}

// --- ε-greedy exploration ---

/**
 * Reserve a fraction of the top-N slots for exploration: replace the lowest-
 * ranked item with a random lower-ranked candidate with probability epsilon.
 * Uses an injectable RNG so tests are deterministic.
 *
 * Mutates and returns the (possibly swapped) selection.
 */
export function epsilonGreedy(
  selected: ScoredCandidate[],
  pool: ScoredCandidate[],
  slots: number,
  epsilon = 0.15,
  rng: () => number = Math.random,
): ScoredCandidate[] {
  const result = [...selected].slice(0, slots);
  if (result.length === 0 || pool.length <= result.length) return result;

  const poolIds = new Set(pool.map((c) => c.id));
  const selectedIds = new Set(result.map((c) => c.id));
  const unselected = pool.filter((c) => !selectedIds.has(c.id) && poolIds.has(c.id));

  // For each slot beyond the first (always exploit the top pick), explore.
  for (let i = 1; i < result.length; i++) {
    if (unselected.length === 0) break;
    if (rng() < epsilon) {
      const pickIdx = Math.floor(rng() * unselected.length);
      const exploration = unselected.splice(pickIdx, 1)[0];
      result[i] = exploration;
    }
  }
  return result;
}

// --- shared cosine similarity (mirrors youtube/graph.ts) ---

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export { WEIGHTS };
