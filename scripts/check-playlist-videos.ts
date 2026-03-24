#!/usr/bin/env bun
import Database from "bun:sqlite";
import { readFileSync } from "fs";

const db = new Database("data/app.db");
const videos = JSON.parse(readFileSync("data/youtube_playlist_processing.json", "utf-8"));

const processed: Array<{ index: number; videoId: string; title: string }> = [];
const unprocessed: Array<{ index: number; videoId: string; title: string }> = [];

for (const video of videos) {
  const result = db.query("SELECT video_id FROM youtube_videos WHERE video_id = ?").get(video.videoId);
  if (result) {
    processed.push(video);
  } else {
    unprocessed.push(video);
  }
}

console.log(`\n=== PROCESSED (${processed.length}/${videos.length}) ===`);
for (const v of processed) {
  console.log(`${v.index}. ${v.videoId} - ${v.title}`);
}

console.log(`\n=== UNPROCESSED (${unprocessed.length}/${videos.length}) ===`);
for (const v of unprocessed) {
  console.log(`${v.index}. ${v.videoId} - ${v.title}`);
}

// Write unprocessed list to file for processing
import { writeFileSync } from "fs";
writeFileSync("data/youtube_unprocessed.json", JSON.stringify(unprocessed, null, 2));
console.log(`\nUnprocessed videos saved to data/youtube_unprocessed.json`);
