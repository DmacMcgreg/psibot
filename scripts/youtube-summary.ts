#!/usr/bin/env bun
/// <reference types="bun-types" />

/**
 * Generate a summary of YouTube videos processed
 */

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { listVideos, getVideoCount, getPlaylistProcessingStats } from "../src/youtube/db.ts";

async function main() {
  const config = loadConfig();
  initDb(config.DB_PATH);

  const total = getVideoCount();
  const stats = getPlaylistProcessingStats();

  console.log("YouTube Processing Summary");
  console.log("=".repeat(80));
  console.log(`Total videos: ${total}`);
  console.log("");
  console.log("Status breakdown:");
  console.log(`  Complete (analyzed + moved): ${stats.complete}`);
  console.log(`  Marked processed (moved to destination): ${stats.marked_processed}`);
  console.log(`  Failed to mark (analyzed but move failed): ${stats.failed_to_mark}`);
  console.log(`  Analyzed (pending move): ${stats.analyzed}`);
  console.log(`  Processing: ${stats.processing}`);
  console.log(`  Pending: ${stats.pending}`);
  console.log(`  Failed: ${stats.failed}`);
  console.log("");

  // Get all videos and group by channel
  const allVideos = listVideos({ limit: 10000 });
  const channelCounts = new Map<string, number>();

  for (const v of allVideos) {
    const count = channelCounts.get(v.channel_title) || 0;
    channelCounts.set(v.channel_title, count + 1);
  }

  // Sort by count
  const topChannels = Array.from(channelCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  console.log("Top 20 channels by video count:");
  console.log("-".repeat(80));
  for (const [channel, count] of topChannels) {
    console.log(`  ${count.toString().padStart(3, " ")} - ${channel}`);
  }
  console.log("");

  // Get recent videos
  const recent = listVideos({ limit: 10 });
  console.log("10 most recent videos:");
  console.log("-".repeat(80));
  for (const v of recent) {
    console.log(`[${v.processing_status}] ${v.title}`);
    console.log(`  ${v.channel_title} | ${v.processed_at}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
