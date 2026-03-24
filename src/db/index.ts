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

  expandSourceCheckConstraints(_db);
  seedDefaultJobs(_db);

  log.info("Database initialized", { path: config.DB_PATH });
  return _db;
}

function expandSourceCheckConstraints(db: Database): void {
  const rebuilds = [
    {
      table: "chat_messages",
      createSql: `CREATE TABLE chat_messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('web', 'telegram', 'job', 'mini-app', 'heartbeat')),
        source_id TEXT,
        cost_usd REAL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      )`,
      indexes: [
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)",
        "CREATE INDEX IF NOT EXISTS idx_chat_messages_source ON chat_messages(source, source_id)",
      ],
    },
    {
      table: "agent_sessions",
      createSql: `CREATE TABLE agent_sessions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK(source IN ('web', 'telegram', 'job', 'mini-app', 'heartbeat')),
        source_id TEXT,
        model TEXT NOT NULL,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        label TEXT,
        forked_from TEXT
      )`,
      indexes: [
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_source ON agent_sessions(source, source_id)",
      ],
    },
  ];

  for (const { table, createSql, indexes } of rebuilds) {
    const row = db
      .prepare<{ sql: string }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
      )
      .get(table);
    if (!row || row.sql.includes("mini-app")) continue;

    log.info(`Rebuilding ${table} to expand source CHECK constraint`);
    db.exec(`DROP TABLE IF EXISTS ${table}_new`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${table}_new SELECT * FROM ${table}`);
    db.exec("BEGIN");
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    db.exec("COMMIT");
    for (const idx of indexes) {
      db.exec(idx);
    }
  }
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
