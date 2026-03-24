#!/usr/bin/env bun
/// <reference types="bun-types" />

/**
 * Process YouTube watchlist playlist
 * Uses the youtube_process_playlist tool to fetch, analyze, and move videos
 */

import { loadConfig } from "../src/config.ts";
import { processPlaylist } from "../src/youtube/playlist.ts";
import { getVideoCount, getPlaylistProcessingStats } from "../src/youtube/db.ts";
import { createLogger } from "../src/shared/logger.ts";
import { initDb } from "../src/db/index.ts";

const log = createLogger("process-watchlist");

async function main() {
  const config = loadConfig();
  initDb(config.DB_PATH);

  // Show current status
  const count = getVideoCount();
  const stats = getPlaylistProcessingStats();

  log.info("Current YouTube database status", {
    totalVideos: count,
    stats,
  });

  // Process the watchlist playlist
  log.info("Processing watchlist playlist", {
    source: config.YOUTUBE_SOURCE_PLAYLIST_ID,
    destination: config.YOUTUBE_DESTINATION_PLAYLIST_ID,
  });

  const result = await processPlaylist({
    sourcePlaylistId: config.YOUTUBE_SOURCE_PLAYLIST_ID,
    destinationPlaylistId: config.YOUTUBE_DESTINATION_PLAYLIST_ID,
    limit: 50,
    retryFailed: true,
    model: config.YOUTUBE_ANALYSIS_MODEL,
    onProgress: (msg) => console.log(msg),
  });

  log.info("Processing complete", {
    processed: result.processed,
    skipped: result.skipped,
    moved: result.moved,
    failed: result.failed,
    retrySuccesses: result.retrySuccesses,
    retryFailures: result.retryFailures,
  });

  // Show details
  if (result.details.length > 0) {
    console.log("\nDetails:");
    for (const d of result.details) {
      const icon = {
        processed: "[NEW]",
        skipped: "[SKIP]",
        moved: "[MOVE]",
        failed_to_move: "[MOVE_ERR]",
        failed: "[FAIL]",
      }[d.status];
      console.log(`${icon} ${d.title}`);
    }
  }

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const err of result.errors) {
      console.log(`  - ${err.videoId}: ${err.error}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
