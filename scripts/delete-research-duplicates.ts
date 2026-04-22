import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

const RESEARCH_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research/completed");

const db = new Database(join(process.cwd(), "data/app.db"), { readonly: true });

interface NoteMeta {
  path: string;
  url: string;
  size: number;
  mtimeMs: number;
}

function extractField(content: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.+)$`, "m");
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return "";
  const m = fm[1].match(re);
  return m ? m[1].trim() : "";
}

const files = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith(".md"));
const notes: NoteMeta[] = [];

for (const f of files) {
  const fullPath = join(RESEARCH_DIR, f);
  const content = readFileSync(fullPath, "utf-8");
  const url = extractField(content, "url");
  if (!url) continue;
  const stat = statSync(fullPath);
  notes.push({ path: fullPath, url, size: stat.size, mtimeMs: stat.mtimeMs });
}

const canonical = new Set<string>();
const rows = db
  .query<{ noteplan_path: string }, [string]>(
    `SELECT noteplan_path FROM pending_items WHERE noteplan_path IS NOT NULL AND noteplan_path LIKE ?`,
  )
  .all(`${RESEARCH_DIR}%`);
for (const row of rows) {
  canonical.add(row.noteplan_path);
}

const byUrl = new Map<string, NoteMeta[]>();
for (const n of notes) {
  const bucket = byUrl.get(n.url) ?? [];
  bucket.push(n);
  byUrl.set(n.url, bucket);
}

const toDelete: string[] = [];

for (const group of byUrl.values()) {
  if (group.length < 2) continue;
  let keeper = group.find((g) => canonical.has(g.path));
  if (!keeper) {
    const sorted = [...group].sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs);
    keeper = sorted[0];
  }
  for (const d of group) {
    if (d.path !== keeper.path) toDelete.push(d.path);
  }
}

console.log(`Deleting ${toDelete.length} duplicate files...`);

let deleted = 0;
let failed = 0;
for (const p of toDelete) {
  try {
    unlinkSync(p);
    deleted++;
  } catch (err) {
    console.error(`FAILED: ${p}: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

console.log(`Deleted: ${deleted}`);
console.log(`Failed:  ${failed}`);
