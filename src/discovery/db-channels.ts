// db-channels.ts — the discovery_channels half of the discovery store, split
// from db.ts (which was 642 physical lines; cap 500). db.ts re-exports this
// module's surface so existing `./db.ts` importers keep their import path.

import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("discovery:db");

// --- Types ---

export type ChannelOrigin = "history" | "manual" | "discovered";

export interface DiscoveryChannel {
  id: number;
  channel_id: string;
  channel_title: string;
  origin: ChannelOrigin;
  watch_count: number;
  last_polled_at: string | null;
  created_at: string;
}

// --- Channels ---

export function upsertChannel(params: {
  channelId: string;
  channelTitle: string;
  origin?: ChannelOrigin;
  watchCount?: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO discovery_channels (channel_id, channel_title, origin, watch_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       channel_title = COALESCE(excluded.channel_title, discovery_channels.channel_title),
       watch_count = MAX(discovery_channels.watch_count, excluded.watch_count)`,
  ).run(
    params.channelId,
    params.channelTitle,
    params.origin ?? "manual",
    params.watchCount ?? 0,
  );
}

export function getChannel(channelId: string): DiscoveryChannel | null {
  const db = getDb();
  return db
    .prepare<DiscoveryChannel, [string]>(
      `SELECT * FROM discovery_channels WHERE channel_id = ?`,
    )
    .get(channelId) ?? null;
}

export function listChannels(origin?: ChannelOrigin): DiscoveryChannel[] {
  const db = getDb();
  if (origin) {
    return db
      .prepare<DiscoveryChannel, [ChannelOrigin]>(
        `SELECT * FROM discovery_channels WHERE origin = ? ORDER BY watch_count DESC, channel_title ASC`,
      )
      .all(origin);
  }
  return db
    .prepare<DiscoveryChannel, []>(
      `SELECT * FROM discovery_channels ORDER BY watch_count DESC, channel_title ASC`,
    )
    .all();
}

export function markChannelPolled(channelId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE discovery_channels SET last_polled_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE channel_id = ?`,
  ).run(channelId);
}

/**
 * Seed discovery_channels from the user's existing youtube_videos history.
 * Resolves channel_id via a single batched videos.list call (1 quota unit per
 * 50 videos) rather than one yt-dlp subprocess per channel — the latter hangs
 * for 15+ minutes on a large library. Returns counts so the caller can log.
 */
export async function seedChannelsFromHistory(): Promise<{
  channelsAdded: number;
  channelsUpdated: number;
  unresolved: number;
}> {
  const db = getDb();

  // channel_title -> count of the user's videos from that channel
  const rows = db
    .prepare<{ channel_title: string; count: number }, []>(
      `SELECT channel_title, COUNT(*) as count
       FROM youtube_videos
       WHERE channel_title IS NOT NULL AND channel_title != ''
       GROUP BY channel_title`,
    )
    .all();

  const existing = new Map(
    listChannels().map((c) => [c.channel_title.toLowerCase(), c]),
  );

  // Channels that already have a channel_id: just refresh watch_count.
  let updated = 0;
  const needResolution: Array<{ channelTitle: string; count: number; sampleVideoId: string }> = [];
  for (const row of rows) {
    const existingChan = existing.get(row.channel_title.toLowerCase());
    if (existingChan?.channel_id) {
      if (existingChan.watch_count < row.count) {
        upsertChannel({
          channelId: existingChan.channel_id,
          channelTitle: row.channel_title,
          origin: existingChan.origin,
          watchCount: row.count,
        });
        updated++;
      }
      continue;
    }
    // Need a channel_id — pick one sample video to resolve it from.
    const sample = db
      .prepare<{ video_id: string }, [string]>(
        `SELECT video_id FROM youtube_videos WHERE channel_title = ? LIMIT 1`,
      )
      .get(row.channel_title);
    if (sample) {
      needResolution.push({ channelTitle: row.channel_title, count: row.count, sampleVideoId: sample.video_id });
    }
  }

  if (needResolution.length === 0) {
    log.info("Channel seed: nothing to resolve", { updated, totalChannels: rows.length });
    return { channelsAdded: 0, channelsUpdated: updated, unresolved: 0 };
  }

  // Batch-resolve channel_ids: one videos.list call per 50 video IDs
  // (1 quota unit each). videoId -> channelId.
  const videoToChannel = new Map<string, string>();
  const sampleIds = needResolution.map((r) => r.sampleVideoId);
  let added = 0;
  let unresolved = 0;

  try {
    // Dynamic on purpose: a static import would make the discovery store's
    // module load pull the YouTube API client (OAuth/config) even when no
    // seeding ever runs, and only this late path needs it.
    const { getVideoStats } = await import("../youtube/api.ts");
    for (let i = 0; i < sampleIds.length; i += 50) {
      const batch = sampleIds.slice(i, i + 50);
      const stats = await getVideoStats(batch);
      for (const s of stats) {
        if (s.channelId) videoToChannel.set(s.videoId, s.channelId);
      }
    }
  } catch (err) {
    // API failure (e.g. OAuth expired) — fall back gracefully. Channels get
    // inserted with a placeholder so RSS polling can't run for them, but the
    // rest of discovery proceeds. They'll be resolved on a later seed run.
    log.warn("Batch channel_id resolution failed — channels left unresolved", {
      error: err instanceof Error ? err.message : String(err),
      needResolution: needResolution.length,
    });
  }

  for (const r of needResolution) {
    const channelId = videoToChannel.get(r.sampleVideoId);
    if (!channelId) {
      unresolved++;
      continue;
    }
    upsertChannel({
      channelId,
      channelTitle: r.channelTitle,
      origin: "history",
      watchCount: r.count,
    });
    added++;
  }

  log.info("Seeded discovery channels from history", {
    added, updated, unresolved, totalChannels: rows.length,
  });
  return { channelsAdded: added, channelsUpdated: updated, unresolved };
}
