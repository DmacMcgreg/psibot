/**
 * DB layer for the Discover triage: the discover_jev_triage DDL, and the
 * reads that turn the atlas/discovery tables into triage inputs — David's
 * ratings as a rubric (loadRubric), the un-rated todo queue (loadTodo) and
 * his own chosen videos with their deterministic stratified sample.
 *
 * Keep TRIAGE_DDL in sync with src/db/schema.ts.
 */

import type { Database } from "bun:sqlite";
import { isChosenVideo } from "./labels.ts";

export const TRIAGE_DDL = [
  `CREATE TABLE IF NOT EXISTS discover_jev_triage (
    atlas_item_id INTEGER PRIMARY KEY,
    decision TEXT NOT NULL CHECK(decision IN ('hide','pick','unsure')),
    p_not REAL,
    p_interest REAL,
    p_protected REAL,
    reason TEXT,
    model TEXT,
    run_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discover_jev_triage_decision ON discover_jev_triage(decision)`,
  `CREATE INDEX IF NOT EXISTS idx_discover_jev_triage_run ON discover_jev_triage(run_id)`,
];

export function ensureTriageTable(db: Database): void {
  for (const sql of TRIAGE_DDL) db.exec(sql);
}

// ─── rubric: David's own ratings ────────────────────────────────────────────

/** Source label for an eligible Discover item. Mirrors DISCOVER_SOURCE_SQL in src/discover/db.ts. */
const SOURCE_SQL = `CASE
    WHEN a.kind='youtube' AND yv.playlist_item_id IS NOT NULL THEN 'youtube_watchlater'
    WHEN a.kind='youtube' AND a.source_id IN (SELECT video_id FROM discovery_candidates) THEN 'youtube_discovery'
    WHEN a.kind='inbox' AND json_extract(a.metadata_json,'$.source')='github' THEN 'github'
    WHEN a.kind='inbox' AND json_extract(a.metadata_json,'$.source')='reddit' THEN 'reddit'
    ELSE NULL END`;

export const SOURCE_TEXT: Record<string, string> = {
  youtube_discovery: "YouTube video found automatically by PsiBot's discovery crawler (David did not pick it)",
  youtube_watchlater: "YouTube video David saved to his Watch Later playlist himself",
  github: "GitHub repository David starred",
  reddit: "Reddit post David saved",
};
export const SAVED_BY_DAVID = new Set(["youtube_watchlater", "github", "reddit"]);

export interface ItemFacts {
  atlasId: number;
  title: string;
  source: string;
  topicGroup: string | null;
  by: string | null;
  tags: string[];
  durationMin: number | null;
  hasTranscript: boolean | null;
  excerpt: string;
  /** Videos David chose from this item's channel (youtube only; 0 when none). */
  chosenFromChannel?: number;
}

export interface RubricExample extends ItemFacts {
  verdict: "interested" | "not_interested";
  reasons: string[];
  note: string | null;
}

interface ItemRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  metadata_json: string;
  src: string | null;
  group_label: string | null;
  channel_title: string | null;
  transcript_len: number | null;
  duration_seconds: number | null;
}

const ITEM_SELECT = `SELECT a.id, a.kind, a.title, a.body, a.metadata_json, (${SOURCE_SQL}) AS src,
    g.label AS group_label, yv.channel_title, length(yv.transcript_text) AS transcript_len,
    (SELECT MAX(duration_seconds) FROM discovery_candidates dc WHERE dc.video_id = a.source_id) AS duration_seconds
  FROM atlas_items a
  JOIN discover_item_groups ig ON ig.atlas_item_id = a.id
  LEFT JOIN discover_topic_groups g ON g.id = ig.group_id
  LEFT JOIN youtube_videos yv ON a.kind = 'youtube' AND yv.video_id = a.source_id`;

/** Collapse whitespace, drop markdown headings/emphasis, clip. */
export function excerptOf(body: string, n = 420): string {
  const t = (body ?? "")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return (JSON.parse(s ?? "") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function toFacts(r: ItemRow): ItemFacts {
  const meta = parseJson<Record<string, unknown>>(r.metadata_json, {});
  const tags = Array.isArray(meta.tags)
    ? (meta.tags as unknown[]).map(String).filter((t) => t !== "auto-generated" && t !== "fallback").slice(0, 6)
    : [];
  // The overview's first line repeats the title in bold; skip past it.
  let body = r.body ?? "";
  if (r.kind === "youtube") body = body.replace(/^## Overview\s*\*\*[^\n]*\*\*\s*/m, "").split(/\n## /)[0] ?? body;
  return {
    atlasId: r.id,
    title: r.title,
    source: r.src ?? "other",
    topicGroup: r.group_label,
    by: r.channel_title || (typeof meta.channel === "string" ? meta.channel : null),
    tags,
    durationMin: r.duration_seconds ? Math.round(r.duration_seconds / 6) / 10 : null,
    hasTranscript: r.kind === "youtube" ? (r.transcript_len ?? 0) > 200 : null,
    excerpt: excerptOf(body),
  };
}

/** Latest rating per item; skipped is neutral and not part of the rubric. */
export function loadRubric(db: Database): RubricExample[] {
  const rows = db
    .query<ItemRow & { sentiment: string; reasons_json: string; note: string | null }, []>(
      `${ITEM_SELECT.replace("SELECT a.id,", "SELECT f.sentiment, f.reasons_json, f.note, a.id,")}
       JOIN discover_feedback f ON f.atlas_item_id = a.id
       WHERE f.id = (SELECT MAX(id) FROM discover_feedback f2 WHERE f2.atlas_item_id = a.id)
       ORDER BY f.id`,
    )
    .all();
  return rows
    .filter((r) => r.sentiment === "interested" || r.sentiment === "not_interested")
    .map((r) => ({
      ...toFacts(r),
      verdict: r.sentiment as RubricExample["verdict"],
      reasons: parseJson<string[]>(r.reasons_json, []).filter((x) => x && x !== "skipped"),
      note: r.note?.trim() || null,
    }));
}

/**
 * Unrated, un-triaged items currently eligible for /discover. Eligibility
 * mirrors ELIGIBLE_WHERE in vivaldi-home lib/collectors.ts and
 * DISCOVER_SOURCE_SQL in src/discover/db.ts. Deterministic pseudo-random
 * order so `--limit N` samples every source.
 */
export function loadTodo(db: Database, opts: { includeTriaged?: boolean } = {}): ItemFacts[] {
  const triaged = opts.includeTriaged || !hasTable(db, "discover_jev_triage")
    ? ""
    : `AND NOT EXISTS (SELECT 1 FROM discover_jev_triage t WHERE t.atlas_item_id = a.id)`;
  const rows = db
    .query<ItemRow, []>(
      `${ITEM_SELECT}
       WHERE NOT EXISTS (SELECT 1 FROM discover_feedback f WHERE f.atlas_item_id = a.id)
         ${triaged}
         AND (${SOURCE_SQL}) IS NOT NULL
       ORDER BY (a.id * 2654435761) % 4294967296`,
    )
    .all();
  return rows.map(toFacts);
}

// ─── chosen videos: David's own picks (positive side of the rubric) ──────────

export interface ChosenVideo {
  videoId: string;
  title: string;
  channel: string;
  tags: string[];
  /** Stratum: Jev taxonomy top-level topic (item_categories), else the Discover group. */
  topic: string | null;
  topicGroup: string | null;
  atlasId: number | null;
}

/**
 * Videos David chose himself: Watch Later, or sent to PsiBot before (or
 * without) discovery finding them — `isChosenVideo` in labels.ts. Discovery
 * finds are NOT positives.
 */
export function loadChosenVideos(db: Database): ChosenVideo[] {
  const rows = db
    .query<{ video_id: string; title: string; channel_title: string; tags: string; created_at: string; playlist_item_id: string | null; first_discovered_at: string | null; group_label: string | null; atlas_id: number | null; tax_path: string | null }, []>(
      `SELECT yv.video_id, yv.title, yv.channel_title, yv.tags, yv.created_at, yv.playlist_item_id,
              (SELECT MIN(discovered_at) FROM discovery_candidates dc WHERE dc.video_id = yv.video_id) AS first_discovered_at,
              a.id AS atlas_id, g.label AS group_label, ${hasTable(db, "item_categories")
                ? `(SELECT path FROM item_categories c WHERE c.item_key = 'video:' || yv.video_id)`
                : "NULL"} AS tax_path
         FROM youtube_videos yv
         LEFT JOIN atlas_items a ON a.kind = 'youtube' AND a.source_id = yv.video_id
         LEFT JOIN discover_item_groups ig ON ig.atlas_item_id = a.id
         LEFT JOIN discover_topic_groups g ON g.id = ig.group_id`,
    )
    .all();
  return rows.filter(isChosenVideo).map((r) => ({
    videoId: r.video_id,
    title: r.title,
    channel: r.channel_title,
    tags: parseJson<unknown[]>(r.tags, []).map(String).filter((t) => t !== "auto-generated" && t !== "fallback").slice(0, 3),
    topic: r.tax_path?.split("/")[0] ?? r.group_label,
    topicGroup: r.group_label,
    atlasId: r.atlas_id,
  }));
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Topic-stratified, deterministic sample: round-robin over topic groups
 * (largest first), one video at a time, in a stable hashed order, skipping
 * any video in `exclude` (atlas ids still waiting for triage or already rated,
 * so an item never serves as its own example) and repeating channels until
 * every group's fresh channels are used up.
 */
export function sampleChosen(chosen: ChosenVideo[], n: number, exclude: Set<number> = new Set()): ChosenVideo[] {
  const byGroup = new Map<string, ChosenVideo[]>();
  for (const v of chosen) {
    if (v.atlasId !== null && exclude.has(v.atlasId)) continue;
    const g = v.topic ?? "(no topic)";
    const list = byGroup.get(g) ?? [];
    list.push(v);
    byGroup.set(g, list);
  }
  const queues = [...byGroup.values()]
    .sort((a, b) => b.length - a.length)
    .map((l) => l.sort((a, b) => hash32(a.videoId) - hash32(b.videoId)));
  const out: ChosenVideo[] = [];
  const seenChannel = new Set<string>();
  for (let pass = 0; out.length < n && queues.some((q) => q.length); pass++) {
    for (const q of queues) {
      if (out.length >= n) break;
      // Prefer a channel not yet in the sample; fall back to the next video.
      const i = q.findIndex((v) => !seenChannel.has(v.channel));
      const [v] = q.splice(i >= 0 ? i : 0, 1);
      if (!v) continue;
      out.push(v);
      seenChannel.add(v.channel);
    }
  }
  return out;
}

export function hasTable(db: Database, name: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}
