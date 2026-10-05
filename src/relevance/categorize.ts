/**
 * Categorise library items down the taxonomy with Jev and persist to
 * item_categories. One Jev call per item (all tree questions batched).
 *
 * Incremental: items already stored with the current taxonomy_version are
 * skipped unless `force`. Overrides in item_category_overrides always win and
 * are never overwritten by the model.
 */

import type { Database } from "bun:sqlite";
import { JevBudgetExceeded, type JevClient } from "./jev.ts";
import { ensureCategoryTables, type LibItem } from "./library.ts";
import {
  classifyFromProbs,
  DEFAULT_STOP_THRESHOLD,
  edgeProbsFromAnswers,
  resolveCategory,
  treePayload,
  type Classification,
  type Taxonomy,
} from "./taxonomy.ts";

export interface CategorizeOptions {
  force?: boolean;
  limit?: number | null;
  dryRun?: boolean;
  threshold?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface CategorizeResult {
  considered: number;
  skippedCurrent: number;
  classified: Array<{ item: LibItem; cls: Classification }>;
  overridden: number;
  written: number;
  errors: Array<{ key: string; error: string }>;
  budgetHit: boolean;
}

export function loadOverrides(db: Database): Map<string, Array<{ path: string; created_at: string }>> {
  const out = new Map<string, Array<{ path: string; created_at: string }>>();
  const rows = db
    .query<{ item_key: string; path: string; created_at: string }, []>(
      `SELECT item_key, path, created_at FROM item_category_overrides ORDER BY created_at, rowid`,
    )
    .all();
  for (const r of rows) {
    const list = out.get(r.item_key) ?? [];
    list.push({ path: r.path, created_at: r.created_at });
    out.set(r.item_key, list);
  }
  return out;
}

/** Record a human move (the future /library "move to category" action). */
export function recordOverride(db: Database, itemKey: string, path: string): void {
  ensureCategoryTables(db);
  db.run(`INSERT INTO item_category_overrides (item_key, path) VALUES (?, ?)`, [itemKey, path]);
  db.run(
    `INSERT INTO item_categories (item_key, kind, path, leaf, confidence, alt_json, taxonomy_version, updated_at)
     VALUES (?, ?, ?, ?, 1, json_object('source','override'), COALESCE((SELECT taxonomy_version FROM item_categories WHERE item_key = ?), 'override'), strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(item_key) DO UPDATE SET path = excluded.path, leaf = excluded.leaf, confidence = 1,
       alt_json = json_set(COALESCE(item_categories.alt_json, '{}'), '$.source', 'override'),
       updated_at = excluded.updated_at`,
    [itemKey, itemKey.split(":")[0], path, path, itemKey],
  );
}

/** Jev state for an item: its profile-free content only (cache-stable). */
export function itemState(item: LibItem): unknown {
  return { item: item.content };
}

export async function categorize(
  db: Database,
  client: JevClient,
  tax: Taxonomy,
  items: LibItem[],
  opts: CategorizeOptions = {},
): Promise<CategorizeResult> {
  if (!opts.dryRun) ensureCategoryTables(db);
  const threshold = opts.threshold ?? DEFAULT_STOP_THRESHOLD;
  const current = new Set<string>();
  if (!opts.force) {
    try {
      for (const r of db
        .query<{ item_key: string }, [string]>(`SELECT item_key FROM item_categories WHERE taxonomy_version = ?`)
        .all(tax.version)) current.add(r.item_key);
    } catch {
      /* table absent in dry run */
    }
  }
  let overrides = new Map<string, Array<{ path: string; created_at: string }>>();
  try {
    overrides = loadOverrides(db);
  } catch {
    /* table absent in dry run */
  }

  const todo = items.filter((i) => !current.has(i.key));
  const batch = opts.limit ? todo.slice(0, opts.limit) : todo;
  const res: CategorizeResult = {
    considered: items.length,
    skippedCurrent: items.length - todo.length,
    classified: [],
    overridden: 0,
    written: 0,
    errors: [],
    budgetHit: false,
  };

  const upsert = opts.dryRun
    ? null
    : db.prepare(
        `INSERT INTO item_categories (item_key, kind, path, leaf, confidence, alt_json, taxonomy_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(item_key) DO UPDATE SET kind = excluded.kind, path = excluded.path, leaf = excluded.leaf,
           confidence = excluded.confidence, alt_json = excluded.alt_json,
           taxonomy_version = excluded.taxonomy_version, updated_at = excluded.updated_at`,
      );

  // Chunk so a budget stop still persists what finished.
  const CHUNK = 64;
  for (let s = 0; s < batch.length; s += CHUNK) {
    const chunk = batch.slice(s, s + CHUNK);
    const answers = await client.askMany(chunk.map((i) => treePayload(tax, itemState(i))));
    const rows: Array<[string, string, string, string, number, string | null, string]> = [];
    for (let j = 0; j < chunk.length; j++) {
      const item = chunk[j];
      const a = answers[j];
      const ov = overrides.get(item.key) ?? [];
      if (a instanceof Error) {
        if (a instanceof JevBudgetExceeded) res.budgetHit = true;
        else res.errors.push({ key: item.key, error: a.message.slice(0, 200) });
        // An override still gets stored even without a model opinion.
        if (ov.length) {
          const st = resolveCategory(null, ov)!;
          rows.push([item.key, item.kind, st.path, st.leaf, st.confidence, st.altJson, tax.version]);
          res.overridden++;
        }
        continue;
      }
      const cls = classifyFromProbs(tax, edgeProbsFromAnswers(tax, a.answers), threshold);
      res.classified.push({ item, cls });
      const st = resolveCategory(cls, ov)!;
      if (ov.length) res.overridden++;
      rows.push([item.key, item.kind, st.path, st.leaf, st.confidence, st.altJson, tax.version]);
    }
    if (upsert && rows.length) {
      db.transaction(() => {
        for (const r of rows) upsert.run(...r);
      })();
      res.written += rows.length;
    }
    opts.onProgress?.(Math.min(s + CHUNK, batch.length), batch.length);
    if (res.budgetHit) break;
  }
  return res;
}

// ─── counts for the tree view ───────────────────────────────────────────────

export interface CountRow {
  path: string;
  n: number;
}

/** Items per stored path and kind (direct, not rolled up). */
export function categoryCounts(db: Database, version?: string): Array<{ path: string; kind: string; n: number }> {
  const where = version ? `WHERE taxonomy_version = ? OR alt_json LIKE '%"override"%'` : "";
  const q = db.query<{ path: string; kind: string; n: number }, string[]>(
    `SELECT path, kind, COUNT(*) AS n FROM item_categories ${where} GROUP BY path, kind`,
  );
  return version ? q.all(version) : q.all();
}

/** Render the taxonomy with rolled-up counts ("total (direct)"). */
export function renderTree(tax: Taxonomy, counts: Array<{ path: string; kind: string; n: number }>): string {
  const direct = new Map<string, number>();
  const kindsAt = new Map<string, Map<string, number>>();
  for (const c of counts) {
    direct.set(c.path, (direct.get(c.path) ?? 0) + c.n);
    const k = kindsAt.get(c.path) ?? new Map<string, number>();
    k.set(c.kind, (k.get(c.kind) ?? 0) + c.n);
    kindsAt.set(c.path, k);
  }
  const total = (id: string): number => {
    let s = 0;
    for (const [p, n] of direct) if (p === id || p.startsWith(`${id}/`)) s += n;
    return s;
  };
  const lines: string[] = [];
  const visit = (id: string, label: string, children: Taxonomy["roots"], depth: number) => {
    const d = direct.get(id) ?? 0;
    const t = total(id);
    const pad = "  ".repeat(depth);
    const unsorted = children.length && d ? `  (+${d} filed at this level)` : "";
    lines.push(`${pad}${String(t).padStart(4)}  ${id}  — ${label}${unsorted}`);
    for (const c of children) visit(c.id, c.label, c.children, depth + 1);
  };
  for (const r of tax.roots) visit(r.id, r.label, r.children, 0);
  const all = [...direct.values()].reduce((a, b) => a + b, 0);
  const unknown = [...direct.keys()].filter((p) => !tax.byId.has(p));
  lines.push(`\n${all} items categorised${unknown.length ? `; ${unknown.length} path(s) not in the current taxonomy: ${unknown.slice(0, 5).join(", ")}` : ""}`);
  return lines.join("\n");
}
