import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { searchVideos, getVideoStats, type VideoStat } from "../youtube/api.ts";
import { ReauthRequiredError } from "../youtube/api.ts";
import { getRelatedVideos } from "../youtube/graph.ts";
import {
  getInterestWeights,
  insertCandidate,
  updateCandidate,
  type DiscoveryCandidate,
} from "./db.ts";
import { isNonTopic } from "./profile.ts";
import {
  decodeHtmlEntities,
  prefilterCandidate,
  prefilterReason,
  type PrefilterConfig,
} from "./prefilter.ts";
import type { Seed } from "./seeds.ts";

const log = createLogger("discovery:candidates");

export interface FanOutResult {
  searchesRun: number;
  quotaUnitsUsed: number;
  candidatesFound: number;
  reauthRequired: boolean;
  /** Seeds actually searched this run (for per-seed yield tracking). */
  seedsUsed: Array<{ key: string; query: string }>;
  /** New search candidates rejected on insert by the pre-filters. */
  prefiltered: number;
}

export interface FanOutOptions {
  /** Explicit seeds (src/discovery/seeds.ts). Omitted = legacy: top profile topic names. */
  seeds?: Seed[];
  /** search.list relevanceLanguage hint, e.g. "en". */
  relevanceLanguage?: string;
  /** Reject junk on insert using the metadata videos.list already returned. */
  prefilter?: { config: PrefilterConfig; knownChannels: Map<string, number> };
}

/**
 * Budgeted fan-out search. The most quota-expensive part of discovery: each
 * search.list call costs 100 units AND consumes one of the ~100/day search
 * bucket. So we (1) cap calls per run, (2) derive search queries from the
 * user's own top interest topics (so each call is high-yield), and (3) bias
 * toward recent uploads via publishedAfter.
 *
 * Returns counts for run bookkeeping; never throws on a single search failure.
 */
export async function fanOutSearch(maxCalls: number, opts: FanOutOptions = {}): Promise<FanOutResult> {
  const seedTopics = opts.seeds
    ? opts.seeds.map((s) => ({ key: s.key, display_name: s.query }))
    : legacySeedTopics(maxCalls);
  if (seedTopics.length === 0) {
    log.info("No search seeds — skipping fan-out search");
    return { searchesRun: 0, quotaUnitsUsed: 0, candidatesFound: 0, reauthRequired: false, seedsUsed: [], prefiltered: 0 };
  }
  const db = getDb();
  const candidateId = db.prepare<{ id: number }, [string]>(
    `SELECT id FROM discovery_candidates WHERE video_id = ? AND source = 'search'`,
  );

  const calls = Math.min(maxCalls, seedTopics.length);
  const publishedAfter = new Date(Date.now() - 14 * 86400_000).toISOString();

  let searchesRun = 0;
  let quotaUnitsUsed = 0;
  let candidatesFound = 0;
  let prefiltered = 0;
  let reauthRequired = false;
  const seedsUsed: FanOutResult["seedsUsed"] = [];

  for (let i = 0; i < calls; i++) {
    const topic = seedTopics[i];
    const query = topic.display_name;
    let results;
    try {
      results = await searchVideos({
        query,
        maxResults: 15,
        order: "relevance",
        publishedAfter,
        ...(opts.relevanceLanguage ? { relevanceLanguage: opts.relevanceLanguage } : {}),
      });
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        reauthRequired = true;
        log.warn("Reauth required — aborting fan-out search", { error: err.message });
        break;
      }
      log.warn("search.list failed (continuing)", {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      // The call may still have counted against quota; be conservative.
      searchesRun++;
      quotaUnitsUsed += 100;
      continue;
    }

    searchesRun++;
    quotaUnitsUsed += 100;
    seedsUsed.push({ key: topic.key, query });

    // Enrich with view counts (cheap: 1 unit per 50). This powers the niche
    // boost in scoring and the duration/category/language pre-filters. Batched.
    const ids = results.map((r) => r.videoId);
    let statsMap = new Map<string, VideoStat>();
    if (ids.length > 0) {
      try {
        const stats = await getVideoStats(ids);
        quotaUnitsUsed += 1;
        statsMap = new Map(stats.map((s) => [s.videoId, s]));
      } catch (err) {
        log.warn("getVideoStats failed (non-fatal)", {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let newForQuery = 0;
    for (const r of results) {
      const stat = statsMap.get(r.videoId);
      const title = decodeHtmlEntities(r.title);
      const inserted = insertCandidate({
        videoId: r.videoId,
        channelId: r.channelId || null,
        title,
        publishedAt: r.publishedAt,
        source: "search",
        sourceDetail: query,
        viewCount: stat?.viewCount ?? null,
        durationSeconds: stat?.durationSeconds ?? null,
      });
      if (!inserted) continue;
      candidatesFound++;
      newForQuery++;
      if (opts.prefilter) {
        const channelTitle = stat?.channelTitle || r.channelTitle;
        const verdict = prefilterCandidate({
          title,
          channelTitle,
          durationSeconds: stat ? stat.durationSeconds : null,
          categoryId: stat?.categoryId,
          audioLanguage: stat?.audioLanguage,
          textLanguage: stat?.textLanguage,
          knownChannel: (opts.prefilter.knownChannels.get(channelTitle.toLowerCase()) ?? 0) > 0,
        }, opts.prefilter.config);
        const row = verdict.reject ? candidateId.get(r.videoId) : null;
        if (verdict.reject && row) {
          updateCandidate(row.id, { status: "rejected", reason: prefilterReason(verdict) });
          prefiltered++;
        }
      }
    }

    log.info("Fan-out search", { query, results: results.length, new: newForQuery });
  }

  log.info("Fan-out search complete", {
    searchesRun,
    quotaUnitsUsed,
    candidatesFound,
    prefiltered,
    reauthRequired,
  });

  return { searchesRun, quotaUnitsUsed, candidatesFound, reauthRequired, seedsUsed, prefiltered };
}

/**
 * The pre-2026-09-26 seed choice: display names of the top-weighted profile
 * topics, same order every run. Kept for DISCOVERY_SEED_MODE=profile.
 */
function legacySeedTopics(maxCalls: number): Array<{ key: string; display_name: string }> {
  const weights = getInterestWeights();
  if (weights.length === 0) return [];

  // Resolve the topic display names for the top-weighted topics — these become
  // the search seed queries. Mixing in a couple of mid-ranked topics adds some
  // exploration beyond just the dominant interests.
  const db = getDb();
  const topicIds = [
    ...weights.slice(0, Math.ceil(maxCalls * 0.7)).map((w) => w.topic_id),
    ...weights.slice(Math.ceil(maxCalls * 0.7), maxCalls).map((w) => w.topic_id),
  ];

  // isNonTopic is also applied when the profile is built; checking again here
  // keeps a catch-all ("General Content") from ever becoming a search query
  // even if a stale profile row slips through.
  const seedTopics = topicIds
    .map((id) => db.prepare<{ name: string; display_name: string }, [number]>(
      `SELECT name, display_name FROM youtube_topics WHERE id = ?`,
    ).get(id))
    .filter((r): r is { name: string; display_name: string } =>
      !!r?.display_name && !isNonTopic(r.name) && !isNonTopic(r.display_name));
  return seedTopics.slice(0, maxCalls).map((t) => ({ key: `profile:${t.display_name.toLowerCase()}`, display_name: t.display_name }));
}

/**
 * Graph-based fan-out: for the user's highest-relevance recently-processed
 * videos, pull their topic-graph neighbors (videos sharing topics). These are
 * strong candidates — same knowledge neighborhood, often not yet seen. Zero
 * quota: pure local-graph queries.
 *
 * `seedVideoIds` should be a handful of recently-watched high-interest videos.
 */
export function gatherRelated(seedVideoIds: string[], maxPerSeed = 5): number {
  let found = 0;
  for (const seedId of seedVideoIds) {
    let related;
    try {
      related = getRelatedVideos(seedId, maxPerSeed);
    } catch (err) {
      log.warn("getRelatedVideos failed", { seedId, error: String(err) });
      continue;
    }
    for (const r of related) {
      const inserted = insertCandidate({
        videoId: r.video_id,
        title: r.title,
        channelId: null,
        source: "related",
        sourceDetail: `neighbor of ${seedId}: ${r.shared_topics.slice(0, 60)}`,
      });
      if (inserted) found++;
    }
  }
  log.info("gatherRelated complete", { seeds: seedVideoIds.length, found });
  return found;
}

/**
 * Pick a few high-interest recently-processed videos to use as graph fan-out
 * seeds. These are the videos most strongly connected to the user's profile.
 */
export function pickRelatedSeeds(limit = 3): string[] {
  const db = getDb();
  const rows = db
    .prepare<{ video_id: string }, [number]>(
      `SELECT v.video_id
       FROM youtube_videos v
       JOIN youtube_topic_links tl ON tl.video_id = v.video_id
       JOIN discovery_interest_weights w ON w.topic_id = tl.topic_id AND w.weight > 0
       GROUP BY v.video_id
       ORDER BY MAX(w.weight) DESC, v.processed_at DESC
       LIMIT ?`,
    )
    .all(limit) as { video_id: string }[];
  return rows.map((r) => r.video_id);
}

// Re-export the type so callers don't need a second import path.
export type { DiscoveryCandidate };
