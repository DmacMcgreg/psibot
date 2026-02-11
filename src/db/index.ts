import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getConfig } from "../config.ts";
import { MIGRATIONS } from "./schema.ts";
import { createLogger } from "../shared/logger.ts";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// Use Homebrew SQLite which supports loadable extensions (Apple's doesn't)
Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");

const log = createLogger("db");

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) throw new Error("Database not initialized. Call initDb() first.");
  return _db;
}

export function initDb(): Database {
  if (_db) return _db;

  const config = getConfig();
  const dbDir = dirname(config.DB_PATH);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(config.DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA foreign_keys = ON");

  // Load sqlite-vec extension for vector search
  sqliteVec.load(_db);
  const vecInfo = _db.prepare("SELECT vec_version() as v").get() as { v: string };
  log.info("sqlite-vec loaded", { version: vecInfo.v });

  for (const sql of MIGRATIONS) {
    try {
      _db.exec(sql);
    } catch (e) {
      if (e instanceof Error && e.message.includes("duplicate column")) continue;
      throw e;
    }
  }

  seedDefaultJobs(_db);

  log.info("Database initialized", { path: config.DB_PATH });
  return _db;
}

function seedDefaultJobs(db: Database): void {
  const config = getConfig();
  if (!config.YOUTUBE_SOURCE_PLAYLIST_ID) return;

  const existing = db
    .prepare<{ id: number }, [string]>(`SELECT id FROM jobs WHERE name = ?`)
    .get("YouTube Watchlist Processor");

  if (!existing) {
    db.prepare(
      `INSERT INTO jobs (name, prompt, type, schedule, max_budget_usd, status, model) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "YouTube Watchlist Processor",
      "Process the YouTube watchlist playlist using youtube_process_playlist.",
      "cron",
      "0 * * * *",
      5.0,
      "enabled",
      "claude-sonnet-4-5-20250929"
    );
    log.info("Seeded default YouTube Watchlist Processor job");
  } else {
    // Backfill model for existing jobs that don't have one set
    db.prepare(
      `UPDATE jobs SET model = ? WHERE name = ? AND model IS NULL`
    ).run("claude-sonnet-4-5-20250929", "YouTube Watchlist Processor");
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
