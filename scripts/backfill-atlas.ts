import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import {
  syncAtlasForPendingItem,
  syncAtlasForTradingSignal,
  syncAtlasForYoutubeVideo,
  syncAtlasForResearchNote,
  syncAtlasForDailyLog,
} from "../src/atlas/sync.ts";
import { counts as atlasCounts, rebuildFtsAll } from "../src/atlas/index.ts";
import type { PendingItem, TradingSignal } from "../src/shared/types.ts";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

loadConfig();
initDb();
const db = getDb();

console.log("== Atlas backfill ==\n");

// --- Pending items (inbox) ---
const pendingRows = db
  .prepare<PendingItem, []>("SELECT * FROM pending_items")
  .all();
console.log(`pending_items: ${pendingRows.length}`);
for (const row of pendingRows) syncAtlasForPendingItem(row);

// --- Trading signals ---
const signalRows = db
  .prepare<TradingSignal, []>("SELECT * FROM trading_signals")
  .all();
console.log(`trading_signals: ${signalRows.length}`);
for (const row of signalRows) syncAtlasForTradingSignal(row);

// --- YouTube videos (any status that carries a summary) ---
interface YtRow {
  video_id: string;
  title: string;
  channel_title: string;
  url: string;
  tags: string;
  markdown_summary: string;
  processed_at: string;
}
const ytRows = db
  .prepare<YtRow, []>(
    `SELECT video_id, title, channel_title, url, tags, markdown_summary, processed_at
     FROM youtube_videos
     WHERE markdown_summary IS NOT NULL
       AND length(trim(markdown_summary)) > 0`,
  )
  .all();
console.log(`youtube_videos (summarized): ${ytRows.length}`);
for (const row of ytRows) syncAtlasForYoutubeVideo(row);

// --- Research notes (reconstructed from NotePlan files) ---
interface ResearchRow {
  id: number;
  title: string | null;
  url: string | null;
  noteplan_path: string;
  captured_at: string | null;
  created_at: string;
}
const researchRows = db
  .prepare<ResearchRow, []>(
    `SELECT id, title, url, noteplan_path, captured_at, created_at
     FROM pending_items
     WHERE noteplan_path IS NOT NULL
       AND noteplan_path != ''`,
  )
  .all();

let researchSynced = 0;
let researchSkipped = 0;
for (const row of researchRows) {
  if (!existsSync(row.noteplan_path)) {
    researchSkipped++;
    continue;
  }
  try {
    const content = readFileSync(row.noteplan_path, "utf-8");
    const parsed = parseResearchNote(content);
    const title = parsed.title ?? row.title ?? `Research ${row.id}`;
    const summary = parsed.summary ?? content.slice(0, 800);
    syncAtlasForResearchNote({
      sourceId: String(row.id),
      title,
      summary,
      keyFindings: parsed.keyFindings ?? "",
      notePath: row.noteplan_path,
      url: row.url,
      capturedAt: row.captured_at ?? row.created_at,
      depth: row.noteplan_path.includes("/queued/") ? "quick" : "deep",
    });
    researchSynced++;
  } catch (err) {
    researchSkipped++;
    console.warn(`  research #${row.id} skipped: ${(err as Error).message}`);
  }
}
console.log(`research_notes: ${researchSynced} synced, ${researchSkipped} skipped (missing/unreadable)`);

interface ParsedResearch {
  title: string | null;
  summary: string | null;
  keyFindings: string | null;
}

function parseResearchNote(text: string): ParsedResearch {
  const fmMatch = /^---\n([\s\S]*?)\n---\n/.exec(text);
  let title: string | null = null;
  if (fmMatch) {
    const titleLine = fmMatch[1].split(/\n/).find((l) => /^title:\s*/.test(l));
    if (titleLine) title = titleLine.replace(/^title:\s*/, "").trim() || null;
  }
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  const summary = sectionBetween(body, /^##\s+Summary\s*$/im);
  const keyFindings = sectionBetween(body, /^##\s+Key\s+Findings\s*$/im);
  return { title, summary, keyFindings };
}

function sectionBetween(body: string, header: RegExp): string | null {
  const m = header.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const after = body.slice(start);
  const next = /^##\s+/im.exec(after);
  const slice = next ? after.slice(0, next.index) : after;
  return slice.trim() || null;
}

// --- Daily logs (knowledge/memory/*.md) ---
const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");
const MEM_DIR = join(KNOWLEDGE_DIR, "memory");
let dailyCount = 0;
try {
  const entries = readdirSync(MEM_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(MEM_DIR, entry.name);
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");
    syncAtlasForDailyLog({
      filePath: `memory/${entry.name}`,
      content,
      capturedAt: stat.mtime.toISOString(),
    });
    dailyCount++;
  }
} catch (err) {
  console.warn(`daily logs skipped: ${(err as Error).message}`);
}
console.log(`daily_logs: ${dailyCount}`);

// --- Rebuild FTS so nothing is stale after bulk operations ---
const ftsRows = rebuildFtsAll();
console.log(`\nRebuilt atlas_items_fts: ${ftsRows} rows`);

// --- Summary ---
const c = atlasCounts();
console.log(`\nAtlas totals:`);
console.log(`  total: ${c.total}`);
for (const [k, n] of Object.entries(c.byKind)) {
  console.log(`  ${k}: ${n}`);
}
console.log(`  awaiting embedding: ${c.awaitingEmbedding}`);
console.log(`  awaiting entities: ${c.awaitingEntities}`);
