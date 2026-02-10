import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import type { ParsedTranscript } from "./analyzer.ts";

const log = createLogger("youtube:db");

export type VideoProcessingStatus =
  | "pending"
  | "processing"
  | "analyzed"
  | "complete"
  | "marked_processed"
  | "failed_to_mark"
  | "failed";

export interface StoredVideo {
  id: number;
  video_id: string;
  title: string;
  channel_title: string;
  url: string;
  tags: string;
  markdown_summary: string;
  analysis_json: string;
  transcript_text: string;
  processing_status: VideoProcessingStatus;
  playlist_item_id: string | null;
  marking_attempts: number;
  last_mark_attempt_at: string | null;
  processed_at: string;
  created_at: string;
}

export interface VecSearchResult {
  video_id: string;
  title: string;
  channel_title: string;
  chunk_type: string;
  chunk_text: string;
  distance: number;
}

// --- Insert ---

export function insertVideo(params: {
  videoId: string;
  title: string;
  channelTitle: string;
  tags: string[];
  markdownSummary: string;
  analysis: ParsedTranscript;
  transcriptText: string;
  processingStatus?: VideoProcessingStatus;
  playlistItemId?: string;
}): StoredVideo {
  const db = getDb();
  return db
    .prepare<StoredVideo, [string, string, string, string, string, string, string, string, string, string | null]>(
      `INSERT INTO youtube_videos (video_id, title, channel_title, url, tags, markdown_summary, analysis_json, transcript_text, processing_status, playlist_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         title = excluded.title,
         channel_title = excluded.channel_title,
         tags = excluded.tags,
         markdown_summary = excluded.markdown_summary,
         analysis_json = excluded.analysis_json,
         transcript_text = excluded.transcript_text,
         processing_status = excluded.processing_status,
         playlist_item_id = COALESCE(excluded.playlist_item_id, youtube_videos.playlist_item_id),
         processed_at = datetime('now')
       RETURNING *`
    )
    .get(
      params.videoId,
      params.title,
      params.channelTitle,
      `https://youtube.com/watch?v=${params.videoId}`,
      JSON.stringify(params.tags),
      params.markdownSummary,
      JSON.stringify(params.analysis),
      params.transcriptText,
      params.processingStatus ?? "complete",
      params.playlistItemId ?? null
    )!;
}

/**
 * Insert a chunk into youtube_chunks and its embedding into youtube_vec.
 * The chunk row ID is used as the vec rowid so they stay in sync.
 */
export function insertChunk(params: {
  videoId: string;
  chunkType: string;
  chunkText: string;
  embedding: Float32Array;
}): void {
  const db = getDb();

  const chunk = db
    .prepare<{ id: number }, [string, string, string]>(
      `INSERT INTO youtube_chunks (video_id, chunk_type, chunk_text) VALUES (?, ?, ?) RETURNING id`
    )
    .get(params.videoId, params.chunkType, params.chunkText)!;

  db.prepare(
    `INSERT INTO youtube_vec (rowid, embedding) VALUES (?, ?)`
  ).run(BigInt(chunk.id), params.embedding);
}

/**
 * Delete all chunks and embeddings for a video (used before re-inserting).
 */
export function deleteVideoChunks(videoId: string): void {
  const db = getDb();

  // Get chunk IDs to delete from vec table
  const chunks = db
    .prepare<{ id: number }, [string]>(`SELECT id FROM youtube_chunks WHERE video_id = ?`)
    .all(videoId);

  if (chunks.length > 0) {
    for (const chunk of chunks) {
      db.prepare(`DELETE FROM youtube_vec WHERE rowid = ?`).run(BigInt(chunk.id));
    }
    db.prepare(`DELETE FROM youtube_chunks WHERE video_id = ?`).run(videoId);
  }
}

// --- Query ---

export function getVideo(videoId: string): StoredVideo | null {
  const db = getDb();
  return db
    .prepare<StoredVideo, [string]>(`SELECT * FROM youtube_videos WHERE video_id = ?`)
    .get(videoId) ?? null;
}

export function listVideos(params?: {
  keyword?: string;
  channel?: string;
  limit?: number;
}): StoredVideo[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: (string | number)[] = [];

  if (params?.keyword) {
    conditions.push(`(title LIKE ? OR tags LIKE ? OR markdown_summary LIKE ?)`);
    const pattern = `%${params.keyword}%`;
    values.push(pattern, pattern, pattern);
  }

  if (params?.channel) {
    conditions.push(`channel_title LIKE ?`);
    values.push(`%${params.channel}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params?.limit ?? 50;
  values.push(limit);

  return db
    .prepare<StoredVideo, (string | number)[]>(
      `SELECT * FROM youtube_videos ${where} ORDER BY processed_at DESC LIMIT ?`
    )
    .all(...values);
}

/**
 * Vector similarity search across all video chunks.
 * Returns the top-k most similar chunks with their video metadata.
 */
export function vectorSearch(queryEmbedding: Float32Array, limit: number = 10): VecSearchResult[] {
  const db = getDb();

  const rows = db
    .prepare<
      { rowid: number; distance: number },
      [Float32Array, number]
    >(
      `SELECT rowid, distance FROM youtube_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
    )
    .all(queryEmbedding, limit);

  if (rows.length === 0) return [];

  const results: VecSearchResult[] = [];

  for (const row of rows) {
    const chunk = db
      .prepare<
        { video_id: string; chunk_type: string; chunk_text: string },
        [number]
      >(
        `SELECT video_id, chunk_type, chunk_text FROM youtube_chunks WHERE id = ?`
      )
      .get(row.rowid);

    if (!chunk) continue;

    const video = db
      .prepare<
        { title: string; channel_title: string },
        [string]
      >(
        `SELECT title, channel_title FROM youtube_videos WHERE video_id = ?`
      )
      .get(chunk.video_id);

    if (!video) continue;

    results.push({
      video_id: chunk.video_id,
      title: video.title,
      channel_title: video.channel_title,
      chunk_type: chunk.chunk_type,
      chunk_text: chunk.chunk_text,
      distance: row.distance,
    });
  }

  return results;
}

export function getVideoCount(): number {
  const db = getDb();
  const row = db.prepare<{ count: number }, []>(`SELECT COUNT(*) as count FROM youtube_videos`).get();
  return row?.count ?? 0;
}

// --- Processing status ---

export function updateVideoProcessingStatus(
  videoId: string,
  status: VideoProcessingStatus,
  playlistItemId?: string
): void {
  const db = getDb();
  if (status === "failed_to_mark") {
    db.prepare(
      `UPDATE youtube_videos SET processing_status = ?, marking_attempts = marking_attempts + 1, last_mark_attempt_at = datetime('now') WHERE video_id = ?`
    ).run(status, videoId);
  } else if (playlistItemId) {
    db.prepare(
      `UPDATE youtube_videos SET processing_status = ?, playlist_item_id = ? WHERE video_id = ?`
    ).run(status, playlistItemId, videoId);
  } else {
    db.prepare(
      `UPDATE youtube_videos SET processing_status = ? WHERE video_id = ?`
    ).run(status, videoId);
  }
}

export function getVideosNeedingPlaylistUpdate(): StoredVideo[] {
  const db = getDb();
  return db
    .prepare<StoredVideo, []>(
      `SELECT * FROM youtube_videos WHERE processing_status IN ('analyzed', 'failed_to_mark') ORDER BY marking_attempts ASC, processed_at ASC`
    )
    .all();
}

export function getPlaylistProcessingStats(): {
  pending: number;
  processing: number;
  analyzed: number;
  complete: number;
  marked_processed: number;
  failed_to_mark: number;
  failed: number;
} {
  const db = getDb();
  const rows = db
    .prepare<{ processing_status: string; count: number }, []>(
      `SELECT processing_status, COUNT(*) as count FROM youtube_videos GROUP BY processing_status`
    )
    .all();

  const stats = {
    pending: 0,
    processing: 0,
    analyzed: 0,
    complete: 0,
    marked_processed: 0,
    failed_to_mark: 0,
    failed: 0,
  };

  for (const row of rows) {
    const key = row.processing_status as VideoProcessingStatus;
    if (key in stats) {
      stats[key] = row.count;
    }
  }

  return stats;
}
