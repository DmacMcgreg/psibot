#!/usr/bin/env bun

/**
 * Remove duplicate videos from YouTube "Processed" playlist.
 * Strategy: Fetch all items, identify duplicates in memory, delete extras.
 * Keeps first occurrence of each video ID, removes subsequent duplicates.
 */

import { loadConfig, getConfig } from "../src/config.ts";
import { listPlaylistItems, removeFromPlaylist } from "../src/youtube/api.ts";
import { createLogger } from "../src/shared/logger.ts";

const log = createLogger("remove-duplicates");

interface DuplicateEntry {
  videoId: string;
  playlistItemId: string;
  title: string;
  position: number;
}

async function removeDuplicates() {
  loadConfig();
  const config = getConfig();

  if (!config.YOUTUBE_DESTINATION_PLAYLIST_ID) {
    throw new Error("YOUTUBE_DESTINATION_PLAYLIST_ID not set in environment");
  }

  const playlistId = config.YOUTUBE_DESTINATION_PLAYLIST_ID;
  log.info("Fetching all playlist items", { playlistId });

  // Step 1: Fetch all playlist items (listPlaylistItems already paginates with maxResults=50)
  const items = await listPlaylistItems(playlistId);
  log.info("Fetched playlist items", { count: items.length });

  if (items.length === 0) {
    log.info("Playlist is empty, nothing to do");
    return;
  }

  // Step 2: Identify duplicates in memory
  const seenVideoIds = new Map<string, number>(); // videoId -> first occurrence index
  const duplicates: DuplicateEntry[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const videoId = item.snippet.resourceId.videoId;
    const playlistItemId = item.id;
    const title = item.snippet.title;

    if (seenVideoIds.has(videoId)) {
      // This is a duplicate - keep track of it
      duplicates.push({
        videoId,
        playlistItemId,
        title,
        position: i,
      });
      log.info("Found duplicate", {
        videoId,
        title,
        position: i,
        firstOccurrence: seenVideoIds.get(videoId),
      });
    } else {
      // First occurrence - remember it
      seenVideoIds.set(videoId, i);
    }
  }

  if (duplicates.length === 0) {
    log.info("No duplicates found");
    console.log("No duplicates found in playlist");
    return;
  }

  log.info("Found duplicates to remove", { count: duplicates.length });
  console.log(`\nFound ${duplicates.length} duplicate video(s):\n`);

  for (const dup of duplicates) {
    const firstPos = seenVideoIds.get(dup.videoId);
    console.log(`  - ${dup.title}`);
    console.log(`    Video ID: ${dup.videoId}`);
    console.log(`    First at position ${firstPos}, duplicate at position ${dup.position}`);
    console.log(`    Will remove playlist item: ${dup.playlistItemId}\n`);
  }

  // Step 3: Delete duplicates one by one
  console.log("Starting deletion...\n");
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < duplicates.length; i++) {
    const dup = duplicates[i];
    const progress = `[${i + 1}/${duplicates.length}]`;

    try {
      log.info("Removing duplicate", {
        progress,
        videoId: dup.videoId,
        playlistItemId: dup.playlistItemId,
      });

      await removeFromPlaylist(dup.playlistItemId);
      successCount++;
      console.log(`${progress} Removed: ${dup.title}`);
    } catch (err) {
      failCount++;
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to remove duplicate", {
        progress,
        videoId: dup.videoId,
        playlistItemId: dup.playlistItemId,
        error: message,
      });
      console.error(`${progress} FAILED: ${dup.title} - ${message}`);
    }
  }

  // Summary
  console.log("\n--- Summary ---");
  console.log(`Total duplicates found: ${duplicates.length}`);
  console.log(`Successfully removed: ${successCount}`);
  console.log(`Failed to remove: ${failCount}`);
  console.log(`Unique videos in playlist: ${seenVideoIds.size}`);

  log.info("Duplicate removal complete", {
    total: duplicates.length,
    success: successCount,
    failed: failCount,
    uniqueVideos: seenVideoIds.size,
  });
}

// Run
removeDuplicates().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
