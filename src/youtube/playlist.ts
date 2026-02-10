import { createLogger } from "../shared/logger.ts";
import { getConfig } from "../config.ts";
import {
  listPlaylistItems,
  removeFromPlaylist,
  addToPlaylist,
} from "./api.ts";
import {
  getVideo,
  updateVideoProcessingStatus,
  getVideosNeedingPlaylistUpdate,
} from "./db.ts";
import { processAndStoreVideo } from "./process.ts";

const log = createLogger("youtube:playlist");

export interface PlaylistProcessingResult {
  processed: number;
  skipped: number;
  failed: number;
  moved: number;
  retrySuccesses: number;
  retryFailures: number;
  errors: Array<{ videoId: string; error: string }>;
}

export interface PlaylistProcessingOptions {
  sourcePlaylistId?: string;
  destinationPlaylistId?: string;
  limit?: number;
  retryFailed?: boolean;
}

export async function processPlaylist(
  options: PlaylistProcessingOptions = {}
): Promise<PlaylistProcessingResult> {
  const config = getConfig();
  const sourcePlaylistId = options.sourcePlaylistId || config.YOUTUBE_SOURCE_PLAYLIST_ID;
  const destinationPlaylistId = options.destinationPlaylistId || config.YOUTUBE_DESTINATION_PLAYLIST_ID;
  const limit = options.limit ?? 50;
  const retryFailed = options.retryFailed ?? true;

  if (!sourcePlaylistId) {
    throw new Error("No source playlist ID configured. Set YOUTUBE_SOURCE_PLAYLIST_ID or pass source_playlist_id.");
  }

  const result: PlaylistProcessingResult = {
    processed: 0,
    skipped: 0,
    failed: 0,
    moved: 0,
    retrySuccesses: 0,
    retryFailures: 0,
    errors: [],
  };

  // Phase 1: Retry previously failed playlist moves
  if (retryFailed) {
    const needsUpdate = getVideosNeedingPlaylistUpdate();
    const failedMoves = needsUpdate.filter((v) => v.processing_status === "failed_to_mark");

    if (failedMoves.length > 0) {
      log.info("Retrying failed playlist moves", { count: failedMoves.length });

      for (const video of failedMoves) {
        try {
          await moveVideo(video.video_id, video.playlist_item_id, destinationPlaylistId);
          updateVideoProcessingStatus(video.video_id, "marked_processed");
          result.retrySuccesses++;
          log.info("Retry move succeeded", { videoId: video.video_id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateVideoProcessingStatus(video.video_id, "failed_to_mark");
          result.retryFailures++;
          log.error("Retry move failed", { videoId: video.video_id, error: message });
        }
      }
    }
  }

  // Phase 2: Fetch playlist items from source playlist
  log.info("Fetching playlist items", { sourcePlaylistId });
  const items = await listPlaylistItems(sourcePlaylistId);

  if (items.length === 0) {
    log.info("No items in source playlist");
    return result;
  }

  const itemsToProcess = items.slice(0, limit);
  log.info("Processing playlist items", { total: items.length, processing: itemsToProcess.length });

  // Phase 3: Process each video sequentially
  for (const item of itemsToProcess) {
    const videoId = item.snippet.resourceId.videoId;
    const playlistItemId = item.id;

    try {
      // Check if already in DB
      const existing = getVideo(videoId);
      if (existing && existing.processing_status === "marked_processed") {
        // Already fully processed, just remove from source playlist
        try {
          await removeFromPlaylist(playlistItemId);
          result.skipped++;
          log.info("Already processed, removed from source", { videoId });
        } catch {
          result.skipped++;
          log.info("Already processed", { videoId });
        }
        continue;
      }

      if (existing && existing.processing_status === "complete") {
        // Analyzed but not moved yet, just move it
        updateVideoProcessingStatus(videoId, "analyzed", playlistItemId);
        try {
          await moveVideo(videoId, playlistItemId, destinationPlaylistId);
          updateVideoProcessingStatus(videoId, "marked_processed");
          result.moved++;
          log.info("Existing video moved to destination", { videoId });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateVideoProcessingStatus(videoId, "failed_to_mark");
          result.errors.push({ videoId, error: `Move failed: ${message}` });
          log.error("Failed to move existing video", { videoId, error: message });
        }
        continue;
      }

      // Process the video
      updateVideoProcessingStatus(videoId, "processing", playlistItemId);
      const processResult = await processAndStoreVideo(videoId, {
        playlistItemId,
        processingStatus: "analyzed",
      });

      if (processResult.skipped) {
        result.skipped++;
        continue;
      }

      result.processed++;

      // Move to destination playlist
      try {
        await moveVideo(videoId, playlistItemId, destinationPlaylistId);
        updateVideoProcessingStatus(videoId, "marked_processed");
        result.moved++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateVideoProcessingStatus(videoId, "failed_to_mark");
        result.errors.push({ videoId, error: `Move failed: ${message}` });
        log.error("Failed to move video", { videoId, error: message });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateVideoProcessingStatus(videoId, "failed");
      result.failed++;
      result.errors.push({ videoId, error: message });
      log.error("Failed to process video", { videoId, error: message });
    }
  }

  log.info("Playlist processing complete", {
    processed: result.processed,
    skipped: result.skipped,
    failed: result.failed,
    moved: result.moved,
    retrySuccesses: result.retrySuccesses,
    retryFailures: result.retryFailures,
  });

  return result;
}

async function moveVideo(
  videoId: string,
  playlistItemId: string | null,
  destinationPlaylistId: string
): Promise<void> {
  // Add to destination first
  if (destinationPlaylistId) {
    await addToPlaylist(destinationPlaylistId, videoId);
  }

  // Then remove from source
  if (playlistItemId) {
    await removeFromPlaylist(playlistItemId);
  }
}
