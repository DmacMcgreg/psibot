#!/usr/bin/env bun

/**
 * Move videos that have been processed but not yet moved to destination playlist
 * Handles videos with status "complete" and "failed_to_mark"
 */

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { Database } from "bun:sqlite";
import { addToPlaylist } from "../src/youtube/api.ts";
import { updateVideoProcessingStatus } from "../src/youtube/db.ts";
import { createLogger } from "../src/shared/logger.ts";

const log = createLogger("move-completed-videos");

async function main() {
  const config = loadConfig();
  initDb(config.DB_PATH);

  const db = new Database(config.DB_PATH);

  // Get videos that need to be moved (complete or failed_to_mark)
  const videos = db
    .query(
      "SELECT video_id, title, processing_status FROM youtube_videos WHERE processing_status IN ('complete', 'failed_to_mark') ORDER BY created_at DESC"
    )
    .all() as Array<{ video_id: string; title: string; processing_status: string }>;

  if (videos.length === 0) {
    console.log("No videos to move");
    return;
  }

  console.log(`Found ${videos.length} videos to move to destination playlist`);
  console.log(`Destination: ${config.YOUTUBE_DESTINATION_PLAYLIST_ID}\n`);

  let moved = 0;
  let failed = 0;
  const errors: Array<{ videoId: string; error: string }> = [];

  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    const progress = `(${i + 1}/${videos.length})`;

    try {
      console.log(`${progress} Moving: ${video.title}`);

      // Add to destination playlist
      await addToPlaylist(config.YOUTUBE_DESTINATION_PLAYLIST_ID, video.video_id);

      // Update status to marked_processed
      updateVideoProcessingStatus(video.video_id, "marked_processed");

      moved++;
      console.log(`${progress} ✓ Moved: ${video.title}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed++;
      errors.push({ videoId: video.video_id, error: message });

      // Update status to failed_to_mark if it was "complete"
      if (video.processing_status === "complete") {
        updateVideoProcessingStatus(video.video_id, "failed_to_mark");
      }

      console.error(`${progress} ✗ Failed to move: ${video.title}`);
      console.error(`   Error: ${message}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  console.log(`  Total videos: ${videos.length}`);
  console.log(`  Successfully moved: ${moved}`);
  console.log(`  Failed: ${failed}`);

  if (errors.length > 0) {
    console.log("\nErrors:");
    errors.forEach((err) => {
      console.log(`  - ${err.videoId}: ${err.error}`);
    });
  }

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
