// db-news.ts — persisted mineNews() output (discovery_news_items), split from
// db.ts (which was 642 physical lines; cap 500). db.ts re-exports this
// module's surface so existing `./db.ts` importers keep their import path.

import { getDb } from "../db/index.ts";

// mineNews() (src/discovery/news.ts) previously produced ephemeral output —
// surfaced to Telegram once, then lost. This table persists it so the weekly
// digest (src/digest/compose.ts) can pull the week's mined news highlights.
// Created lazily here (not in src/db/schema.ts's central migrations list) to
// keep the discovery subsystem's storage self-contained, matching the
// modules' existing pattern of owning their own tables end-to-end.

let newsTableReady = false;

function ensureNewsItemsTable(): void {
  if (newsTableReady) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT NOT NULL,
      what TEXT NOT NULL DEFAULT '',
      why_it_matters TEXT NOT NULL DEFAULT '',
      source_video_ids TEXT NOT NULL DEFAULT '[]',
      novelty REAL NOT NULL DEFAULT 0,
      video_count INTEGER NOT NULL DEFAULT 1,
      mined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_discovery_news_items_mined_at ON discovery_news_items(mined_at)`,
  );
  newsTableReady = true;
}

export interface PersistedNewsItem {
  id: number;
  headline: string;
  what: string;
  why_it_matters: string;
  source_video_ids: string;
  novelty: number;
  video_count: number;
  mined_at: string;
}

export function insertNewsItem(item: {
  headline: string;
  what: string;
  whyItMatters: string;
  sourceVideos: Array<{ videoId: string; title: string; channel: string }>;
  novelty: number;
  videoCount: number;
}): void {
  ensureNewsItemsTable();
  const db = getDb();
  db.prepare(
    `INSERT INTO discovery_news_items
       (headline, what, why_it_matters, source_video_ids, novelty, video_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    item.headline,
    item.what,
    item.whyItMatters,
    JSON.stringify(item.sourceVideos),
    item.novelty,
    item.videoCount,
  );
}

/** Mined news items with mined_at >= windowStart, newest first. */
export function getRecentNewsItems(windowStart: string, limit = 20): PersistedNewsItem[] {
  ensureNewsItemsTable();
  const db = getDb();
  return db
    .prepare<PersistedNewsItem, [string, number]>(
      `SELECT * FROM discovery_news_items WHERE mined_at >= ? ORDER BY mined_at DESC LIMIT ?`,
    )
    .all(windowStart, limit);
}
