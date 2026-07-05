import { createLogger } from "../shared/logger.ts";
import { fetchChannelFeed, type FeedEntry } from "./rss.ts";
import {
  listChannels,
  markChannelPolled,
  insertCandidate,
  hasVideoBeenSeen,
  type DiscoveryChannel,
  type CandidateSource,
} from "./db.ts";
import { getUploadsPlaylistId, listUploads, type SearchResult } from "../youtube/api.ts";

const log = createLogger("discovery:channels");

/**
 * Cap on how far back to reach when backfilling a channel's uploads. RSS gives
 * only the latest 15, so when we want to mine a channel harder we paginate its
 * uploads playlist — but never past this many to bound the 1-unit/page cost.
 */
const MAX_BACKFILL_PER_CHANNEL = 30;

export interface PollResult {
  channelsPolled: number;
  newCandidates: number;
  errors: number;
}

/**
 * Poll RSS feeds for every monitored channel. Zero quota — this is the
 * always-on baseline that catches fresh uploads from channels you already like.
 * New video ids become 'candidate' rows; already-seen ids are skipped.
 *
 * Fetching (the slow network part) runs with bounded concurrency; DB writes
 * happen sequentially afterward, since bun:sqlite uses a single connection
 * and concurrent writes would collide ("database is locked").
 */
export async function pollRssFeeds(maxChannels = 500, concurrency = 8): Promise<PollResult> {
  const channels = listChannels().slice(0, maxChannels);
  const fetched: Array<{ channel: DiscoveryChannel; entries: FeedEntry[] }> = [];
  let errors = 0;

  // Phase 1 — bounded-concurrency network fetch (no DB access here).
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, channels.length) }, async () => {
      while (cursor < channels.length) {
        const channel = channels[cursor++];
        try {
          const entries = await fetchChannelFeed(channel.channel_id);
          fetched.push({ channel, entries });
        } catch (err) {
          errors++;
          log.warn("RSS poll failed", {
            channelId: channel.channel_id,
            channel: channel.channel_title,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );

  // Phase 2 — sequential DB writes (safe on the single sqlite connection).
  let newCandidates = 0;
  for (const { channel, entries } of fetched) {
    for (const entry of entries) {
      const inserted = insertCandidate({
        videoId: entry.videoId,
        channelId: channel.channel_id,
        title: entry.title,
        publishedAt: entry.publishedAt,
        source: "rss",
        sourceDetail: channel.channel_title,
      });
      if (inserted) newCandidates++;
    }
    markChannelPolled(channel.channel_id);
  }

  log.info("RSS poll complete", {
    channelsPolled: fetched.length,
    newCandidates,
    errors,
  });
  return { channelsPolled: fetched.length, newCandidates, errors };
}

/**
 * Backfill recent uploads for a channel via its uploads playlist.
 * Cheap (1 quota unit per 50 videos) — the quota-friendly alternative to
 * search.list?channelId=. Returns the count of newly-inserted candidates.
 *
 * Use sparingly (e.g. for a few high-affinity channels per run) since each
 * channel costs ≥1 unit even if it returns nothing.
 */
export async function backfillChannelUploads(
  channel: DiscoveryChannel,
  maxResults = MAX_BACKFILL_PER_CHANNEL,
): Promise<number> {
  let uploadsPlaylistId: string | null;
  try {
    uploadsPlaylistId = await getUploadsPlaylistId(channel.channel_id);
  } catch (err) {
    log.warn("getUploadsPlaylistId failed", {
      channelId: channel.channel_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  if (!uploadsPlaylistId) return 0;

  let uploads: SearchResult[];
  try {
    uploads = await listUploads(uploadsPlaylistId, maxResults);
  } catch (err) {
    log.warn("listUploads failed", {
      channelId: channel.channel_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }

  let inserted = 0;
  for (const v of uploads) {
    const isNew = insertCandidate({
      videoId: v.videoId,
      channelId: v.channelId || channel.channel_id,
      title: v.title,
      publishedAt: v.publishedAt,
      source: "channel",
      sourceDetail: channel.channel_title,
    });
    if (isNew) inserted++;
  }

  log.info("Backfilled channel uploads", {
    channel: channel.channel_title,
    found: uploads.length,
    inserted,
  });
  return inserted;
}

/**
 * Insert a single candidate manually (e.g. from a `related` graph fan-out or
 * the agent tool). Returns true if it was newly inserted.
 */
export function addCandidate(
  videoId: string,
  source: CandidateSource,
  detail?: {
    channelId?: string | null;
    title?: string | null;
    publishedAt?: string | null;
    sourceDetail?: string | null;
    viewCount?: number | null;
    durationSeconds?: number | null;
  },
): boolean {
  if (hasVideoBeenSeen(videoId)) return false;
  return insertCandidate({ videoId, source, ...detail });
}
