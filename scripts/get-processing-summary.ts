#!/usr/bin/env bun

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { Database } from "bun:sqlite";

const config = loadConfig();
initDb(config.DB_PATH);

const db = new Database(config.DB_PATH);

// Get overall counts
const totalVideos = db.query("SELECT COUNT(*) as count FROM youtube_videos").get() as { count: number };

// Get status breakdown
const statusBreakdown = db.query(`
  SELECT processing_status, COUNT(*) as count
  FROM youtube_videos
  GROUP BY processing_status
`).all() as Array<{ processing_status: string; count: number }>;

// Get videos with failed_to_mark status for details
const failedToMark = db.query(`
  SELECT video_id, title
  FROM youtube_videos
  WHERE processing_status = 'failed_to_mark'
  LIMIT 5
`).all() as Array<{ video_id: string; title: string }>;

console.log("\n" + "=".repeat(60));
console.log("YouTube Processing Summary");
console.log("=".repeat(60));
console.log(`\nTotal videos in database: ${totalVideos.count}`);

console.log("\nStatus breakdown:");
statusBreakdown.forEach((s) => {
  const percentage = ((s.count / totalVideos.count) * 100).toFixed(1);
  console.log(`  ${s.processing_status.padEnd(20)} ${s.count.toString().padStart(4)} (${percentage}%)`);
});

if (failedToMark.length > 0) {
  console.log("\nVideos that failed to move (quota exceeded):");
  failedToMark.forEach((v) => {
    console.log(`  - ${v.video_id}: ${v.title}`);
  });
  console.log(`  ... and ${db.query("SELECT COUNT(*) as count FROM youtube_videos WHERE processing_status = 'failed_to_mark'").get()!.count - 5} more`);
}

console.log("\n" + "=".repeat(60));

db.close();
