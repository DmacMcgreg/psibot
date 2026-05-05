import { getDb } from "../db/index.ts";
import { embedText } from "../shared/embeddings.ts";
import { createLogger } from "../shared/logger.ts";
import type { AtlasKind, AtlasSearchResult } from "./index.ts";

const log = createLogger("atlas:search");

export interface HybridSearchOpts {
  kind?: AtlasKind;
  since?: string;
  limit?: number;
  /** Entity name to boost results that mention it. Zeroed in Phase 2, real in Phase 3. */
  entity?: string | null;
  /** Weights — overrideable for tuning. */
  ftsWeight?: number;
  vecWeight?: number;
  entityWeight?: number;
}

export interface HybridSearchResult extends AtlasSearchResult {
  score: number;
  ftsRank: number | null;
  vecDistance: number | null;
}

/** Escape an FTS5 query string — if there are illegal tokens fall back to quoted phrase. */
function escapeFtsQuery(query: string): string {
  const clean = query.trim().replace(/"/g, '""');
  if (!clean) return '""';
  // If the user wrote FTS operators (AND, OR, NEAR, column:term, quoted phrases), let them through.
  if (/["*:()]/.test(clean) || /\b(AND|OR|NOT|NEAR)\b/.test(clean)) {
    return clean;
  }
  // Otherwise treat the whole thing as a phrase to guarantee safety.
  return `"${clean}"`;
}

interface FtsRow {
  id: number;
  kind: AtlasKind;
  title: string;
  body: string;
  url: string | null;
  captured_at: string;
  metadata_json: string;
  rank: number;
}

interface VecRow {
  rowid: number;
  distance: number;
}

interface ItemRow {
  id: number;
  kind: AtlasKind;
  title: string;
  body: string;
  url: string | null;
  captured_at: string;
  metadata_json: string;
}

function buildFilters(opts: HybridSearchOpts, params: (string | number)[]): string {
  const filters: string[] = [];
  if (opts.kind) {
    filters.push("a.kind = ?");
    params.push(opts.kind);
  }
  if (opts.since) {
    filters.push("a.captured_at >= ?");
    params.push(opts.since);
  }
  return filters.length > 0 ? " AND " + filters.join(" AND ") : "";
}

/**
 * Hybrid FTS + vector KNN search.
 * - FTS side: BM25 rank (lower is better) normalized to a 0..1 score.
 * - Vector side: cosine distance (lower is better) normalized to a 0..1 score.
 * - Entity boost (Phase 3): stubbed; returns 0 until entity tables exist.
 *
 * Final score = ftsWeight * ftsScore + vecWeight * vecScore + entityWeight * entityScore
 */
export async function hybridSearch(
  query: string,
  opts: HybridSearchOpts = {},
): Promise<HybridSearchResult[]> {
  const db = getDb();
  const limit = opts.limit ?? 25;
  const ftsWeight = opts.ftsWeight ?? 0.55;
  const vecWeight = opts.vecWeight ?? 0.35;
  const entityWeight = opts.entityWeight ?? 0.10;
  const candidatePool = Math.max(limit * 4, 40);

  // --- FTS side ---
  const ftsParams: (string | number)[] = [];
  const escapedQuery = escapeFtsQuery(query);
  ftsParams.push(escapedQuery);
  const ftsFilters = buildFilters(opts, ftsParams);
  ftsParams.push(candidatePool);

  let ftsRows: FtsRow[] = [];
  try {
    ftsRows = db
      .prepare<FtsRow, (string | number)[]>(
        `SELECT a.id, a.kind, a.title, a.body, a.url, a.captured_at, a.metadata_json,
                bm25(atlas_items_fts) AS rank
         FROM atlas_items_fts
         JOIN atlas_items a ON a.id = atlas_items_fts.rowid
         WHERE atlas_items_fts MATCH ?${ftsFilters}
         ORDER BY rank LIMIT ?`,
      )
      .all(...ftsParams);
  } catch (err) {
    log.warn("FTS query failed, falling back to empty FTS side", {
      error: String(err),
      query,
    });
  }

  // --- Vector side ---
  let vecRows: VecRow[] = [];
  let queryVec: Float32Array | null = null;
  try {
    queryVec = await embedText(query);
    const vecParams: (Float32Array | number | string)[] = [queryVec];
    const vecFilterClauses: string[] = [];
    if (opts.kind) {
      vecFilterClauses.push("a.kind = ?");
      vecParams.push(opts.kind);
    }
    if (opts.since) {
      vecFilterClauses.push("a.captured_at >= ?");
      vecParams.push(opts.since);
    }
    vecParams.push(candidatePool);
    const vecFilter =
      vecFilterClauses.length > 0
        ? " AND " + vecFilterClauses.join(" AND ")
        : "";
    vecRows = db
      .prepare<VecRow, (Float32Array | number | string)[]>(
        `SELECT atlas_items_vec.rowid, atlas_items_vec.distance
         FROM atlas_items_vec
         JOIN atlas_items a ON a.id = atlas_items_vec.rowid
         WHERE atlas_items_vec.embedding MATCH ? AND atlas_items_vec.k = ${candidatePool}${vecFilter}
         ORDER BY atlas_items_vec.distance
         LIMIT ?`,
      )
      .all(...vecParams);
  } catch (err) {
    log.warn("Vector query failed, falling back to FTS-only", {
      error: String(err),
      query,
    });
  }

  // --- Merge ---
  type Merged = {
    id: number;
    ftsRank: number | null;
    vecDistance: number | null;
    entityScore: number;
  };
  const merged = new Map<number, Merged>();
  for (const r of ftsRows) {
    merged.set(r.id, {
      id: r.id,
      ftsRank: r.rank,
      vecDistance: null,
      entityScore: 0,
    });
  }
  for (const v of vecRows) {
    const cur = merged.get(v.rowid);
    if (cur) {
      cur.vecDistance = v.distance;
    } else {
      merged.set(v.rowid, {
        id: v.rowid,
        ftsRank: null,
        vecDistance: v.distance,
        entityScore: 0,
      });
    }
  }

  if (merged.size === 0) return [];

  // Normalize: BM25 ranks are negative (more negative = more relevant). Flip to positive magnitude.
  const ftsValues = ftsRows.map((r) => -r.rank).filter((v) => Number.isFinite(v));
  const ftsMin = ftsValues.length ? Math.min(...ftsValues) : 0;
  const ftsMax = ftsValues.length ? Math.max(...ftsValues) : 1;
  const ftsRange = ftsMax - ftsMin || 1;

  const vecValues = vecRows.map((v) => v.distance).filter((v) => Number.isFinite(v));
  const vecMin = vecValues.length ? Math.min(...vecValues) : 0;
  const vecMax = vecValues.length ? Math.max(...vecValues) : 1;
  const vecRange = vecMax - vecMin || 1;

  // --- Entity boost (Phase 3) ---
  if (opts.entity) {
    const hasEntityTables =
      db
        .prepare<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get("atlas_entities")?.n ?? 0;
    if (hasEntityTables > 0) {
      const q = opts.entity.trim();
      const normTicker = q.replace(/^\$/, "").toUpperCase();
      const normOther = q.toLowerCase().replace(/\s+/g, " ");
      const rows = db
        .prepare<
          { item_id: number; confidence: number },
          [string, string, string]
        >(
          `SELECT m.item_id, MAX(m.confidence) AS confidence
           FROM atlas_entity_mentions m
           JOIN atlas_entities e ON e.id = m.entity_id
           LEFT JOIN atlas_entity_aliases a ON a.entity_id = e.id
           WHERE e.name_norm = ?
              OR e.name_norm = ?
              OR a.alias_norm = ?
           GROUP BY m.item_id`,
        )
        .all(normTicker, normOther, normOther);
      const boostMap = new Map<number, number>();
      for (const row of rows) {
        boostMap.set(row.item_id, row.confidence);
      }
      for (const [id, score] of boostMap) {
        const cur = merged.get(id);
        if (cur) cur.entityScore = score;
      }
    }
  }

  // --- Score and hydrate ---
  const scored: HybridSearchResult[] = [];
  const rowById = new Map<number, ItemRow>();
  if (merged.size > 0) {
    const placeholders = Array.from({ length: merged.size })
      .map(() => "?")
      .join(",");
    const ids = [...merged.keys()];
    const rows = db
      .prepare<ItemRow, number[]>(
        `SELECT id, kind, title, body, url, captured_at, metadata_json
         FROM atlas_items
         WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    for (const row of rows) rowById.set(row.id, row);
  }

  for (const m of merged.values()) {
    const row = rowById.get(m.id);
    if (!row) continue;
    const ftsScore =
      m.ftsRank !== null
        ? (-m.ftsRank - ftsMin) / ftsRange
        : 0;
    const vecScore =
      m.vecDistance !== null
        ? 1 - (m.vecDistance - vecMin) / vecRange
        : 0;
    const score =
      ftsWeight * ftsScore + vecWeight * vecScore + entityWeight * m.entityScore;
    scored.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      url: row.url,
      captured_at: row.captured_at,
      metadata_json: row.metadata_json,
      rank: score,
      score,
      ftsRank: m.ftsRank,
      vecDistance: m.vecDistance,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
