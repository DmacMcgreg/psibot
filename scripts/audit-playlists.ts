/**
 * Audit YouTube playlists vs database.
 * Lists videos in the destination "Processed" playlist that don't exist in our DB.
 * Usage: bun run scripts/audit-playlists.ts
 */
import { listPlaylistItems } from "../src/youtube/api.ts";
import { getVideo, getVideoCount } from "../src/youtube/db.ts";
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";

const config = loadConfig();
initDb();
const sourceId = config.YOUTUBE_SOURCE_PLAYLIST_ID;
const destId = config.YOUTUBE_DESTINATION_PLAYLIST_ID;

if (!sourceId || !destId) {
  console.error("Missing YOUTUBE_SOURCE_PLAYLIST_ID or YOUTUBE_DESTINATION_PLAYLIST_ID");
  process.exit(1);
}

console.log(`DB has ${getVideoCount()} videos\n`);

// Fetch both playlists
console.log("Fetching destination playlist...");
const destItems = await listPlaylistItems(destId);
console.log(`Destination playlist: ${destItems.length} items\n`);

console.log("Fetching source playlist...");
const sourceItems = await listPlaylistItems(sourceId);
console.log(`Source playlist: ${sourceItems.length} items\n`);

// Cross-reference destination with DB
const missingFromDb: Array<{ videoId: string; title: string; playlistItemId: string }> = [];
const inDb: Array<{ videoId: string; title: string; status: string }> = [];
const duplicates = new Map<string, number>();

for (const item of destItems) {
  const videoId = item.snippet.resourceId.videoId;
  const count = (duplicates.get(videoId) ?? 0) + 1;
  duplicates.set(videoId, count);

  // Only check on first occurrence
  if (count === 1) {
    const video = getVideo(videoId);
    if (!video) {
      missingFromDb.push({
        videoId,
        title: item.snippet.title,
        playlistItemId: item.id,
      });
    } else {
      inDb.push({
        videoId,
        title: video.title,
        status: video.processing_status,
      });
    }
  }
}

// Report duplicates
const dupes = [...duplicates.entries()].filter(([, count]) => count > 1);
if (dupes.length > 0) {
  console.log(`=== DUPLICATES IN DESTINATION (${dupes.length} videos) ===`);
  for (const [videoId, count] of dupes) {
    const item = destItems.find((i) => i.snippet.resourceId.videoId === videoId);
    console.log(`  ${videoId} x${count} - ${item?.snippet.title}`);
  }
  console.log();
}

// Report missing from DB
if (missingFromDb.length > 0) {
  console.log(`=== IN DESTINATION BUT NOT IN DB (${missingFromDb.length} videos) ===`);
  for (const v of missingFromDb) {
    console.log(`  ${v.videoId} - ${v.title}`);
  }
  console.log();
}

// Report what IS in DB
console.log(`=== IN DESTINATION AND IN DB (${inDb.length} videos) ===`);
for (const v of inDb) {
  console.log(`  ${v.videoId} [${v.status}] - ${v.title}`);
}
console.log();

// Check source playlist for videos that are also in DB as marked_processed
const sourceInDb: Array<{ videoId: string; title: string; status: string }> = [];
for (const item of sourceItems) {
  const videoId = item.snippet.resourceId.videoId;
  const video = getVideo(videoId);
  if (video) {
    sourceInDb.push({ videoId, title: video.title, status: video.processing_status });
  }
}

if (sourceInDb.length > 0) {
  console.log(`=== IN SOURCE AND ALSO IN DB (${sourceInDb.length} videos) ===`);
  for (const v of sourceInDb) {
    console.log(`  ${v.videoId} [${v.status}] - ${v.title}`);
  }
  console.log();
}

// Summary
console.log("=== SUMMARY ===");
console.log(`DB total: ${getVideoCount()}`);
console.log(`Destination playlist: ${destItems.length} items (${new Set(destItems.map((i) => i.snippet.resourceId.videoId)).size} unique)`);
console.log(`Source playlist: ${sourceItems.length} items`);
console.log(`In destination but NOT in DB: ${missingFromDb.length}`);
console.log(`Duplicates in destination: ${dupes.reduce((sum, [, c]) => sum + c - 1, 0)} extra copies across ${dupes.length} videos`);
