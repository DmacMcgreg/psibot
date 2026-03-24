#!/usr/bin/env bun

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { getPlaylistProcessingStats, getVideosNeedingPlaylistUpdate } from "../src/youtube/db.ts";

const config = loadConfig();
initDb(config.DB_PATH);

const stats = getPlaylistProcessingStats();
const needsUpdate = getVideosNeedingPlaylistUpdate();

console.log("\nPlaylist Processing Statistics:");
console.log(JSON.stringify(stats, null, 2));

console.log("\n\nVideos Needing Playlist Update:");
console.log(`Total: ${needsUpdate.length}`);
console.log("\nBreakdown by status:");
const byStatus = needsUpdate.reduce((acc, v) => {
  acc[v.processing_status] = (acc[v.processing_status] || 0) + 1;
  return acc;
}, {} as Record<string, number>);
console.log(JSON.stringify(byStatus, null, 2));

if (needsUpdate.length > 0) {
  console.log("\n\nFirst 5 videos needing update:");
  needsUpdate.slice(0, 5).forEach((v) => {
    console.log(`  - ${v.video_id} (${v.processing_status}): ${v.title}`);
  });
}
