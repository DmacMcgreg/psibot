#!/usr/bin/env bun
// /// script
// requires-python = ">=3.11"
// ///

/**
 * Remove fully-processed videos from the source ("New Watch Later") playlist.
 *
 * Strategy (minimal API calls):
 *   1. Query local SQLite DB for all video_ids with status in
 *      (complete, marked_processed) — these are fully done.
 *   2. Fetch source playlist items via YouTube API (paginated, ~1 call per 50 items).
 *   3. Cross-reference: any playlist item whose videoId is in the DB set gets deleted.
 *   4. Each delete = 1 API call. We add a small delay between deletes to avoid 429s.
 *
 * Usage:
 *   bun run scripts/cleanup-source-playlist.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_DIR = path.resolve(import.meta.dir, "..");
const DB_PATH = path.join(PROJECT_DIR, "data/app.db");

// Load .env
const envPath = path.join(PROJECT_DIR, ".env");
const envFile = await Bun.file(envPath).text();
const env: Record<string, string> = {};
for (const line of envFile.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) continue;
  const key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  // Strip surrounding quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  env[key] = val;
}

const SOURCE_PLAYLIST_ID = env.YOUTUBE_SOURCE_PLAYLIST_ID;
const OAUTH_VAULT_URL = env.OAUTH_VAULT_URL;
const OAUTH_VAULT_API_KEY = env.OAUTH_VAULT_API_KEY;

if (!SOURCE_PLAYLIST_ID) throw new Error("YOUTUBE_SOURCE_PLAYLIST_ID not set in .env");
if (!OAUTH_VAULT_URL) throw new Error("OAUTH_VAULT_URL not set in .env");
if (!OAUTH_VAULT_API_KEY) throw new Error("OAUTH_VAULT_API_KEY not set in .env");

const DRY_RUN = process.argv.includes("--dry-run");
const DELAY_MS = 350; // delay between delete calls to avoid rate limits

// ---------------------------------------------------------------------------
// Step 1: Get processed video IDs from DB
// ---------------------------------------------------------------------------

console.log("--- Step 1: Query DB for processed videos ---");
const db = new Database(DB_PATH, { readonly: true });

const processedRows = db
  .prepare<{ video_id: string; processing_status: string }, []>(
    `SELECT video_id, processing_status FROM youtube_videos
     WHERE processing_status IN ('complete', 'marked_processed')
     ORDER BY video_id`
  )
  .all();

const processedVideoIds = new Set(processedRows.map((r) => r.video_id));
console.log(`Found ${processedVideoIds.size} processed videos in DB`);

// Also grab "analyzed" and "failed_to_mark" — these are in the DB and summarized,
// just never successfully moved. Still safe to remove from source.
const allDbRows = db
  .prepare<{ video_id: string }, []>(
    `SELECT video_id FROM youtube_videos
     WHERE processing_status IN ('complete', 'marked_processed', 'analyzed', 'failed_to_mark')`
  )
  .all();

const allDbVideoIds = new Set(allDbRows.map((r) => r.video_id));
console.log(`Including analyzed/failed_to_mark: ${allDbVideoIds.size} total removable videos`);

db.close();

// ---------------------------------------------------------------------------
// Step 2: Fetch source playlist items from YouTube API
// ---------------------------------------------------------------------------

console.log("\n--- Step 2: Fetch source playlist items ---");

async function getAccessToken(): Promise<string> {
  const resp = await fetch(`${OAUTH_VAULT_URL}/api/tokens/google`, {
    headers: { Authorization: `Bearer ${OAUTH_VAULT_API_KEY}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OAuth vault error ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

interface PlaylistItem {
  id: string; // playlistItemId — needed for deletion
  snippet: {
    title: string;
    resourceId: { videoId: string };
  };
}

async function fetchAllPlaylistItems(accessToken: string): Promise<PlaylistItem[]> {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;
  let apiCalls = 0;

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", SOURCE_PLAYLIST_ID);
    url.searchParams.set("maxResults", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    apiCalls++;

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`YouTube API error ${resp.status}: ${text.slice(0, 500)}`);
    }

    const data = (await resp.json()) as {
      items: PlaylistItem[];
      nextPageToken?: string;
      pageInfo: { totalResults: number };
    };

    items.push(...data.items);
    pageToken = data.nextPageToken;
    console.log(`  Fetched page ${apiCalls}: ${data.items.length} items (${items.length} total of ${data.pageInfo.totalResults})`);
  } while (pageToken);

  console.log(`Fetched ${items.length} items in ${apiCalls} API calls`);
  return items;
}

const accessToken = await getAccessToken();
const playlistItems = await fetchAllPlaylistItems(accessToken);

// ---------------------------------------------------------------------------
// Step 3: Cross-reference and build removal list
// ---------------------------------------------------------------------------

console.log("\n--- Step 3: Cross-reference ---");

const toRemove: { playlistItemId: string; videoId: string; title: string }[] = [];
const toKeep: { videoId: string; title: string }[] = [];

for (const item of playlistItems) {
  const videoId = item.snippet.resourceId.videoId;
  if (allDbVideoIds.has(videoId)) {
    toRemove.push({
      playlistItemId: item.id,
      videoId,
      title: item.snippet.title,
    });
  } else {
    toKeep.push({ videoId, title: item.snippet.title });
  }
}

console.log(`To remove: ${toRemove.length}`);
console.log(`To keep:   ${toKeep.length}`);

// Save working lists to a JSON file for reference
const workingList = {
  timestamp: new Date().toISOString(),
  sourcePlaylistId: SOURCE_PLAYLIST_ID,
  toRemove,
  toKeep,
};

const listPath = path.join(PROJECT_DIR, "data/playlist-cleanup-list.json");
await Bun.write(listPath, JSON.stringify(workingList, null, 2));
console.log(`Working list saved to: ${listPath}`);

// ---------------------------------------------------------------------------
// Step 4: Remove items (or dry-run)
// ---------------------------------------------------------------------------

if (DRY_RUN) {
  console.log("\n--- DRY RUN: No deletions performed ---");
  console.log("\nWould remove:");
  for (const item of toRemove) {
    console.log(`  [${item.videoId}] ${item.title}`);
  }
  console.log("\nWould keep:");
  for (const item of toKeep) {
    console.log(`  [${item.videoId}] ${item.title}`);
  }
} else {
  console.log(`\n--- Step 4: Removing ${toRemove.length} items ---`);

  let removed = 0;
  let errors = 0;

  for (const item of toRemove) {
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      url.searchParams.set("id", item.playlistItemId);

      const resp = await fetch(url.toString(), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (resp.ok || resp.status === 204) {
        removed++;
        console.log(`  [${removed}/${toRemove.length}] Removed: ${item.title}`);
      } else {
        const text = await resp.text();
        errors++;
        console.error(`  FAILED [${item.videoId}]: ${resp.status} ${text.slice(0, 200)}`);
      }

      // Delay to avoid rate limits
      if (removed < toRemove.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
    } catch (err) {
      errors++;
      console.error(`  ERROR [${item.videoId}]: ${err}`);
    }
  }

  console.log(`\nDone! Removed: ${removed}, Errors: ${errors}, Kept: ${toKeep.length}`);
}
