#!/usr/bin/env bun

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { Database } from "bun:sqlite";

const config = loadConfig();
initDb(config.DB_PATH);

const db = new Database(config.DB_PATH);

// Get videos with "complete" status
const completeVideos = db
  .query("SELECT video_id, title, processing_status FROM youtube_videos WHERE processing_status = 'complete' LIMIT 10")
  .all();

// Get videos with "failed_to_mark" status
const failedToMark = db
  .query("SELECT video_id, title, processing_status FROM youtube_videos WHERE processing_status = 'failed_to_mark' LIMIT 10")
  .all();

console.log("\nVideos with 'complete' status (need to be moved):");
console.log(`Total: ${db.query("SELECT COUNT(*) as count FROM youtube_videos WHERE processing_status = 'complete'").get()}`);
console.log("\nFirst 10:");
completeVideos.forEach((v: any) => {
  console.log(`  - ${v.video_id}: ${v.title}`);
});

console.log("\n\nVideos with 'failed_to_mark' status (processing succeeded, but move failed):");
console.log(`Total: ${db.query("SELECT COUNT(*) as count FROM youtube_videos WHERE processing_status = 'failed_to_mark'").get()}`);
console.log("\nFirst 10:");
failedToMark.forEach((v: any) => {
  console.log(`  - ${v.video_id}: ${v.title}`);
});

db.close();
