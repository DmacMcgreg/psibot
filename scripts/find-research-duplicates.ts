import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

const db = new Database(join(process.cwd(), "data/app.db"), { readonly: true });

const RESEARCH_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research/completed");

interface NoteMeta {
  path: string;
  url: string;
  title: string;
  size: number;
  mtimeMs: number;
  researched: string;
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
  try {
    const content = readFileSync(fullPath, "utf-8");
    const url = extractField(content, "url");
    const title = extractField(content, "title");
    const researched = extractField(content, "researched");
    const stat = statSync(fullPath);
    notes.push({
      path: fullPath,
      url,
      title,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      researched,
    });
  } catch (err) {
    console.error(`Skipping ${f}: ${err instanceof Error ? err.message : err}`);
  }
}

// Build canonical paths from DB (the note pointed to by pending_items.noteplan_path is the "keeper")
const canonical = new Set<string>();
const rows = db
  .query<{ noteplan_path: string }, [string]>(
    `SELECT noteplan_path FROM pending_items WHERE noteplan_path IS NOT NULL AND noteplan_path LIKE ?`,
  )
  .all(`${RESEARCH_DIR}%`);
for (const row of rows) {
  canonical.add(row.noteplan_path);
}

// Group by URL
const byUrl = new Map<string, NoteMeta[]>();
for (const n of notes) {
  if (!n.url) continue;
  const bucket = byUrl.get(n.url) ?? [];
  bucket.push(n);
  byUrl.set(n.url, bucket);
}

// Filter to groups with duplicates
const dupeGroups: { url: string; keeper: NoteMeta; dupes: NoteMeta[] }[] = [];
let totalDupes = 0;
let totalBytes = 0;

for (const [url, group] of byUrl) {
  if (group.length < 2) continue;

  // Keeper preference: (1) path referenced in DB, (2) largest file (most complete research), (3) newest mtime
  let keeper = group.find((g) => canonical.has(g.path));
  if (!keeper) {
    const sorted = [...group].sort((a, b) => b.size - a.size || b.mtimeMs - a.mtimeMs);
    keeper = sorted[0];
  }
  const dupes = group.filter((g) => g.path !== keeper.path);
  totalDupes += dupes.length;
  totalBytes += dupes.reduce((s, d) => s + d.size, 0);
  dupeGroups.push({ url, keeper, dupes });
}

// Sort groups by dupe count desc
dupeGroups.sort((a, b) => b.dupes.length - a.dupes.length);

const lines: string[] = [];
lines.push(`# Research Note Duplicates`);
lines.push(``);
lines.push(`Total files scanned: ${notes.length}`);
lines.push(`Groups with duplicates: ${dupeGroups.length}`);
lines.push(`Total duplicate files to delete: ${totalDupes}`);
lines.push(`Disk space to recover: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
lines.push(``);
lines.push(`Keeper selection: (1) file referenced by pending_items.noteplan_path, else (2) largest file, else (3) newest.`);
lines.push(``);
lines.push(`---`);
lines.push(``);

for (const g of dupeGroups) {
  lines.push(`## ${g.dupes.length} duplicate${g.dupes.length === 1 ? "" : "s"} — ${g.url}`);
  lines.push(``);
  const mark = canonical.has(g.keeper.path) ? "KEEP (DB ref)" : "KEEP (largest)";
  lines.push(`  [${mark}] ${g.keeper.path}`);
  lines.push(`            size=${(g.keeper.size / 1024).toFixed(1)}KB  researched=${g.keeper.researched}  title="${g.keeper.title}"`);
  for (const d of g.dupes) {
    lines.push(`  [DELETE    ] ${d.path}`);
    lines.push(`              size=${(d.size / 1024).toFixed(1)}KB  researched=${d.researched}  title="${d.title}"`);
  }
  lines.push(``);
}

const outputPath = join(process.cwd(), "research-duplicates.md");
await Bun.write(outputPath, lines.join("\n"));

console.log(`Wrote ${outputPath}`);
console.log(`Total files scanned: ${notes.length}`);
console.log(`Groups with duplicates: ${dupeGroups.length}`);
console.log(`Duplicate files to delete: ${totalDupes}`);
console.log(`Disk space: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
