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

export type CandidateSource = "rss" | "search" | "related" | "channel" | "manual";

export type CandidateStatus =
  | "candidate"
  | "processing"
  | "processed"
  | "rejected"
  | "surfaced"
  | "dismissed";

export interface DiscoveryCandidate {
  id: number;
  video_id: string;
  channel_id: string | null;
  title: string | null;
  published_at: string | null;
  source: CandidateSource;
  source_detail: string | null;
  view_count: number | null;
  duration_seconds: number | null;
  score: number | null;
  score_breakdown_json: string | null;
  status: CandidateStatus;
  reason: string | null;
  discovered_at: string;
  processed_at: string | null;
  surfaced_at: string | null;
}

export interface InterestWeight {
  topic_id: number;
  weight: number;
  last_bumped_at: string;
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

// --- Candidates ---

export function insertCandidate(params: {
  videoId: string;
  channelId?: string | null;
  title?: string | null;
  publishedAt?: string | null;
  source: CandidateSource;
  sourceDetail?: string | null;
  viewCount?: number | null;
  durationSeconds?: number | null;
}): boolean {
  const db = getDb();
  // ON CONFLICT(video_id, source) DO NOTHING — a video seen via the same source
  // before is not re-inserted. Returns true if a new row was created.
  const result = db
    .prepare(
      `INSERT INTO discovery_candidates
         (video_id, channel_id, title, published_at, source, source_detail, view_count, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id, source) DO NOTHING`,
    )
    .run(
      params.videoId,
      params.channelId ?? null,
      params.title ?? null,
      params.publishedAt ?? null,
      params.source,
      params.sourceDetail ?? null,
      params.viewCount ?? null,
      params.durationSeconds ?? null,
    );
  return result.changes > 0;
}

export function updateCandidate(
  candidateId: number,
  updates: Partial<Pick<DiscoveryCandidate,
    | "score" | "score_breakdown_json" | "status" | "reason" | "view_count" | "duration_seconds" | "title" | "channel_id" | "published_at">>,
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    values.push(value as string | number | null);
  }
  if (sets.length === 0) return;
  values.push(candidateId);
  db.prepare(`UPDATE discovery_candidates SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function setCandidateStatus(
  videoId: string,
  status: CandidateStatus,
  extra?: { processedAt?: boolean; surfacedAt?: boolean; reason?: string | null },
): void {
  const db = getDb();
  const sets = ["status = ?"];
  const values: (string | null)[] = [status];
  if (extra?.processedAt) {
    sets.push("processed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
  }
  if (extra?.surfacedAt) {
    sets.push("surfaced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
  }
  if (extra?.reason !== undefined) {
    sets.push("reason = ?");
    values.push(extra.reason);
  }
  values.push(videoId);
  db.prepare(
    `UPDATE discovery_candidates SET ${sets.join(", ")} WHERE video_id = ?`,
  ).run(...values);
}

export function getCandidatesByStatus(status: CandidateStatus, limit = 50): DiscoveryCandidate[] {
  const db = getDb();
  return db
    .prepare<DiscoveryCandidate, [CandidateStatus, number]>(
      `SELECT * FROM discovery_candidates WHERE status = ? ORDER BY COALESCE(score, 0) DESC, discovered_at DESC LIMIT ?`,
    )
    .all(status, limit);
}

export function getTopUnscoredCandidates(limit = 50): DiscoveryCandidate[] {
  const db = getDb();
  return db
    .prepare<DiscoveryCandidate, [number]>(
      `SELECT * FROM discovery_candidates WHERE status = 'candidate' AND score IS NULL
       ORDER BY discovered_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function getTopScoredCandidates(limit = 50): DiscoveryCandidate[] {
  const db = getDb();
  return db
    .prepare<DiscoveryCandidate, [number]>(
      `SELECT * FROM discovery_candidates WHERE status = 'candidate' AND score IS NOT NULL
       ORDER BY score DESC LIMIT ?`,
    )
    .all(limit);
}

/**
 * Mark stale, never-processed candidates as 'rejected' (tagged via `reason`)
 * so they stop counting toward the ever-growing 'candidate' pool. There is no
 * dedicated 'expired' status in the discovery_candidates CHECK constraint
 * (src/db/schema.ts), so this reuses 'rejected' with a distinguishing
 * `expired_stale:` reason prefix rather than widening the schema's enum.
 * Cheap: a single indexed UPDATE by status + discovered_at.
 */
export function expireStaleCandidates(maxAgeDays = 30): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 86400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const result = db
    .prepare(
      `UPDATE discovery_candidates
          SET status = 'rejected', reason = ?
        WHERE status = 'candidate' AND discovered_at < ?`,
    )
    .run(`expired_stale: never processed within ${maxAgeDays}d`, cutoff);
  return result.changes;
}

/**
 * Cap the total number of retained expired-stale rows, deleting the oldest
 * ones beyond `keep`. Runs after expireStaleCandidates() so the table doesn't
 * grow unbounded forever just because rows were relabeled instead of removed.
 */
export function pruneExpiredCandidates(keep = 2000): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM discovery_candidates
        WHERE reason LIKE 'expired_stale:%'
          AND id NOT IN (
            SELECT id FROM discovery_candidates
             WHERE reason LIKE 'expired_stale:%'
             ORDER BY discovered_at DESC
             LIMIT ?
          )`,
    )
    .run(keep);
  return result.changes;
}

/** Has this video been seen as a candidate (any source) or already processed? */
export function hasVideoBeenSeen(videoId: string): boolean {
  const db = getDb();
  const row = db
    .prepare<{ c: number }, [string]>(
      `SELECT COUNT(*) as c FROM discovery_candidates WHERE video_id = ?`,
    )
    .get(videoId);
  return (row?.c ?? 0) > 0;
}

// --- Interest weights ---

export function setInterestWeight(topicId: number, weight: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO discovery_interest_weights (topic_id, weight, last_bumped_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(topic_id) DO UPDATE SET weight = excluded.weight, last_bumped_at = excluded.last_bumped_at`,
  ).run(topicId, weight);
}

export function clearInterestWeights(): void {
  const db = getDb();
  db.prepare(`DELETE FROM discovery_interest_weights`).run();
}

export function getInterestWeights(): InterestWeight[] {
  const db = getDb();
  return db
    .prepare<InterestWeight, []>(
      `SELECT * FROM discovery_interest_weights WHERE weight > 0 ORDER BY weight DESC`,
    )
    .all();
}

export function getInterestProfileSize(): number {
  const db = getDb();
  const row = db
    .prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM discovery_interest_weights WHERE weight > 0`)
    .get();
  return row?.c ?? 0;
}

// --- State key/value ---

export function getState(key: string): string | null {
  const db = getDb();
  const row = db
    .prepare<{ value: string }, [string]>(`SELECT value FROM discovery_state WHERE key = ?`)
    .get(key);
  return row?.value ?? null;
}

export function setState(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO discovery_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// --- Runs ---

export function startRun(): number {
  const db = getDb();
  const row = db
    .prepare<{ id: number }, [string]>(
      `INSERT INTO discovery_runs (started_at) VALUES (strftime('%Y-%m-%dT%H:%M:%SZ','now')) RETURNING id`,
    )
    .get(new Date().toISOString())!;
  return row.id;
}

export function completeRun(
  runId: number,
  stats: {
    channelsPolled?: number;
    searchesRun?: number;
    quotaUnitsUsed?: number;
    candidatesFound?: number;
    processed?: number;
    surfaced?: number;
    error?: string | null;
  },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE discovery_runs SET
       completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       channels_polled = COALESCE(?, channels_polled),
       searches_run = COALESCE(?, searches_run),
       quota_units_used = COALESCE(?, quota_units_used),
       candidates_found = COALESCE(?, candidates_found),
       processed = COALESCE(?, processed),
       surfaced = COALESCE(?, surfaced),
       error = COALESCE(?, error)
     WHERE id = ?`,
  ).run(
    stats.channelsPolled ?? null,
    stats.searchesRun ?? null,
    stats.quotaUnitsUsed ?? null,
    stats.candidatesFound ?? null,
    stats.processed ?? null,
    stats.surfaced ?? null,
    stats.error ?? null,
    runId,
  );
}

// --- News items (persisted mineNews() output) ---
//
// mineNews() (src/discovery/news.ts) previously produced ephemeral output —
// surfaced to Telegram once, then lost. This table persists it so the weekly
// digest (src/digest/compose.ts) can pull the week's mined news highlights.
// Created lazily here (not in src/db/schema.ts's central migrations list) to
// keep the discovery subsystem's storage self-contained, matching this
// module's existing pattern of owning its own tables end-to-end.

let newsTableReady = false;

function ensureNewsItemsTable(): void {
  if (newsTableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT NOT NULL,
      what TEXT NOT NULL DEFAULT '',
      why_it_matters TEXT NOT NULL DEFAULT '',
      source_video_ids TEXT NOT NULL DEFAULT '[]',
      novelty REAL NOT NULL DEFAULT 0,
      video_count INTEGER NOT NULL DEFAULT 1,
      mined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_discovery_news_items_mined_at ON discovery_news_items(mined_at)`,
  );
  newsTableReady = true;
}

export interface PersistedNewsItem {
  id: number;
  headline: string;
  what: string;
  why_it_matters: string;
  source_video_ids: string;
  novelty: number;
  video_count: number;
  mined_at: string;
}

export function insertNewsItem(item: {
  headline: string;
  what: string;
  whyItMatters: string;
  sourceVideos: Array<{ videoId: string; title: string; channel: string }>;
  novelty: number;
  videoCount: number;
}): void {
  ensureNewsItemsTable();
  const db = getDb();
  db.prepare(
    `INSERT INTO discovery_news_items
       (headline, what, why_it_matters, source_video_ids, novelty, video_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    item.headline,
    item.what,
    item.whyItMatters,
    JSON.stringify(item.sourceVideos),
    item.novelty,
    item.videoCount,
  );
}

/** Mined news items with mined_at >= windowStart, newest first. */
export function getRecentNewsItems(windowStart: string, limit = 20): PersistedNewsItem[] {
  ensureNewsItemsTable();
  const db = getDb();
  return db
    .prepare<PersistedNewsItem, [string, number]>(
      `SELECT * FROM discovery_news_items WHERE mined_at >= ? ORDER BY mined_at DESC LIMIT ?`,
    )
    .all(windowStart, limit);
}

export function getRecentRuns(limit = 10): Array<{
  id: number;
  started_at: string;
  completed_at: string | null;
  channels_polled: number;
  searches_run: number;
  candidates_found: number;
  processed: number;
  surfaced: number;
}> {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, started_at, completed_at, channels_polled, searches_run,
              candidates_found, processed, surfaced
       FROM discovery_runs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    started_at: string;
    completed_at: string | null;
    channels_polled: number;
    searches_run: number;
    candidates_found: number;
    processed: number;
    surfaced: number;
  }>;
}
