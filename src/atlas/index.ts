import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("atlas");

export type AtlasKind =
  | "inbox"
  | "youtube"
  | "signal"
  | "research"
  | "scan"
  | "daily_log";

export interface AtlasIndexInput {
  kind: AtlasKind;
  sourceTable: string;
  sourceId: string;
  title: string;
  body?: string;
  url?: string | null;
  capturedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AtlasItem {
  id: number;
  kind: AtlasKind;
  source_table: string;
  source_id: string;
  title: string;
  body: string;
  url: string | null;
  captured_at: string;
  metadata_json: string;
  entity_extracted_at: string | null;
  embedded_at: string | null;
  updated_at: string;
}

export interface AtlasSearchResult {
  id: number;
  kind: AtlasKind;
  title: string;
  body: string;
  url: string | null;
  captured_at: string;
  metadata_json: string;
  rank: number;
}

const BODY_MAX_CHARS = 12000;

function clampBody(body: string | undefined): string {
  if (!body) return "";
  if (body.length <= BODY_MAX_CHARS) return body;
  return body.slice(0, BODY_MAX_CHARS);
}

/**
 * Upsert a row in atlas_items by (source_table, source_id).
 * Returns the atlas_items.id. Also syncs the FTS index.
 *
 * Ingestion is fast and synchronous — no embedding, no entity extraction.
 * Those happen on heartbeat-driven background queues.
 */
export function indexItem(input: AtlasIndexInput): number {
  const db = getDb();
  const body = clampBody(input.body);
  const metadata = JSON.stringify(input.metadata ?? {});
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const url = input.url ?? null;

  const existing = db
    .prepare<{ id: number; body: string; title: string }, [string, string]>(
      "SELECT id, body, title FROM atlas_items WHERE source_table = ? AND source_id = ?",
    )
    .get(input.sourceTable, input.sourceId);

  let id: number;
  let contentChanged: boolean;

  if (existing) {
    id = existing.id;
    contentChanged = existing.body !== body || existing.title !== input.title;
    db.prepare(
      `UPDATE atlas_items
       SET kind = ?, title = ?, body = ?, url = ?, captured_at = ?,
           metadata_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           entity_extracted_at = CASE WHEN ? THEN NULL ELSE entity_extracted_at END,
           embedded_at = CASE WHEN ? THEN NULL ELSE embedded_at END
       WHERE id = ?`,
    ).run(
      input.kind,
      input.title,
      body,
      url,
      capturedAt,
      metadata,
      contentChanged ? 1 : 0,
      contentChanged ? 1 : 0,
      id,
    );
  } else {
    contentChanged = true;
    const result = db
      .prepare(
        `INSERT INTO atlas_items
         (kind, source_table, source_id, title, body, url, captured_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.sourceTable,
        input.sourceId,
        input.title,
        body,
        url,
        capturedAt,
        metadata,
      );
    id = Number(result.lastInsertRowid);
  }

  if (contentChanged) {
    syncFts(id);
    // Drop any stale vector — embedding queue will refill.
    db.prepare("DELETE FROM atlas_items_vec WHERE rowid = ?").run(id);
  }

  return id;
}

/** Remove an atlas row + FTS + vector row by (source_table, source_id). */
export function removeItem(sourceTable: string, sourceId: string): void {
  const db = getDb();
  const row = db
    .prepare<{ id: number }, [string, string]>(
      "SELECT id FROM atlas_items WHERE source_table = ? AND source_id = ?",
    )
    .get(sourceTable, sourceId);
  if (!row) return;

  db.prepare("DELETE FROM atlas_items_fts WHERE rowid = ?").run(row.id);
  db.prepare("DELETE FROM atlas_items_vec WHERE rowid = ?").run(row.id);
  db.prepare("DELETE FROM atlas_items WHERE id = ?").run(row.id);
}

/**
 * Remove and re-insert the FTS row for a single atlas_items id.
 * Uses contentless-delete FTS5 (see schema.ts): DELETE-by-rowid is allowed,
 * but INSERT does not replace — we must delete first, then re-insert.
 */
export function syncFts(atlasId: number): void {
  const db = getDb();
  const row = db
    .prepare<{ title: string; body: string }, [number]>(
      "SELECT title, body FROM atlas_items WHERE id = ?",
    )
    .get(atlasId);
  if (!row) return;

  db.prepare("DELETE FROM atlas_items_fts WHERE rowid = ?").run(atlasId);
  db.prepare(
    "INSERT INTO atlas_items_fts (rowid, title, body) VALUES (?, ?, ?)",
  ).run(atlasId, row.title, row.body);
}

/** Full rebuild of the FTS index from atlas_items. Required after schema changes. */
export function rebuildFtsAll(): number {
  const db = getDb();
  // Contentless FTS5 does not allow plain DELETE. Use the built-in delete-all command.
  db.exec("INSERT INTO atlas_items_fts(atlas_items_fts) VALUES('delete-all')");
  const stmt = db.prepare(
    "INSERT INTO atlas_items_fts (rowid, title, body) SELECT id, title, body FROM atlas_items",
  );
  const res = stmt.run();
  log.info("Rebuilt atlas_items_fts", { rows: Number(res.changes) });
  return Number(res.changes);
}

export interface FtsSearchOpts {
  kind?: AtlasKind;
  since?: string;
  limit?: number;
}

/**
 * FTS-only search. Phase 2 adds a hybrid variant with vector KNN + entity boost.
 */
export function ftsSearch(query: string, opts: FtsSearchOpts = {}): AtlasSearchResult[] {
  const db = getDb();
  const limit = opts.limit ?? 25;
  const filters: string[] = [];
  const params: (string | number)[] = [];

  let sql = `
    SELECT a.id, a.kind, a.title, a.body, a.url, a.captured_at, a.metadata_json,
           bm25(atlas_items_fts) AS rank
    FROM atlas_items_fts
    JOIN atlas_items a ON a.id = atlas_items_fts.rowid
    WHERE atlas_items_fts MATCH ?
  `;
  params.push(query);

  if (opts.kind) {
    filters.push("a.kind = ?");
    params.push(opts.kind);
  }
  if (opts.since) {
    filters.push("a.captured_at >= ?");
    params.push(opts.since);
  }
  if (filters.length > 0) {
    sql += " AND " + filters.join(" AND ");
  }
  sql += " ORDER BY rank LIMIT ?";
  params.push(limit);

  return db
    .prepare<AtlasSearchResult, (string | number)[]>(sql)
    .all(...params);
}

/** Fetch a single row by id — handy for dashboards and agent tool previews. */
export function getItem(id: number): AtlasItem | null {
  const db = getDb();
  return (
    db
      .prepare<AtlasItem, [number]>("SELECT * FROM atlas_items WHERE id = ?")
      .get(id) ?? null
  );
}

/** List items by kind, most recent first. Used by the library UI. */
export function listByKind(kind: AtlasKind | null, limit = 50, offset = 0): AtlasItem[] {
  const db = getDb();
  if (kind) {
    return db
      .prepare<AtlasItem, [string, number, number]>(
        "SELECT * FROM atlas_items WHERE kind = ? ORDER BY captured_at DESC LIMIT ? OFFSET ?",
      )
      .all(kind, limit, offset);
  }
  return db
    .prepare<AtlasItem, [number, number]>(
      "SELECT * FROM atlas_items ORDER BY captured_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset);
}

export interface AtlasCounts {
  total: number;
  byKind: Record<string, number>;
  awaitingEmbedding: number;
  awaitingEntities: number;
}

export function counts(): AtlasCounts {
  const db = getDb();
  const total =
    (db.prepare("SELECT COUNT(*) AS n FROM atlas_items").get() as { n: number })
      .n;
  const byKindRows = db
    .prepare<{ kind: string; n: number }, []>(
      "SELECT kind, COUNT(*) AS n FROM atlas_items GROUP BY kind",
    )
    .all();
  const byKind: Record<string, number> = {};
  for (const row of byKindRows) byKind[row.kind] = row.n;
  const awaitingEmbedding = (db
    .prepare("SELECT COUNT(*) AS n FROM atlas_items WHERE embedded_at IS NULL")
    .get() as { n: number }).n;
  const awaitingEntities = (db
    .prepare(
      "SELECT COUNT(*) AS n FROM atlas_items WHERE entity_extracted_at IS NULL",
    )
    .get() as { n: number }).n;
  return { total, byKind, awaitingEmbedding, awaitingEntities };
}
