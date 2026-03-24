#!/usr/bin/env bun
/**
 * Direct invocation of processPlaylist function
 * Processes YouTube watchlist playlist using default environment variables
 */

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { processPlaylist } from "../src/youtube/playlist.ts";

async function main() {
  console.log("Loading configuration...");
  const config = loadConfig();

  console.log("Initializing database...");
  initDb();

  console.log("Source playlist:", config.YOUTUBE_SOURCE_PLAYLIST_ID);
  console.log("Destination playlist:", config.YOUTUBE_DESTINATION_PLAYLIST_ID);
  console.log("Analysis model:", config.YOUTUBE_ANALYSIS_MODEL);
  console.log("");

  const result = await processPlaylist({
    // Use defaults from environment
    limit: 50,
    retryFailed: true,
    onProgress: async (message: string) => {
      console.log(`[PROGRESS] ${message}`);
    },
  });

  console.log("\n=== Processing Complete ===");
  console.log(`Processed: ${result.processed}`);
  console.log(`Skipped: ${result.skipped}`);
  console.log(`Moved: ${result.moved}`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Retry successes: ${result.retrySuccesses}`);
  console.log(`Retry failures: ${result.retryFailures}`);

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const err of result.errors) {
      console.log(`  - ${err.videoId}: ${err.error}`);
    }
  }

  if (result.details.length > 0) {
    console.log("\nDetails:");
    for (const detail of result.details) {
      const icon = {
        processed: "✓",
        skipped: "⊘",
        moved: "→",
        failed_to_move: "✗",
        failed: "✗",
      }[detail.status];
      console.log(`  ${icon} [${detail.status.toUpperCase()}] ${detail.title}`);
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
