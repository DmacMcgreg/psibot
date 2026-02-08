import { Database } from "bun:sqlite";
import { getConfig } from "../config.ts";
import { MIGRATIONS } from "./schema.ts";
import { createLogger } from "../shared/logger.ts";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

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

  for (const sql of MIGRATIONS) {
    _db.exec(sql);
  }

  log.info("Database initialized", { path: config.DB_PATH });
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
