import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { embedBatch } from "../shared/embeddings.ts";
import { loadCentroid, loadProfileTopics, type ProfileTopicVector } from "./profile.ts";
import {
  getInterestWeights,
  updateCandidate,
  type DiscoveryCandidate,
} from "./db.ts";
import { getChannel } from "./db.ts";

const log = createLogger("discovery:scoring");

// Weighting for the additive score. Components are normalized to roughly [0,1]
// before being combined, so these weights express relative importance.
//
// similarity carries the 0.25 that used to go to a topicOverlap component
// (fraction of profile topics in the video's youtube_topic_links). Topic links
// only exist once a video is processed, so on 560 candidates scored
// 2026-08-26..09-25 the component was non-zero for 5 (max 0.083). Recomputing
// it from the title embedding instead correlated 0.7 with similarity and left
// the ranking AUCs unchanged. On 774 real titles, moving its weight to
// similarity raised "non-drama beats drama" among gate-passing candidates from
// 0.57 to 0.61, and "AI beats other" from 0.76 to 0.79.
// Details: docs/plans/2026-09-25-discovery-followups.md
const WEIGHTS = {
  similarity: 0.65,   // profileSimilarity(title embedding, interest topics), rescaled to [0,1]
  recency: 0.15,      // exp(-age_days / 14)
  niche: 0.10,        // 1 / log10(view_count + 10) — boosts smaller channels
  channel: 0.10,      // normalized watch_count of the source channel
} as const;

const RECENCY_LAMBDA_DAYS = 14;

// --- Relevance -----------------------------------------------------------------
//
// gemini-embedding-001 cosine similarities are compressed: two unrelated
// English texts still score ~0.45–0.5, near-paraphrases ~0.8. Measured on 400
// real candidates from 2026-08-26..09-25 (profile built by profile.ts rules):
// revenge-drama/viral shorts averaged 0.43 raw, AI/agent videos 0.56, and the
// best matches reached ~0.79. Feeding the raw cosine into the additive score
// would let a 0.1 swing in relevance be drowned by recency (0.15 × 0..1).

/** Weighted-max multiplier: a topic at profile weight w counts cos × (0.75 + 0.25w). */
const TOPIC_WEIGHT_FLOOR = 0.75;

/** Raw cosine mapped to 0 in the rescaled similarity component (≈ unrelated text). */
export const SIMILARITY_BASELINE = 0.4;
/** Raw cosine mapped to 1 in the rescaled similarity component (≈ strong match). */
export const SIMILARITY_CEILING = 0.7;

/**
 * Minimum raw profileSimilarity for a candidate to be processed (summarised
 * into youtube_videos) and surfaced. Below it the candidate is rejected with
 * a `below_relevance_gate:` reason.
 *
 * Picked from the fixed score distribution on 566 candidates from the last
 * 30 days (details: docs/plans/2026-09-25-discovery-loop-fix.md):
 *   - revenge-drama / viral-shorts titles: p50 0.431, p90 0.458
 *   - AI / agent / Claude-Code titles:     p10 0.505, p50 0.562
 * 0.47 sits just above the junk cluster's p90 and well below the AI p10.
 * Replayed over the 290 candidates surfaced in those 30 days it would have
 * blocked 188: 70 of 76 drama titles, 0 of 48 AI titles, and 118 of 166
 * others — mostly outrage politics, foreign-language news and game shorts.
 * The 0.455–0.475 band is genuinely mixed (Linux reviews next to drama), so
 * lowering it trades junk for a few borderline tech videos.
 */
export const MIN_RELEVANCE_SIMILARITY = 0.47;

export interface ScoreBreakdown {
  /** Rescaled relevance in [0,1]: (raw − BASELINE) / (CEILING − BASELINE), clamped. */
  similarity: number;
  /** profileSimilarity() raw cosine — what the relevance gate checks. */
  similarityRaw: number;
  recency: number;
  niche: number;
  channel: number;
  total: number;
}

export interface ScoredCandidate extends DiscoveryCandidate {
  breakdown: ScoreBreakdown;
  /** Title embedding used for scoring; reused for MMR diversity (never persisted). */
  vector?: Float32Array;
}

/**
 * Score every unscored 'candidate' against the user interest profile and
 * persist score + breakdown. Returns the scored set sorted desc.
 *
 * Each candidate is scored on its title embedding (see
 * resolveCandidateVectors) — the cheap pre-filter that decides which
 * candidates are worth the expensive full process step.
 */
export async function scoreCandidates(candidates: DiscoveryCandidate[]): Promise<ScoredCandidate[]> {
  const centroid = loadCentroid();
  const profileTopics = loadProfileTopics();
  const profileSize = getInterestWeights().length;

  if ((!centroid && profileTopics.length === 0) || profileSize === 0) {
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
  const vectors = await resolveCandidateVectors(candidates);

  for (const [i, c] of candidates.entries()) {
    const vector = vectors[i];
    if (!vector) {
      // Can't score without a vector — leave it for the next run.
      continue;
    }

    // Prefer per-topic similarity; fall back to the centroid only when the
    // profile_topics cache predates this code (first run after upgrade).
    const similarityRaw = profileTopics.length > 0
      ? profileSimilarity(vector, profileTopics)
      : cosineSimilarity(vector, centroid!);
    const similarity = rescaleSimilarity(similarityRaw);

    const recency = recencyScore(c.published_at);
    const niche = nicheScore(c.view_count);
    const channelAffinity = channelScore(c.channel_id, maxChannelWatch);

    const total =
      WEIGHTS.similarity * similarity +
      WEIGHTS.recency * recency +
      WEIGHTS.niche * niche +
      WEIGHTS.channel * channelAffinity;

    const breakdown: ScoreBreakdown = {
      similarity,
      similarityRaw,
      recency,
      niche,
      channel: channelAffinity,
      total,
    };

    updateCandidate(c.id, {
      score: total,
      score_breakdown_json: JSON.stringify(breakdown),
    });

    scored.push({ ...c, score: total, breakdown, vector });
  }

  scored.sort((a, b) => b.breakdown.total - a.breakdown.total);
  log.info("Scored candidates", { scored: scored.length, total: candidates.length });
  return scored;
}

/** Titles per embedBatch call: the Gemini batch limit, so 200 titles = 2 calls. */
const EMBED_BATCH_SIZE = 100;

/**
 * Resolve an embedding vector for each candidate (parallel array) by embedding
 * its title, EMBED_BATCH_SIZE titles per API call. A failed call leaves only
 * its own batch null; those candidates stay unscored for the next run.
 * Candidates with no usable title get null.
 *
 * We deliberately do NOT read the 'summary' chunk vector from youtube_vec here,
 * even for already-processed videos. Reason: on a long-lived bun:sqlite
 * connection, interleaving vec0 virtual-table reads with regular table queries
 * corrupts Bun's column-count metadata for subsequent statements (throws
 * "SQLite query expected 1 values, received 2" non-deterministically). The
 * title embedding is cheap and a good proxy for ranking candidates, so we use
 * it uniformly and keep the vec tables untouched in the scoring hot path.
 */
export async function resolveCandidateVectors(
  candidates: DiscoveryCandidate[],
  embed: (texts: string[]) => Promise<Float32Array[]> = embedBatch,
): Promise<(Float32Array | null)[]> {
  const vectors: (Float32Array | null)[] = candidates.map(() => null);
  const embeddable = candidates.flatMap((c, i) => (c.title && c.title.trim().length >= 3 ? [i] : []));
  for (let start = 0; start < embeddable.length; start += EMBED_BATCH_SIZE) {
    const batch = embeddable.slice(start, start + EMBED_BATCH_SIZE);
    try {
      const embedded = await embed(batch.map((i) => candidates[i].title!.slice(0, 200)));
      batch.forEach((candidateIdx, k) => {
        vectors[candidateIdx] = embedded[k] ?? null;
      });
    } catch (err) {
      log.warn("Title embedding batch failed", { count: batch.length, error: String(err) });
    }
  }
  return vectors;
}

/**
 * How well a candidate matches the user's interests: the best weighted cosine
 * against any single profile topic, cos(v, topic) × (0.75 + 0.25·weight).
 *
 * Why not cosine to the centroid: the user's interests are multi-modal (AI
 * agents, early Christianity, health, geopolitics…). Their weighted average
 * lands between clusters, close to nothing in particular, so nearly every
 * title scored 0.58–0.70 against it. On the 400-candidate sample the AUC for
 * "AI/agent title beats revenge-drama title" was 0.97 via the centroid vs
 * 0.99 via weighted max, and "any non-drama beats drama" was 0.69 vs 0.75.
 * The weight term lets a strong, current interest edge out a faint old one
 * without letting weight alone manufacture relevance.
 */
export function profileSimilarity(vector: Float32Array, topics: ProfileTopicVector[]): number {
  let best = 0;
  for (const t of topics) {
    const w = Math.min(1, Math.max(0, t.weight));
    const s = cosineSimilarity(vector, t.vector) * (TOPIC_WEIGHT_FLOOR + (1 - TOPIC_WEIGHT_FLOOR) * w);
    if (s > best) best = s;
  }
  return best;
}

/** Map a raw cosine onto [0,1] between SIMILARITY_BASELINE and SIMILARITY_CEILING. */
export function rescaleSimilarity(raw: number): number {
  const x = (raw - SIMILARITY_BASELINE) / (SIMILARITY_CEILING - SIMILARITY_BASELINE);
  return Math.min(1, Math.max(0, x));
}

/**
 * True when a scored candidate is relevant enough to process and surface.
 * The runner raises `threshold` when the Jev gate is unavailable
 * (DISCOVERY_FALLBACK_MIN_SIMILARITY), since the embedding gate is then the
 * last check before the paid summary.
 */
export function passesRelevanceGate(b: Pick<ScoreBreakdown, "similarityRaw">, threshold = MIN_RELEVANCE_SIMILARITY): boolean {
  return Number.isFinite(b.similarityRaw) && b.similarityRaw >= threshold;
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
