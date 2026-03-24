#!/usr/bin/env bun
/// <reference types="bun-types" />

/**
 * List YouTube videos in database with their processing status
 */

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { listVideos, getVideoCount, getVideosNeedingPlaylistUpdate } from "../src/youtube/db.ts";

async function main() {
  const config = loadConfig();
  initDb(config.DB_PATH);

  const total = getVideoCount();
  console.log(`\nTotal videos in database: ${total}\n`);

  // Get recent videos
  const recentVideos = listVideos({ limit: 20 });

  console.log("Most recent 20 videos:");
  console.log("=" .repeat(80));
  for (const v of recentVideos) {
    console.log(`${v.video_id} | ${v.processing_status} | ${v.title}`);
    console.log(`  Channel: ${v.channel_title}`);
    console.log(`  Processed: ${v.processed_at}`);
    console.log("");
  }

  // Get videos that need playlist updates
  const needsUpdate = getVideosNeedingPlaylistUpdate();
  if (needsUpdate.length > 0) {
    console.log(`\nVideos needing playlist update (${needsUpdate.length}):`);
    console.log("=".repeat(80));
    for (const v of needsUpdate.slice(0, 10)) {
      console.log(`${v.video_id} | ${v.processing_status} | ${v.marking_attempts} attempts`);
      console.log(`  ${v.title}`);
      console.log(`  Last attempt: ${v.last_mark_attempt_at || "never"}`);
      console.log("");
    }
    if (needsUpdate.length > 10) {
      console.log(`... and ${needsUpdate.length - 10} more\n`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
