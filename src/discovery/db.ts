import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("discovery:db");

// --- Types ---
//
// The discovery_channels half of this store (types + CRUD + history seeding)
// moved to db-channels.ts, and the persisted news items to db-news.ts — this
// file was 642 physical lines (cap 500). Both are re-exported below so
// existing `./db.ts` importers keep their import path.

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

/**
 * The candidates one discovery run should score: never-scored rows first
 * (newest discovered first), plus up to `rescoreSlots` of the best
 * already-scored rows so strong candidates that missed a pick slot compete
 * again under the current profile. Unused slots on either side go to the other.
 *
 * Replaces getCandidatesByStatus("candidate", 200), which ordered by
 * COALESCE(score, 0) DESC and so re-scored the same top rows every run while
 * ~12.5k never-scored candidates waited until they expired (2026-09-25).
 */
export function getScoringQueue(limit = 200, rescoreSlots = 50): DiscoveryCandidate[] {
  const db = getDb();
  const topScored = (n: number) =>
    db
      .prepare<DiscoveryCandidate, [number]>(
        `SELECT * FROM discovery_candidates WHERE status = 'candidate' AND score IS NOT NULL
         ORDER BY score DESC, discovered_at DESC LIMIT ?`,
      )
      .all(n);
  const rescore = topScored(Math.min(rescoreSlots, limit));
  // Titleless rows can't be embedded, so they'd hold a slot every run; they
  // stay 'candidate' until expireStaleCandidates() retires them.
  const unscored = db
    .prepare<DiscoveryCandidate, [number]>(
      `SELECT * FROM discovery_candidates
        WHERE status = 'candidate' AND score IS NULL
          AND title IS NOT NULL AND length(trim(title)) >= 3
        ORDER BY discovered_at DESC, id DESC LIMIT ?`,
    )
    .all(limit - rescore.length);
  if (unscored.length + rescore.length >= limit) return [...unscored, ...rescore];
  // Unscored backlog is short: top up with more previously-scored rows.
  return [...unscored, ...topScored(limit - unscored.length)];
}

export const ALREADY_IN_LIBRARY_REASON = "already_in_library";

/**
 * Reject queued candidates whose video is already in youtube_videos (mostly RSS
 * re-finds of videos David sent himself). Left queued, one could pass the gate:
 * processAndStoreVideo() returns the existing row, the digest surfaces it as a
 * discovery, and the profile's provenance rule then drops its user-chosen weight.
 * Updates by row id so other rows for the same video keep their status.
 */
export function rejectCandidatesAlreadyInLibrary(): number {
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE discovery_candidates
          SET status = 'rejected', reason = ?
        WHERE id IN (
          SELECT dc.id FROM discovery_candidates dc
           WHERE dc.status = 'candidate'
             AND EXISTS (SELECT 1 FROM youtube_videos yv WHERE yv.video_id = dc.video_id)
        )`,
    )
    .run(ALREADY_IN_LIBRARY_REASON);
  return result.changes;
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

// --- Re-exports (split modules; see header note) ---

export * from "./db-channels.ts";
export * from "./db-news.ts";

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
