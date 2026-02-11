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

export interface VideoDetail {
  videoId: string;
  title: string;
  status: "processed" | "skipped" | "moved" | "failed_to_move" | "failed";
}

export interface PlaylistProcessingResult {
  processed: number;
  skipped: number;
  failed: number;
  moved: number;
  retrySuccesses: number;
  retryFailures: number;
  errors: Array<{ videoId: string; error: string }>;
  details: VideoDetail[];
}

export interface PlaylistProcessingOptions {
  sourcePlaylistId?: string;
  destinationPlaylistId?: string;
  limit?: number;
  retryFailed?: boolean;
  model?: string;
  onProgress?: (message: string) => Promise<void>;
}

export async function processPlaylist(
  options: PlaylistProcessingOptions = {}
): Promise<PlaylistProcessingResult> {
  const config = getConfig();
  const sourcePlaylistId = options.sourcePlaylistId || config.YOUTUBE_SOURCE_PLAYLIST_ID;
  const destinationPlaylistId = options.destinationPlaylistId || config.YOUTUBE_DESTINATION_PLAYLIST_ID;
  const limit = options.limit ?? 50;
  const retryFailed = options.retryFailed ?? false;

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
    details: [],
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

  const notify = options.onProgress ?? (async () => {});
  await notify(`Found ${itemsToProcess.length} video${itemsToProcess.length === 1 ? "" : "s"} to process`);

  // Phase 3: Process each video sequentially
  let idx = 0;
  for (const item of itemsToProcess) {
    idx++;
    const videoId = item.snippet.resourceId.videoId;
    const playlistItemId = item.id;
    const videoTitle = item.snippet.title ?? videoId;
    await notify(`(${idx}/${itemsToProcess.length}) Processing: ${videoTitle}`);

    try {
      // Check if already in DB
      const existing = getVideo(videoId);
      if (existing && existing.processing_status === "marked_processed") {
        // Already fully processed, just remove from source playlist
        try {
          await removeFromPlaylist(playlistItemId);
        } catch { /* ignore */ }
        result.skipped++;
        result.details.push({ videoId, title: existing.title, status: "skipped" });
        await notify(`(${idx}/${itemsToProcess.length}) Skipped: ${existing.title}`);
        log.info("Already processed", { videoId });
        continue;
      }

      if (existing && existing.processing_status === "complete") {
        // Analyzed but not moved yet, just move it
        updateVideoProcessingStatus(videoId, "analyzed", playlistItemId);
        try {
          await moveVideo(videoId, playlistItemId, destinationPlaylistId);
          updateVideoProcessingStatus(videoId, "marked_processed");
          result.moved++;
          result.details.push({ videoId, title: existing.title, status: "moved" });
          await notify(`(${idx}/${itemsToProcess.length}) Moved: ${existing.title}`);
          log.info("Existing video moved to destination", { videoId });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          updateVideoProcessingStatus(videoId, "failed_to_mark");
          result.errors.push({ videoId, error: `Move failed: ${message}` });
          result.details.push({ videoId, title: existing.title, status: "failed_to_move" });
          await notify(`(${idx}/${itemsToProcess.length}) Move failed: ${existing.title}`);
          log.error("Failed to move existing video", { videoId, error: message });
        }
        continue;
      }

      // Process the video
      updateVideoProcessingStatus(videoId, "processing", playlistItemId);
      const processResult = await processAndStoreVideo(videoId, {
        playlistItemId,
        processingStatus: "analyzed",
        model: options.model,
      });

      if (processResult.skipped) {
        result.skipped++;
        result.details.push({ videoId, title: processResult.title, status: "skipped" });
        await notify(`(${idx}/${itemsToProcess.length}) Skipped: ${processResult.title}`);
        continue;
      }

      result.processed++;

      // Move to destination playlist
      try {
        await moveVideo(videoId, playlistItemId, destinationPlaylistId);
        updateVideoProcessingStatus(videoId, "marked_processed");
        result.moved++;
        result.details.push({ videoId, title: processResult.title, status: "processed" });
        await notify(`(${idx}/${itemsToProcess.length}) Done: ${processResult.title}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        updateVideoProcessingStatus(videoId, "failed_to_mark");
        result.errors.push({ videoId, error: `Move failed: ${message}` });
        result.details.push({ videoId, title: processResult.title, status: "failed_to_move" });
        await notify(`(${idx}/${itemsToProcess.length}) Processed but move failed: ${processResult.title}`);
        log.error("Failed to move video", { videoId, error: message });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateVideoProcessingStatus(videoId, "failed");
      result.failed++;
      result.errors.push({ videoId, error: message });
      result.details.push({ videoId, title: item.snippet.title ?? videoId, status: "failed" });
      await notify(`(${idx}/${itemsToProcess.length}) Failed: ${videoTitle} - ${message}`);
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

  // Final summary
  const parts: string[] = [];
  if (result.processed > 0) parts.push(`${result.processed} new`);
  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
  if (result.moved > 0) parts.push(`${result.moved} moved`);
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (parts.length > 0) {
    await notify(`Done: ${parts.join(", ")}`);
  } else {
    await notify("No videos to process");
  }

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
