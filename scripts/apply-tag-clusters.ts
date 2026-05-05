import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";

loadConfig();
initDb();
const db = getDb();

const MAP_PATH = process.argv.find((a) => a.startsWith("--map="))?.slice(6) ?? "/tmp/yt_tag_cluster_map.json";
const APPLY = process.argv.includes("--apply");

type MemberSpec = string | { tag: string; count?: number };
interface Cluster {
  canonical: string;
  members: MemberSpec[];
}

const map = JSON.parse(readFileSync(MAP_PATH, "utf-8")) as { threshold?: number; clusters: Cluster[] };

// Build old-tag -> canonical lookup (accepts both string[] and {tag,count}[] forms)
const canonicalOf = new Map<string, string>();
for (const c of map.clusters) {
  for (const m of c.members) {
    const tag = typeof m === "string" ? m : m.tag;
    canonicalOf.set(tag, c.canonical);
  }
}
console.log(`Map covers ${canonicalOf.size} tags -> ${map.clusters.length} canonicals`);
console.log(`Threshold: ${map.threshold ?? "n/a"}`);

interface VideoRow {
  id: number;
  video_id: string;
  tags: string;
}

const rows = db.prepare<VideoRow, []>(`SELECT id, video_id, tags FROM youtube_videos`).all();

let videosChanged = 0;
let totalIn = 0;
let totalOut = 0;
const updates: Array<{ id: number; newTags: string }> = [];

for (const row of rows) {
  let parsed: unknown;
  try { parsed = JSON.parse(row.tags); } catch { continue; }
  if (!Array.isArray(parsed)) continue;

  const originals = parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  totalIn += originals.length;

  const out: string[] = [];
  const seen = new Set<string>();
  let dirty = false;

  for (const t of originals) {
    const canonical = canonicalOf.get(t) ?? t;
    if (canonical !== t) dirty = true;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    } else {
      dirty = true;
    }
  }

  totalOut += out.length;
  if (dirty) {
    videosChanged++;
    updates.push({ id: row.id, newTags: JSON.stringify(out) });
  }
}

console.log(`\nVideos scanned: ${rows.length}`);
console.log(`Tag assignments: ${totalIn} -> ${totalOut}`);
console.log(`Videos to update: ${videosChanged}`);

if (!APPLY) {
  console.log(`\n(dry run — rerun with --apply to write changes)`);
  process.exit(0);
}

console.log(`\nApplying...`);
const tx = db.transaction(() => {
  const stmt = db.prepare(`UPDATE youtube_videos SET tags = ? WHERE id = ?`);
  for (const u of updates) {
    stmt.run(u.newTags, u.id);
  }
});
tx();

const postUnique = db
  .prepare<{ tags: string }, []>(`SELECT tags FROM youtube_videos`)
  .all()
  .flatMap((r) => { try { const a = JSON.parse(r.tags); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; } catch { return []; } });
const uniqueNow = new Set(postUnique).size;

console.log(`Done. Updated ${updates.length} rows.`);
console.log(`Unique tags after apply: ${uniqueNow}`);
