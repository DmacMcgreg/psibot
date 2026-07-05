/**
 * Weekly Digest composer.
 *
 * Pure DB/file reads over a trailing 7-day window. No LLM calls — every section
 * is derived from data the ingestion pipelines already produced (pending_items,
 * atlas_items, atlas_entity_mentions, youtube_videos) plus the current ISO
 * week's synthesis file. Produces a structured object plus two renderings:
 *
 *   1. `telegramChunks` — Telegram-HTML strings (b/i/a/code/pre subset only),
 *      already chunked to fit MAX_MESSAGE_LENGTH via splitMessage().
 *   2. `markdown` — a standalone markdown document for the archive + reader page.
 *
 * Read-only: uses `getDb()` with local `db.prepare` statements (no writes, no new
 * shared prepared statements) so the composer stays self-contained.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDb } from "../db/index.ts";
import { splitMessage } from "../telegram/format.ts";

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");
const WEEKLY_DIR = join(KNOWLEDGE_DIR, "weekly");

/** Excerpt cap for the embedded weekly-themes synthesis (chars). */
const THEMES_EXCERPT_CAP = 1200;

// ---------------------------------------------------------------------------
// ISO week helper (matches src/atlas/synthesize.ts isoWeek so digest archive
// filenames line up with the weekly synthesis files).
// ---------------------------------------------------------------------------

export function isoWeek(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Structured result types
// ---------------------------------------------------------------------------

export interface WeekInNumbers {
  capturedBySource: { source: string; count: number }[];
  capturedByPlatform: { platform: string; count: number }[];
  capturedTotal: number;
  triagedCount: number;
  researchedCount: number;
  youtubeCount: number;
}

export interface TopItem {
  id: number;
  title: string;
  url: string | null;
  value: string;
  platform: string | null;
  priority: number | null;
  signalScore: number | null;
}

export interface ResearchItem {
  id: number;
  title: string;
  summary: string;
  notePath: string;
  url: string | null;
}

export interface YoutubeItem {
  title: string;
  channel: string;
}

export interface RisingEntity {
  name: string;
  kind: string;
  count: number;
  priorCount: number;
  delta: number;
}

export interface WeeklyDigest {
  week: string;
  generatedAt: string;
  windowStart: string;
  numbers: WeekInNumbers;
  topItems: TopItem[];
  research: ResearchItem[];
  youtube: YoutubeItem[];
  risingEntities: RisingEntity[];
  themesExcerpt: string | null;
  themesWeek: string | null;
  telegramChunks: string[];
  markdown: string;
}

// ---------------------------------------------------------------------------
// Telegram-HTML escaping (b/i/a/code/pre subset). Mirrors the heartbeat's
// escapeHtml — only &, <, > need escaping in the Telegram HTML subset.
// ---------------------------------------------------------------------------

function escapeTg(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  const t = (text ?? "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max).trimEnd() + "…";
}

/** Collapse a markdown/multiline value into a single readable line. */
function oneLine(text: string | null | undefined, max = 160): string {
  if (!text) return "";
  const flat = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^#+\s.*$/gm, "")
    .replace(/[*_`>#]/g, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return truncate(flat, max);
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function composeWeeklyDigest(now = new Date()): WeeklyDigest {
  const db = getDb();
  const week = isoWeek(now);
  const windowStartDate = new Date(now.getTime() - 7 * 86400_000);
  // ISO-8601 UTC — pending_items/atlas_items store timestamps in this form.
  const windowStart = windowStartDate.toISOString().replace(/\.\d{3}Z$/, "Z");

  const numbers = collectNumbers(db, windowStart);
  const topItems = collectTopItems(db, windowStart);
  const research = collectResearch(db, windowStart);
  const youtube = collectYoutube(db, windowStart);
  const risingEntities = collectRisingEntities(db, windowStart, now);
  const { excerpt: themesExcerpt, week: themesWeek } = readWeeklyThemes(week);

  const digest: Omit<WeeklyDigest, "telegramChunks" | "markdown"> = {
    week,
    generatedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    windowStart,
    numbers,
    topItems,
    research,
    youtube,
    risingEntities,
    themesExcerpt,
    themesWeek,
  };

  const markdown = renderMarkdown(digest);
  const telegramChunks = renderTelegram(digest);

  return { ...digest, markdown, telegramChunks };
}

// ---------------------------------------------------------------------------
// Section collectors (all read-only)
// ---------------------------------------------------------------------------

function collectNumbers(db: ReturnType<typeof getDb>, windowStart: string): WeekInNumbers {
  const bySource = db
    .prepare<{ source: string; count: number }, [string]>(
      `SELECT COALESCE(source, 'unknown') AS source, COUNT(*) AS count
         FROM pending_items
        WHERE captured_at >= ?
        GROUP BY source
        ORDER BY count DESC`,
    )
    .all(windowStart);

  const byPlatform = db
    .prepare<{ platform: string; count: number }, [string]>(
      `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*) AS count
         FROM pending_items
        WHERE captured_at >= ? AND platform IS NOT NULL
        GROUP BY platform
        ORDER BY count DESC`,
    )
    .all(windowStart);

  const capturedTotal = bySource.reduce((sum, r) => sum + r.count, 0);

  // Triaged = items that reached triaged/archived status within the window.
  const triaged = db
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM pending_items
        WHERE captured_at >= ? AND status IN ('triaged', 'archived')`,
    )
    .get(windowStart);

  // Researched = a research note was produced (auto_decision reflects completion
  // or a noteplan_path was set) within the window.
  const researched = db
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM pending_items
        WHERE captured_at >= ?
          AND (auto_decision LIKE '%research_done%' OR (noteplan_path IS NOT NULL AND noteplan_path <> ''))`,
    )
    .get(windowStart);

  const yt = db
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM youtube_videos WHERE processed_at >= ?`,
    )
    .get(windowStart);

  return {
    capturedBySource: bySource,
    capturedByPlatform: byPlatform,
    capturedTotal,
    triagedCount: triaged?.n ?? 0,
    researchedCount: researched?.n ?? 0,
    youtubeCount: yt?.n ?? 0,
  };
}

function collectTopItems(db: ReturnType<typeof getDb>, windowStart: string): TopItem[] {
  const rows = db
    .prepare<
      {
        id: number;
        title: string | null;
        url: string | null;
        platform: string | null;
        priority: number | null;
        signal_score: number | null;
        extracted_value: string | null;
        quick_scan_summary: string | null;
        triage_summary: string | null;
      },
      [string]
    >(
      `SELECT id, title, url, platform, priority, signal_score,
              extracted_value, quick_scan_summary, triage_summary
         FROM pending_items
        WHERE captured_at >= ?
          AND status IN ('triaged', 'archived')
        ORDER BY COALESCE(priority, 5) ASC, COALESCE(signal_score, 0) DESC
        LIMIT 10`,
    )
    .all(windowStart);

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "Untitled",
    url: r.url,
    value: oneLine(r.extracted_value ?? r.quick_scan_summary ?? r.triage_summary ?? ""),
    platform: r.platform,
    priority: r.priority,
    signalScore: r.signal_score,
  }));
}

function collectResearch(db: ReturnType<typeof getDb>, windowStart: string): ResearchItem[] {
  const rows = db
    .prepare<
      {
        id: number;
        title: string | null;
        url: string | null;
        noteplan_path: string;
        quick_scan_summary: string | null;
        triage_summary: string | null;
      },
      [string]
    >(
      `SELECT id, title, url, noteplan_path, quick_scan_summary, triage_summary
         FROM pending_items
        WHERE captured_at >= ?
          AND noteplan_path IS NOT NULL AND noteplan_path <> ''
        ORDER BY COALESCE(priority, 5) ASC, COALESCE(signal_score, 0) DESC`,
    )
    .all(windowStart);

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "Untitled",
    summary: oneLine(r.quick_scan_summary ?? r.triage_summary ?? "", 200),
    notePath: r.noteplan_path,
    url: r.url,
  }));
}

function collectYoutube(db: ReturnType<typeof getDb>, windowStart: string): YoutubeItem[] {
  const rows = db
    .prepare<{ title: string; channel_title: string }, [string]>(
      `SELECT title, channel_title
         FROM youtube_videos
        WHERE processed_at >= ?
        ORDER BY processed_at DESC
        LIMIT 10`,
    )
    .all(windowStart);
  return rows.map((r) => ({ title: r.title, channel: r.channel_title }));
}

function collectRisingEntities(
  db: ReturnType<typeof getDb>,
  windowStart: string,
  now: Date,
): RisingEntity[] {
  const priorStart = new Date(now.getTime() - 14 * 86400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  // This-week mention counts (joined to atlas_items captured in window).
  const thisWeek = db
    .prepare<{ id: number; name: string; kind: string; count: number }, [string]>(
      `SELECT e.id AS id, e.display_name AS name, e.kind AS kind, COUNT(*) AS count
         FROM atlas_entity_mentions m
         JOIN atlas_items i ON i.id = m.item_id
         JOIN atlas_entities e ON e.id = m.entity_id
        WHERE i.captured_at >= ?
        GROUP BY e.id
        ORDER BY count DESC
        LIMIT 8`,
    )
    .all(windowStart);

  if (thisWeek.length === 0) return [];

  // Prior-week counts for the same entities (14d..7d ago window).
  const priorCounts = new Map<number, number>();
  const priorRows = db
    .prepare<{ id: number; count: number }, [string, string]>(
      `SELECT e.id AS id, COUNT(*) AS count
         FROM atlas_entity_mentions m
         JOIN atlas_items i ON i.id = m.item_id
         JOIN atlas_entities e ON e.id = m.entity_id
        WHERE i.captured_at >= ? AND i.captured_at < ?
        GROUP BY e.id`,
    )
    .all(priorStart, windowStart);
  for (const r of priorRows) priorCounts.set(r.id, r.count);

  return thisWeek.map((r) => {
    const prior = priorCounts.get(r.id) ?? 0;
    return {
      name: r.name,
      kind: r.kind,
      count: r.count,
      priorCount: prior,
      delta: r.count - prior,
    };
  });
}

function readWeeklyThemes(week: string): { excerpt: string | null; week: string | null } {
  const full = join(WEEKLY_DIR, `${week}.md`);
  if (!existsSync(full)) return { excerpt: null, week: null };
  try {
    const raw = readFileSync(full, "utf-8").trim();
    if (!raw) return { excerpt: null, week: null };
    return { excerpt: truncate(raw, THEMES_EXCERPT_CAP), week };
  } catch {
    return { excerpt: null, week: null };
  }
}

// ---------------------------------------------------------------------------
// Rendering — Markdown
// ---------------------------------------------------------------------------

function renderMarkdown(d: Omit<WeeklyDigest, "telegramChunks" | "markdown">): string {
  const lines: string[] = [];
  lines.push(`# Weekly Digest — ${d.week}`);
  lines.push("");
  lines.push(`_Generated ${d.generatedAt} · window since ${d.windowStart}_`);
  lines.push("");

  // Week in numbers
  lines.push("## Week in numbers");
  lines.push("");
  const n = d.numbers;
  lines.push(`- **Captured:** ${n.capturedTotal}`);
  if (n.capturedBySource.length > 0) {
    lines.push(
      `  - By source: ${n.capturedBySource.map((s) => `${s.source} ${s.count}`).join(", ")}`,
    );
  }
  if (n.capturedByPlatform.length > 0) {
    lines.push(
      `  - By platform: ${n.capturedByPlatform.map((s) => `${s.platform} ${s.count}`).join(", ")}`,
    );
  }
  lines.push(`- **Triaged:** ${n.triagedCount}`);
  lines.push(`- **Researched:** ${n.researchedCount}`);
  lines.push(`- **YouTube processed:** ${n.youtubeCount}`);
  lines.push("");

  // Top 10
  lines.push("## Top items");
  lines.push("");
  if (d.topItems.length === 0) {
    lines.push("_No triaged items this week._");
  } else {
    for (const item of d.topItems) {
      const p = item.priority != null ? `P${item.priority} ` : "";
      const link = item.url ? `[${item.title}](${item.url})` : item.title;
      const plat = item.platform ? ` _(${item.platform})_` : "";
      lines.push(`- ${p}${link}${plat}`);
      if (item.value) lines.push(`  - ${item.value}`);
    }
  }
  lines.push("");

  // Research completed
  lines.push("## Research completed");
  lines.push("");
  if (d.research.length === 0) {
    lines.push("_No research notes produced this week._");
  } else {
    for (const r of d.research) {
      lines.push(`- **${r.title}** — \`${r.notePath}\``);
      if (r.summary) lines.push(`  - ${r.summary}`);
    }
  }
  lines.push("");

  // YouTube
  lines.push("## YouTube");
  lines.push("");
  if (d.youtube.length === 0) {
    lines.push("_No videos processed this week._");
  } else {
    for (const v of d.youtube) {
      lines.push(`- ${v.title} — _${v.channel}_`);
    }
  }
  lines.push("");

  // Rising entities
  lines.push("## Rising entities");
  lines.push("");
  if (d.risingEntities.length === 0) {
    lines.push("_No entity mentions this week._");
  } else {
    for (const e of d.risingEntities) {
      const deltaStr = e.delta > 0 ? ` (+${e.delta})` : e.delta < 0 ? ` (${e.delta})` : "";
      lines.push(`- **${e.name}** (${e.kind}) — ${e.count} mentions${deltaStr}`);
    }
  }
  lines.push("");

  // Weekly themes
  lines.push("## Weekly themes");
  lines.push("");
  if (d.themesExcerpt) {
    lines.push(`_From synthesis ${d.themesWeek}:_`);
    lines.push("");
    lines.push(d.themesExcerpt);
  } else {
    lines.push("_No weekly synthesis available yet._");
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Rendering — Telegram HTML (b/i/a/code/pre subset), chunked.
// ---------------------------------------------------------------------------

function renderTelegram(d: Omit<WeeklyDigest, "telegramChunks" | "markdown">): string[] {
  const parts: string[] = [];

  parts.push(`<b>📬 Weekly Digest — ${escapeTg(d.week)}</b>`);

  // Week in numbers
  const n = d.numbers;
  const numLines = [
    `<b>Week in numbers</b>`,
    `Captured: <b>${n.capturedTotal}</b>`,
  ];
  if (n.capturedBySource.length > 0) {
    numLines.push(
      `<i>${escapeTg(n.capturedBySource.map((s) => `${s.source} ${s.count}`).join(", "))}</i>`,
    );
  }
  numLines.push(`Triaged: <b>${n.triagedCount}</b> · Researched: <b>${n.researchedCount}</b> · YouTube: <b>${n.youtubeCount}</b>`);
  parts.push(numLines.join("\n"));

  // Top items
  if (d.topItems.length > 0) {
    const items = d.topItems.map((item) => {
      const p = item.priority != null ? `(P${item.priority}) ` : "";
      const title = escapeTg(item.title);
      const link = item.url ? `<a href="${escapeTg(item.url)}">${title}</a>` : title;
      const plat = item.platform ? ` — ${escapeTg(item.platform)}` : "";
      const value = item.value ? `\n${escapeTg(item.value)}` : "";
      return `${p}${link}${plat}${value}`;
    });
    parts.push([`<b>Top items</b>`, ...items].join("\n\n"));
  }

  // Research completed
  if (d.research.length > 0) {
    const items = d.research.map((r) => {
      const summary = r.summary ? ` — ${escapeTg(r.summary)}` : "";
      return `🔬 <b>${escapeTg(r.title)}</b>${summary}\n<code>${escapeTg(r.notePath)}</code>`;
    });
    parts.push([`<b>Research completed</b>`, ...items].join("\n\n"));
  }

  // YouTube
  if (d.youtube.length > 0) {
    const items = d.youtube.map((v) => `▸ ${escapeTg(v.title)} — <i>${escapeTg(v.channel)}</i>`);
    parts.push([`<b>YouTube</b>`, ...items].join("\n"));
  }

  // Rising entities
  if (d.risingEntities.length > 0) {
    const items = d.risingEntities.map((e) => {
      const deltaStr = e.delta > 0 ? ` (+${e.delta})` : e.delta < 0 ? ` (${e.delta})` : "";
      return `▸ <b>${escapeTg(e.name)}</b> ${escapeTg(e.count + " mentions" + deltaStr)}`;
    });
    parts.push([`<b>Rising entities</b>`, ...items].join("\n"));
  }

  // Weekly themes excerpt
  if (d.themesExcerpt) {
    parts.push(`<b>Weekly themes</b>\n${escapeTg(oneLine(d.themesExcerpt, 600))}`);
  }

  // Join sections with blank lines, then chunk to Telegram's message limit.
  const full = parts.join("\n\n");
  return splitMessage(full);
}
