import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { float32ToBase64, base64ToFloat32 } from "../discovery/profile.ts";
import { cosineSimilarity } from "../discovery/scoring.ts";

const log = createLogger("discover:db");

/**
 * Discover — a topic-clustered, feedback-driven view over the shared `atlas_items`
 * index. No item table of its own: the four sources (YouTube discovery, YouTube
 * watch-laters, GitHub stars, Reddit saved) are already projected into
 * atlas_items + atlas_items_vec. This module owns the grouping + feedback layer.
 * See docs/plans/2026-07-15-discover-mini-app.md.
 */

export const EMBEDDING_DIMS = 768;

export type DiscoverSource =
  | "youtube_discovery"
  | "youtube_watchlater"
  | "github"
  | "reddit";

export type Sentiment = "interested" | "not_interested" | "skipped";

export interface DiscoverGroup {
  id: number;
  slug: string;
  label: string;
  emoji: string | null;
  centroid: string | null;
  auto: number;
  sort_order: number;
  item_count: number;
  created_at: string;
  updated_at: string;
}

/** A joined, display-ready Discover item. */
export interface DiscoverItem {
  atlas_item_id: number;
  discover_source: DiscoverSource;
  title: string;
  body: string;
  url: string | null;
  captured_at: string;
  metadata_json: string;
  channel_title: string | null;
  score_breakdown_json: string | null;
  group_id: number | null;
  chips_json: string | null;
  feedback_sentiment: Sentiment | null;
}

/**
 * SQL fragment classifying an atlas row into one of the four Discover sources
 * (or NULL to exclude — e.g. manual /youtube summaries, and the youtube→inbox
 * cross-post dupe). Reused by every eligible-item query. Requires the joins in
 * FROM_ELIGIBLE.
 */
const DISCOVER_SOURCE_SQL = `
  CASE
    WHEN a.kind='youtube' AND yv.playlist_item_id IS NOT NULL THEN 'youtube_watchlater'
    WHEN a.kind='youtube' AND dc.video_id IS NOT NULL THEN 'youtube_discovery'
    WHEN a.kind='inbox' AND json_extract(a.metadata_json,'$.source')='github' THEN 'github'
    WHEN a.kind='inbox' AND json_extract(a.metadata_json,'$.source')='reddit' THEN 'reddit'
    ELSE NULL
  END`;

// discovery_candidates has UNIQUE(video_id, source) → multiple rows per video.
// Collapse to the best-scored row so match % is stable and joins don't multiply.
const FROM_ELIGIBLE = `
  FROM atlas_items a
  LEFT JOIN youtube_videos yv ON a.kind='youtube' AND yv.video_id = a.source_id
  LEFT JOIN (
    SELECT video_id, MAX(score) AS score, score_breakdown_json
    FROM discovery_candidates GROUP BY video_id
  ) dc ON a.kind='youtube' AND dc.video_id = a.source_id
  LEFT JOIN discover_item_groups ig ON ig.atlas_item_id = a.id
  LEFT JOIN discover_feedback fb ON fb.atlas_item_id = a.id`;

const SELECT_ITEM = `
  SELECT a.id AS atlas_item_id,
         (${DISCOVER_SOURCE_SQL}) AS discover_source,
         a.title, a.body, a.url, a.captured_at, a.metadata_json,
         yv.channel_title AS channel_title,
         dc.score_breakdown_json AS score_breakdown_json,
         ig.group_id AS group_id,
         ig.chips_json AS chips_json,
         (SELECT sentiment FROM discover_feedback WHERE atlas_item_id = a.id
          ORDER BY id DESC LIMIT 1) AS feedback_sentiment
  ${FROM_ELIGIBLE}`;

// --- Groups ---

export function listGroups(): DiscoverGroup[] {
  return getDb()
    .prepare<DiscoverGroup, []>(
      `SELECT * FROM discover_topic_groups ORDER BY sort_order ASC, item_count DESC, label ASC`,
    )
    .all();
}

export function getDbGroupCount(): number {
  return getDb().prepare<{ c: number }, []>(`SELECT COUNT(*) AS c FROM discover_topic_groups`).get()?.c ?? 0;
}

export function getGroup(id: number): DiscoverGroup | null {
  return (
    getDb()
      .prepare<DiscoverGroup, [number]>(`SELECT * FROM discover_topic_groups WHERE id = ?`)
      .get(id) ?? null
  );
}

export function getGroupBySlug(slug: string): DiscoverGroup | null {
  return (
    getDb()
      .prepare<DiscoverGroup, [string]>(`SELECT * FROM discover_topic_groups WHERE slug = ?`)
      .get(slug) ?? null
  );
}

function slugify(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "topic";
  // Ensure uniqueness with a numeric suffix if needed.
  let slug = base;
  let n = 2;
  while (getGroupBySlug(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

export function createGroup(params: {
  label: string;
  emoji?: string | null;
  centroid?: Float32Array | null;
  auto?: boolean;
}): DiscoverGroup {
  const slug = slugify(params.label);
  const centroidB64 = params.centroid ? float32ToBase64(params.centroid) : null;
  const row = getDb()
    .prepare<DiscoverGroup, [string, string, string | null, string | null, number]>(
      `INSERT INTO discover_topic_groups (slug, label, emoji, centroid, auto)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(slug, params.label, params.emoji ?? null, centroidB64, params.auto === false ? 0 : 1);
  log.info("Created discover group", { slug, label: params.label });
  return row!;
}

/** Update a group's label/emoji/auto (user or taxonomy curation). */
export function updateGroup(
  id: number,
  patch: { label?: string; emoji?: string | null; sort_order?: number; auto?: boolean },
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (patch.label !== undefined) { sets.push("label = ?"); vals.push(patch.label); }
  if (patch.emoji !== undefined) { sets.push("emoji = ?"); vals.push(patch.emoji); }
  if (patch.sort_order !== undefined) { sets.push("sort_order = ?"); vals.push(patch.sort_order); }
  if (patch.auto !== undefined) { sets.push("auto = ?"); vals.push(patch.auto ? 1 : 0); }
  if (sets.length === 0) return;
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
  vals.push(id);
  getDb().prepare(`UPDATE discover_topic_groups SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

/**
 * Set a group's label + emoji and regenerate its slug from the new label.
 * Used by the indexer right after a cluster is created, before any external
 * link to it exists, so the reslug is safe. Falls back to keeping the old slug
 * on collision.
 */
export function relabelGroup(id: number, label: string, emoji: string | null): void {
  const current = getGroup(id);
  const newSlug = slugify(label);
  getDb()
    .prepare(
      `UPDATE discover_topic_groups
       SET label = ?, emoji = ?, slug = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    )
    .run(label, emoji, current && !getGroupBySlug(newSlug) ? newSlug : (current?.slug ?? newSlug), id);
}

export function loadGroupCentroid(g: DiscoverGroup): Float32Array | null {
  if (!g.centroid) return null;
  try { return base64ToFloat32(g.centroid); } catch { return null; }
}

/** Persist a new centroid + refresh the group's item_count from assignments. */
export function saveGroupCentroid(id: number, centroid: Float32Array): void {
  getDb()
    .prepare(
      `UPDATE discover_topic_groups
       SET centroid = ?,
           item_count = (SELECT COUNT(*) FROM discover_item_groups WHERE group_id = ?),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    )
    .run(float32ToBase64(centroid), id, id);
}

/** Reassign every item from one group to another (used by taxonomy merges). */
export function reassignGroupItems(fromGroupId: number, toGroupId: number): void {
  getDb()
    .prepare(`UPDATE discover_item_groups SET group_id = ? WHERE group_id = ?`)
    .run(toGroupId, fromGroupId);
}

export function deleteGroup(id: number): void {
  getDb().prepare(`DELETE FROM discover_topic_groups WHERE id = ?`).run(id);
}

/** Wipe all groups + assignments (cascade). Used for a full recluster. */
export function deleteAllGroups(): void {
  getDb().prepare(`DELETE FROM discover_topic_groups`).run();
}

/** Recompute a group's centroid as the mean of its members' embeddings. */
export function recomputeGroupCentroid(id: number): void {
  const ids = getDb()
    .prepare<{ atlas_item_id: number }, [number]>(
      `SELECT atlas_item_id FROM discover_item_groups WHERE group_id = ?`,
    )
    .all(id)
    .map((r) => r.atlas_item_id);
  if (ids.length === 0) return;
  const acc = new Float32Array(EMBEDDING_DIMS);
  let n = 0;
  for (const itemId of ids) {
    const v = getItemEmbedding(itemId);
    if (!v) continue;
    for (let i = 0; i < EMBEDDING_DIMS; i++) acc[i] += v[i];
    n++;
  }
  if (n === 0) return;
  for (let i = 0; i < EMBEDDING_DIMS; i++) acc[i] /= n;
  saveGroupCentroid(id, acc);
}

// --- Assignment ---

/** Assign (or reassign) an atlas item to a group. */
export function assignItem(atlasItemId: number, groupId: number, similarity: number): void {
  getDb()
    .prepare(
      `INSERT INTO discover_item_groups (atlas_item_id, group_id, similarity)
       VALUES (?, ?, ?)
       ON CONFLICT(atlas_item_id) DO UPDATE SET
         group_id = excluded.group_id,
         similarity = excluded.similarity,
         assigned_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    )
    .run(atlasItemId, groupId, similarity);
}

/**
 * Read an atlas item's stored embedding (768-dim) by id, or null if unembedded.
 * bun:sqlite returns a vec0 embedding column as a raw BLOB (Uint8Array of
 * 768×4 bytes), so we reinterpret those bytes as Float32 rather than trusting
 * the driver to hand back a typed float array.
 */
export function getItemEmbedding(atlasItemId: number): Float32Array | null {
  const row = getDb()
    .prepare<{ embedding: unknown }, [number]>(
      `SELECT embedding FROM atlas_items_vec WHERE rowid = ?`,
    )
    .get(atlasItemId);
  const emb = row?.embedding;
  if (!emb) return null;
  if (emb instanceof Float32Array) return emb;
  const u8 =
    emb instanceof Uint8Array
      ? emb
      : emb instanceof ArrayBuffer
        ? new Uint8Array(emb)
        : null;
  if (!u8 || u8.byteLength % 4 !== 0) return null;
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

/** Eligible atlas items (four-source) not yet assigned to a group. */
export function getUnassignedEligible(limit: number): { atlas_item_id: number; discover_source: DiscoverSource }[] {
  return getDb()
    .prepare<{ atlas_item_id: number; discover_source: DiscoverSource }, [number]>(
      `SELECT a.id AS atlas_item_id, (${DISCOVER_SOURCE_SQL}) AS discover_source
       ${FROM_ELIGIBLE}
       WHERE ig.atlas_item_id IS NULL AND (${DISCOVER_SOURCE_SQL}) IS NOT NULL
       ORDER BY a.captured_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

// --- Display reads ---

export type ItemFilter = "new" | "interested" | "all";

/** Items in a group, filtered by feedback state. "new" = no feedback yet. */
export function itemsInGroup(groupId: number, filter: ItemFilter, limit = 100): DiscoverItem[] {
  let clause = "";
  if (filter === "new") clause = "AND fb.id IS NULL";
  else if (filter === "interested") {
    clause = `AND (SELECT sentiment FROM discover_feedback WHERE atlas_item_id = a.id ORDER BY id DESC LIMIT 1) = 'interested'`;
  }
  return getDb()
    .prepare<DiscoverItem, [number, number]>(
      `${SELECT_ITEM}
       WHERE ig.group_id = ? AND (${DISCOVER_SOURCE_SQL}) IS NOT NULL ${clause}
       GROUP BY a.id
       ORDER BY (fb.id IS NULL) DESC, a.captured_at DESC
       LIMIT ?`,
    )
    .all(groupId, limit);
}

export function getItem(atlasItemId: number): DiscoverItem | null {
  return (
    getDb()
      .prepare<DiscoverItem, [number]>(
        `${SELECT_ITEM} WHERE a.id = ? GROUP BY a.id`,
      )
      .get(atlasItemId) ?? null
  );
}

/** Per-group summary for the Discover list: new count + source mix + previews. */
export interface GroupSummary extends DiscoverGroup {
  new_count: number;
  yt_count: number;
  gh_count: number;
  rd_count: number;
  previews: string[];
}

export function groupSummaries(): GroupSummary[] {
  const groups = listGroups();
  const db = getDb();
  const countStmt = db.prepare<{ discover_source: DiscoverSource; c: number; newc: number }, [number]>(
    `SELECT (${DISCOVER_SOURCE_SQL}) AS discover_source,
            COUNT(*) AS c,
            SUM(CASE WHEN fb.id IS NULL THEN 1 ELSE 0 END) AS newc
     ${FROM_ELIGIBLE}
     WHERE ig.group_id = ? AND (${DISCOVER_SOURCE_SQL}) IS NOT NULL
     GROUP BY discover_source`,
  );
  const previewStmt = db.prepare<{ title: string }, [number]>(
    `SELECT a.title
     ${FROM_ELIGIBLE}
     WHERE ig.group_id = ? AND (${DISCOVER_SOURCE_SQL}) IS NOT NULL AND fb.id IS NULL
     GROUP BY a.id
     ORDER BY a.captured_at DESC LIMIT 3`,
  );
  return groups.map((g) => {
    const rows = countStmt.all(g.id);
    let newCount = 0, yt = 0, gh = 0, rd = 0;
    for (const r of rows) {
      newCount += r.newc ?? 0;
      if (r.discover_source === "github") gh += r.c;
      else if (r.discover_source === "reddit") rd += r.c;
      else yt += r.c; // discovery + watchlater
    }
    const previews = previewStmt.all(g.id).map((p) => p.title);
    return { ...g, new_count: newCount, yt_count: yt, gh_count: gh, rd_count: rd, previews };
  });
}

/** Total new (unrated) eligible items + distinct groups with new items. */
export function newSummary(): { newCount: number; groupCount: number; bySource: Record<string, number> } {
  const rows = getDb()
    .prepare<{ discover_source: DiscoverSource; c: number }, []>(
      `SELECT (${DISCOVER_SOURCE_SQL}) AS discover_source, COUNT(*) AS c
       ${FROM_ELIGIBLE}
       WHERE fb.id IS NULL AND (${DISCOVER_SOURCE_SQL}) IS NOT NULL
       GROUP BY discover_source`,
    )
    .all();
  const bySource: Record<string, number> = {};
  let newCount = 0;
  for (const r of rows) { bySource[r.discover_source] = r.c; newCount += r.c; }
  const groupCount = getDb()
    .prepare<{ c: number }, []>(
      `SELECT COUNT(DISTINCT ig.group_id) AS c
       ${FROM_ELIGIBLE}
       WHERE fb.id IS NULL AND ig.group_id IS NOT NULL AND (${DISCOVER_SOURCE_SQL}) IS NOT NULL`,
    )
    .get()?.c ?? 0;
  return { newCount, groupCount, bySource };
}

// --- Chips ---

export function setChips(atlasItemId: number, chipsJson: string): void {
  getDb()
    .prepare(`UPDATE discover_item_groups SET chips_json = ? WHERE atlas_item_id = ?`)
    .run(chipsJson, atlasItemId);
}

// --- Feedback ---

export function recordFeedback(params: {
  atlasItemId: number;
  groupId: number | null;
  sentiment: Sentiment;
  reasons: string[];
  note?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO discover_feedback (atlas_item_id, group_id, sentiment, reasons_json, note)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      params.atlasItemId,
      params.groupId,
      params.sentiment,
      JSON.stringify(params.reasons ?? []),
      params.note ?? null,
    );
}

/**
 * One-tap skip for every still-"new" (unrated) item in a group. Inserts a
 * lightweight `skipped` feedback row per item so they leave the New filter
 * without contributing a negative-interest signal. Returns the count skipped.
 */
export function skipNewInGroup(groupId: number): number {
  const db = getDb();
  const ids = db
    .prepare<{ id: number }, [number]>(
      `SELECT a.id FROM atlas_items a
       JOIN discover_item_groups ig ON ig.atlas_item_id = a.id
       LEFT JOIN discover_feedback fb ON fb.atlas_item_id = a.id
       WHERE ig.group_id = ? AND fb.id IS NULL`,
    )
    .all(groupId)
    .map((r) => r.id);
  if (ids.length === 0) return 0;
  const ins = db.prepare(
    `INSERT INTO discover_feedback (atlas_item_id, group_id, sentiment, reasons_json)
     VALUES (?, ?, 'skipped', '["skipped"]')`,
  );
  const tx = db.transaction((list: number[]) => {
    for (const id of list) ins.run(id, groupId);
  });
  tx(ids);
  return ids.length;
}

export { cosineSimilarity };
