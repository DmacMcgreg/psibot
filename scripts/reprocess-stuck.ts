/**
 * Reprocess videos stuck in "processing" or "failed" status.
 * These failed because no YouTube captions were available.
 * Now uses the audio fallback (download + parakeet STT).
 */
import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { processAndStoreVideo } from "../src/youtube/process.ts";

// Initialize config + database (loads sqlite-vec, runs migrations)
loadConfig();
initDb();
const db = getDb();

// Get all stuck videos
const stuck = db.query(
  "SELECT video_id, title FROM youtube_videos WHERE processing_status IN ('processing', 'failed') ORDER BY created_at DESC"
).all() as Array<{ video_id: string; title: string }>;

console.log(`Found ${stuck.length} stuck videos to reprocess\n`);

let success = 0;
let failed = 0;
const errors: Array<{ title: string; error: string }> = [];

for (let i = 0; i < stuck.length; i++) {
  const { video_id, title } = stuck[i];
  console.log(`(${i + 1}/${stuck.length}) Processing: ${title}`);

  try {
    // Delete the incomplete DB entry so processAndStoreVideo starts fresh
    // processAndStoreVideo calls deleteVideoChunks internally, but we need to
    // remove the youtube_videos row so getVideo() returns null
    db.run("DELETE FROM youtube_chunks WHERE video_id = ?", [video_id]);
    db.run("DELETE FROM youtube_videos WHERE video_id = ?", [video_id]);

    const result = await processAndStoreVideo(video_id, {
      processingStatus: "complete",
      forceReprocess: true,
    });

    if (result.skipped) {
      console.log(`  -> Skipped (already exists)\n`);
    } else {
      console.log(`  -> OK (${result.chunkCount} chunks)\n`);
      success++;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  -> FAILED: ${msg}\n`);
    failed++;
    errors.push({ title, error: msg });

    // Mark as failed in DB so it doesn't stay as "processing"
    // Re-insert with failed status if deleted
    try {
      db.run(
        "INSERT OR IGNORE INTO youtube_videos (video_id, title, channel_title, tags, markdown_summary, analysis_json, transcript_text, processing_status) VALUES (?, ?, '', '[]', '', '{}', '', 'failed')",
        [video_id, title]
      );
      db.run("UPDATE youtube_videos SET processing_status = 'failed' WHERE video_id = ?", [video_id]);
    } catch {
      // ignore
    }
  }
}

console.log("=".repeat(60));
console.log(`Done: ${success} succeeded, ${failed} failed out of ${stuck.length}`);

if (errors.length > 0) {
  console.log("\nFailed videos:");
  for (const e of errors) {
    console.log(`  - ${e.title}: ${e.error}`);
  }
}

// Verify no temp audio files left behind
import { readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
const tmpFiles = readdirSync(tmpdir()).filter(f => f.startsWith("psi-audio-"));
if (tmpFiles.length > 0) {
  console.log(`\nWARNING: ${tmpFiles.length} temp audio directories still in ${tmpdir()}:`);
  tmpFiles.forEach(f => console.log(`  ${f}`));
} else {
  console.log("\nCleanup verified: no temp audio directories remaining.");
}
