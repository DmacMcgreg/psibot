#!/usr/bin/env bun
// /// script
// requires-python = ">=3.11"
// dependencies = []
// ///

/**
 * Playwright script to move processed videos from "New Watch Later" to "Processed" playlist
 *
 * This script:
 * 1. Navigates to the "New Watch Later" playlist
 * 2. For each processed video (already in DB):
 *    a. Finds the video by ID
 *    b. Clicks the 3-dot menu
 *    c. Adds to "Processed" playlist (if not already there)
 *    d. Removes from "New Watch Later" playlist
 * 3. Handles errors gracefully with retries
 * 4. Logs progress to a file
 */

import { chromium, type Page, type Cookie } from 'playwright';
import Database from 'bun:sqlite';
import { writeFileSync, appendFileSync, readFileSync } from 'fs';

const NEW_WATCH_LATER_PLAYLIST = 'PLRZ22a68DNDiHMgoVjc8ZZj6IAt6zKGRT';
const PROCESSED_PLAYLIST = 'PLRZ22a68DNDiHMgoVjc8ZZj6IAt6zKGRT'; // TODO: Replace with actual processed playlist ID

const LOG_FILE = 'data/playlist_migration.log';
const RESULTS_FILE = 'data/playlist_migration_results.json';
const COOKIES_FILE = 'cookies.txt';

// Configuration
const CONFIG = {
  headless: false,
  slowMo: 500,
  timeout: 30000,
  retries: 3,
};

function parseNetscapeCookies(filePath: string): Cookie[] {
  const content = readFileSync(filePath, 'utf-8');
  const cookies: Cookie[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    const [domain, , path, secure, expires, name, value] = parts;

    cookies.push({
      name,
      value,
      domain,
      path,
      secure: secure === 'TRUE',
      expires: Number(expires),
      httpOnly: false,
      sameSite: 'None' as const,
    });
  }

  return cookies;
}

interface VideoResult {
  videoId: string;
  title?: string;
  addedToProcessed: boolean;
  removedFromWatchLater: boolean;
  error?: string;
  attempts: number;
}

function log(message: string) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  appendFileSync(LOG_FILE, logMessage + '\n');
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function findVideoOnPage(page: Page, videoId: string): Promise<boolean> {
  try {
    // Look for the video element with this ID
    const videoElement = await page.locator(`a[href*="${videoId}"]`).first();
    const count = await videoElement.count();
    return count > 0;
  } catch (error) {
    return false;
  }
}

async function clickThreeDotMenu(page: Page, videoId: string): Promise<boolean> {
  try {
    // Find the video container
    const videoContainer = page.locator(`ytd-playlist-video-renderer`).filter({
      has: page.locator(`a[href*="${videoId}"]`)
    });

    // Wait for the container to be visible
    await videoContainer.waitFor({ state: 'visible', timeout: 5000 });

    // Hover to reveal the menu button
    await videoContainer.hover();
    await sleep(500);

    // Click the three-dot menu button
    const menuButton = videoContainer.locator('button[aria-label*="Action menu"]');
    await menuButton.click();

    // Wait for menu to appear
    await page.waitForSelector('ytd-menu-popup-renderer', { state: 'visible', timeout: 5000 });

    return true;
  } catch (error) {
    log(`Error clicking three-dot menu for ${videoId}: ${error}`);
    return false;
  }
}

async function addToPlaylist(page: Page, playlistName: string): Promise<boolean> {
  try {
    // Click "Add to playlist" option
    const addToPlaylistOption = page.locator('tp-yt-paper-listbox').locator('text=/Add to playlist|Save to playlist/i');
    await addToPlaylistOption.click();

    // Wait for playlist selector to appear
    await page.waitForSelector('ytd-add-to-playlist-renderer', { state: 'visible', timeout: 5000 });
    await sleep(500);

    // Look for the "Processed" playlist checkbox
    const playlistCheckbox = page.locator(`ytd-playlist-add-to-option-renderer`).filter({
      hasText: playlistName
    }).locator('tp-yt-paper-checkbox');

    // Check if already checked
    const isChecked = await playlistCheckbox.getAttribute('aria-checked');

    if (isChecked === 'true') {
      log(`Video already in "${playlistName}" playlist`);
      // Close the dialog
      await page.keyboard.press('Escape');
      return true;
    }

    // Click to add to playlist
    await playlistCheckbox.click();
    await sleep(1000);

    // Close the dialog
    await page.keyboard.press('Escape');
    await sleep(500);

    return true;
  } catch (error) {
    log(`Error adding to playlist: ${error}`);
    // Try to close any open dialogs
    await page.keyboard.press('Escape');
    return false;
  }
}

async function removeFromCurrentPlaylist(page: Page, videoId: string): Promise<boolean> {
  try {
    // Click the three-dot menu again
    if (!await clickThreeDotMenu(page, videoId)) {
      return false;
    }

    // Click "Remove from [playlist name]" option
    const removeOption = page.locator('tp-yt-paper-listbox').locator('text=/Remove from|Delete/i');
    await removeOption.click();

    await sleep(1000);

    // Verify the video is gone
    const stillExists = await findVideoOnPage(page, videoId);
    return !stillExists;
  } catch (error) {
    log(`Error removing from playlist: ${error}`);
    return false;
  }
}

async function processVideo(page: Page, videoId: string, retryCount = 0): Promise<VideoResult> {
  const result: VideoResult = {
    videoId,
    addedToProcessed: false,
    removedFromWatchLater: false,
    attempts: retryCount + 1,
  };

  try {
    log(`Processing video ${videoId} (attempt ${retryCount + 1}/${CONFIG.retries + 1})`);

    // Check if video is on the current page
    const videoExists = await findVideoOnPage(page, videoId);

    if (!videoExists) {
      // Video might be on another page or already removed
      log(`Video ${videoId} not found on current page. May already be removed or on another page.`);
      result.error = 'Video not found on page';
      return result;
    }

    // Step 1: Click three-dot menu
    if (!await clickThreeDotMenu(page, videoId)) {
      throw new Error('Failed to open three-dot menu');
    }

    await sleep(500);

    // Step 2: Add to "Processed" playlist
    result.addedToProcessed = await addToPlaylist(page, 'Processed');

    if (!result.addedToProcessed) {
      throw new Error('Failed to add to Processed playlist');
    }

    await sleep(1000);

    // Step 3: Remove from "New Watch Later"
    result.removedFromWatchLater = await removeFromCurrentPlaylist(page, videoId);

    if (!result.removedFromWatchLater) {
      throw new Error('Failed to remove from New Watch Later');
    }

    log(`✓ Successfully processed ${videoId}`);

  } catch (error) {
    result.error = String(error);
    log(`✗ Error processing ${videoId}: ${error}`);

    // Retry logic
    if (retryCount < CONFIG.retries) {
      log(`Retrying ${videoId}...`);
      await sleep(2000);
      // Reload the page to reset state
      await page.reload();
      await sleep(2000);
      return await processVideo(page, videoId, retryCount + 1);
    }
  }

  return result;
}

async function main() {
  log('=== Starting Playlist Migration ===');

  // Get list of processed videos from database
  const db = new Database('data/app.db');
  const processedVideos = db.query('SELECT video_id, title FROM youtube_videos').all() as Array<{
    video_id: string;
    title: string;
  }>;

  log(`Found ${processedVideos.length} processed videos in database`);

  // Get the 76 playlist video IDs
  const playlistVideoIds = [
    "JKk77rzOL34", "z58RmqYcX00", "PmcEtMsw5nk", "Fp9w1CIhNUU", "hj9z4r5qcnE",
    "PN8PLd_k5vs", "Y8Jh9zx6bJc", "VWngYUC63po", "kGXL_Af-hcg", "kyAVCIJj_aM",
    "1a78ge4cB7I", "kMivoKHHkxQ", "3_bgCBP3N_c", "b9pG67bUnGg", "dme7Ir3e2EA",
    "IYZ_UrHfNGo", "N_RcSa6z-Bo", "WCLgNOkDSMg", "FvmGIFShz9k", "FX_I7BqxJWA",
    "_LNVbHTYKOM", "5_6wG7feK8A", "RJ9OapJw7zw", "6OvkVUkr3DE", "NXtVWJJzFd4",
    "KT9td3FJxj8", "I-KoLZOy43k", "2BqOhHcTzeM", "7OHCOFFUamQ", "Ei4fT0bk_ic",
    "n2N5ZxyQVPI", "ptCxKIizD9g", "V49yx8Ye38A", "O2um7D1veeY", "lUYuO7M4k_s",
    "blxdquyOn1E", "Lg_aUOSLuRo", "UR09nuSxGio", "vf7ol8mpZjk", "yAO28HOS5x4",
    "Js-zOaA8czQ", "RPzcGeiNYvk", "BJAab5bH_6Y", "K0Ws647wF-Q", "87kVGDkRmqM",
    "N1nOpBXCRH4", "OtEidzV5nNE", "ZejxZGHdAVg", "SmYNK0kqaDI", "5Di6o6zuMLc",
    "7l7G34RfG4g", "xdXuycwc-sA", "8Wfim7mDE3Q", "_JbLKhpjw-8", "-aRdX-kZ9g4",
    "Mwm2VQU-s9Q", "kkouEaKGsec", "-OnvD9McDt8", "8WWFNv4Glas", "FmXKOSuoMGI",
    "bo6UKQEC0T0", "LdX19_rW4Pk", "-x_XQcPUxY0", "EKOU3JWDNLI", "jFzwS7z2418",
    "Nd17ZGaoZ58", "wq7wiCW-Bq8", "XSN4uuL3jMg", "vElZDiYhYWg", "npQ2IORdlvU",
    "950fbVKFwHM", "GmreRPVWC7c", "m8gnIieakL8", "knVaCNiH-8I", "K2zI68KHZqk",
    "_LD7NRSf3o8"
  ];

  // Filter to only videos that are in the database
  const processedVideoIds = new Set(processedVideos.map(v => v.video_id));
  const videosToMove = playlistVideoIds.filter(id => processedVideoIds.has(id));

  log(`Found ${videosToMove.length} videos to move from New Watch Later to Processed`);

  // Launch fresh browser and inject cookies for authentication
  log('Parsing cookies...');
  const cookies = parseNetscapeCookies(COOKIES_FILE);
  log(`Loaded ${cookies.length} cookies from ${COOKIES_FILE}`);

  log('Launching browser...');
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    slowMo: CONFIG.slowMo,
    channel: 'chrome',
  });

  const context = await browser.newContext();
  await context.addCookies(cookies);
  log('Cookies injected into browser context');

  const page = await context.newPage();
  page.setDefaultTimeout(CONFIG.timeout);

  // Navigate to the playlist
  const playlistUrl = `https://www.youtube.com/playlist?list=${NEW_WATCH_LATER_PLAYLIST}`;
  log(`Navigating to ${playlistUrl}`);
  await page.goto(playlistUrl);

  // Wait for playlist to load
  await page.waitForSelector('ytd-playlist-video-renderer', { timeout: 10000 });
  await sleep(2000);

  // Process each video
  const results: VideoResult[] = [];

  for (let i = 0; i < videosToMove.length; i++) {
    const videoId = videosToMove[i];
    log(`\n[${i + 1}/${videosToMove.length}] Processing ${videoId}`);

    const result = await processVideo(page, videoId);
    results.push(result);

    // Save progress after each video
    writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

    // Small delay between videos
    await sleep(1000);

    // Scroll down periodically to load more videos
    if (i > 0 && i % 10 === 0) {
      log('Scrolling to load more videos...');
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 3));
      await sleep(2000);
    }
  }

  // Summary
  const successful = results.filter(r => r.addedToProcessed && r.removedFromWatchLater).length;
  const failed = results.filter(r => !r.addedToProcessed || !r.removedFromWatchLater).length;

  log('\n=== Migration Complete ===');
  log(`Total videos processed: ${results.length}`);
  log(`Successful: ${successful}`);
  log(`Failed: ${failed}`);

  if (failed > 0) {
    log('\nFailed videos:');
    results.filter(r => r.error).forEach(r => {
      log(`  - ${r.videoId}: ${r.error}`);
    });
  }

  log(`\nResults saved to ${RESULTS_FILE}`);

  await context.close();
  await browser.close();
  log('Browser closed. Script complete.');
}

// Run the script
main().catch(error => {
  log(`Fatal error: ${error}`);
  console.error(error);
  process.exit(1);
});
