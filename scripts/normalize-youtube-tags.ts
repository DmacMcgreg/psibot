import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";

loadConfig();
initDb();
const db = getDb();

const APPLY = process.argv.includes("--apply");

/**
 * Normalize a tag string to canonical form:
 *  - lowercase
 *  - replace runs of [space, underscore, hyphen, slash, dot, ampersand] with single hyphen
 *  - strip any char not [a-z0-9-]
 *  - collapse repeated hyphens
 *  - trim leading/trailing hyphens
 */
function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_\-/.&]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface VideoRow {
  id: number;
  video_id: string;
  tags: string;
}

const rows = db
  .prepare<VideoRow, []>(`SELECT id, video_id, tags FROM youtube_videos`)
  .all();

const originalUnique = new Set<string>();
const normalizedUnique = new Set<string>();
const collapseMap = new Map<string, Set<string>>();
let videosChanged = 0;
let totalAssignments = 0;
const updates: Array<{ id: number; newTags: string }> = [];

for (const row of rows) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.tags);
  } catch {
    continue;
  }
  if (!Array.isArray(parsed)) continue;

  const originals = parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  totalAssignments += originals.length;

  const normalized: string[] = [];
  const seen = new Set<string>();
  let dirty = false;

  for (const t of originals) {
    originalUnique.add(t);
    const norm = normalizeTag(t);
    if (norm.length === 0) {
      dirty = true;
      continue;
    }
    normalizedUnique.add(norm);
    if (!collapseMap.has(norm)) collapseMap.set(norm, new Set());
    collapseMap.get(norm)!.add(t);
    if (t !== norm) dirty = true;
    if (!seen.has(norm)) {
      seen.add(norm);
      normalized.push(norm);
    } else {
      dirty = true;
    }
  }

  if (dirty) {
    videosChanged++;
    updates.push({ id: row.id, newTags: JSON.stringify(normalized) });
  }
}

console.log(`Videos scanned: ${rows.length}`);
console.log(`Total tag assignments: ${totalAssignments}`);
console.log(`Unique tags before: ${originalUnique.size}`);
console.log(`Unique tags after:  ${normalizedUnique.size}`);
console.log(`Collapse ratio:     ${((1 - normalizedUnique.size / originalUnique.size) * 100).toFixed(1)}%`);
console.log(`Videos with tag changes: ${videosChanged}`);

const nonTrivialCollapses = [...collapseMap.entries()]
  .filter(([, variants]) => variants.size > 1)
  .sort((a, b) => b[1].size - a[1].size);

console.log(`\nNon-trivial collapses (canonical <- variants): ${nonTrivialCollapses.length}`);
console.log(`\nTop 40 collapses by variant count:`);
for (const [canonical, variants] of nonTrivialCollapses.slice(0, 40)) {
  const variantList = [...variants].filter((v) => v !== canonical).slice(0, 6);
  console.log(`  ${canonical}  <-  [${variantList.join(", ")}${variants.size > 7 ? ", ..." : ""}]`);
}

if (!APPLY) {
  console.log(`\n(dry run — rerun with --apply to write changes)`);
  process.exit(0);
}

console.log(`\nApplying changes to ${updates.length} videos...`);
const tx = db.transaction(() => {
  const stmt = db.prepare(`UPDATE youtube_videos SET tags = ? WHERE id = ?`);
  for (const u of updates) {
    stmt.run(u.newTags, u.id);
  }
});
tx();
console.log(`Done. Updated ${updates.length} rows.`);
