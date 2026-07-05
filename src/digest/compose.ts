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
import { getConfig } from "../config.ts";
import { getRecentNewsItems } from "../discovery/db.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("digest:compose");

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
  relevanceScore: number;
}

export interface NewsHighlight {
  headline: string;
  what: string;
  whyItMatters: string;
  novelty: number;
  videoCount: number;
}

export interface YoutubeSection {
  /** Top videos this week, ranked by overlap with this week's rising entities. */
  topVideos: YoutubeItem[];
  /** Count of processed videos beyond the ranked top slice. */
  remainingCount: number;
  /** Total videos processed in the window (topVideos.length + remainingCount). */
  totalCount: number;
  /** This week's mined news items (src/discovery/news.ts), persisted via discovery/db.ts. */
  newsHighlights: NewsHighlight[];
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
  youtube: YoutubeSection;
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
  const risingEntitiesInternal = computeRisingEntities(db, windowStart, now);
  const risingEntities = risingEntitiesInternal.map(({ id: _id, ...rest }) => rest);
  const youtube = collectYoutube(db, windowStart, risingEntitiesInternal.map((e) => e.id));
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
      // auto_decision IN (...) — not a blanket noteplan_path check — because
      // triage creates a NotePlan note for every triaged item, not just ones
      // that actually went through deep/quick research. Matches the
      // completion predicate used elsewhere (e.g. atlas/synthesize.ts).
      `SELECT id, title, url, noteplan_path, quick_scan_summary, triage_summary
         FROM pending_items
        WHERE captured_at >= ?
          AND auto_decision IN ('deep_research_done', 'quick_research_done')
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

/** How many top-ranked videos to show in full in the digest. */
const YOUTUBE_TOP_N = 3;

function collectYoutube(
  db: ReturnType<typeof getDb>,
  windowStart: string,
  risingEntityIds: number[],
): YoutubeSection {
  const rows = db
    .prepare<{ video_id: string; title: string; channel_title: string }, [string]>(
      `SELECT video_id, title, channel_title
         FROM youtube_videos
        WHERE processed_at >= ?
        ORDER BY processed_at DESC`,
    )
    .all(windowStart);

  if (rows.length === 0) {
    return { topVideos: [], remainingCount: 0, totalCount: 0, newsHighlights: [] };
  }

  // Relevance = how many of this week's rising entities (already computed
  // above from atlas_entity_mentions — the same pipeline the "Rising
  // entities" section uses) a video mentions. youtube_videos are ingested
  // into atlas_items (source_table='youtube_videos'), so this is a direct
  // join, no re-embedding needed.
  //
  // A naive sum of discovery_interest_weights per linked topic was tried
  // first but is dominated by a single high-volume catch-all topic bucket
  // (many unrelated videos share it), which drowned out genuinely relevant
  // videos — this rising-entity overlap avoids that failure mode entirely.
  // Videos with no overlap score 0 and fall back to the recency ordering
  // above via Array.sort's stability.
  let scoreMap = new Map<string, number>();
  if (risingEntityIds.length > 0) {
    const placeholders = risingEntityIds.map(() => "?").join(", ");
    const scoreRows = db
      .prepare<{ video_id: string; score: number }, number[]>(
        `SELECT ai.source_id AS video_id, COUNT(*) AS score
           FROM atlas_items ai
           JOIN atlas_entity_mentions m ON m.item_id = ai.id
          WHERE ai.source_table = 'youtube_videos' AND m.entity_id IN (${placeholders})
          GROUP BY ai.source_id`,
      )
      .all(...risingEntityIds);
    scoreMap = new Map(scoreRows.map((r) => [r.video_id, r.score]));
  }

  const ranked = rows
    .map((r) => ({
      title: r.title,
      channel: r.channel_title,
      relevanceScore: scoreMap.get(r.video_id) ?? 0,
    }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

  const newsHighlights = collectNewsHighlights(windowStart);

  return {
    topVideos: ranked.slice(0, YOUTUBE_TOP_N),
    remainingCount: Math.max(0, ranked.length - YOUTUBE_TOP_N),
    totalCount: ranked.length,
    newsHighlights,
  };
}

/** This week's mined news items (persisted by DiscoveryRunner's news-mining step). */
function collectNewsHighlights(windowStart: string): NewsHighlight[] {
  try {
    return getRecentNewsItems(windowStart, 5).map((r) => ({
      headline: r.headline,
      what: r.what,
      whyItMatters: r.why_it_matters,
      novelty: r.novelty,
      videoCount: r.video_count,
    }));
  } catch (err) {
    log.warn("Failed to load discovery news highlights for digest", { error: String(err) });
    return [];
  }
}

/**
 * Rising entities plus their atlas_entities.id — the id is only needed
 * internally so collectYoutube() can score videos by overlap with this
 * week's rising entities; the public RisingEntity type (used by rendering)
 * omits it.
 */
function computeRisingEntities(
  db: ReturnType<typeof getDb>,
  windowStart: string,
  now: Date,
): (RisingEntity & { id: number })[] {
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
      id: r.id,
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
  if (d.youtube.totalCount === 0) {
    lines.push("_No videos processed this week._");
  } else {
    lines.push("_Top videos, ranked by overlap with this week's rising entities:_");
    for (const v of d.youtube.topVideos) {
      lines.push(`- ${v.title} — _${v.channel}_`);
    }
    if (d.youtube.remainingCount > 0) {
      lines.push(`- _...and ${d.youtube.remainingCount} more video${d.youtube.remainingCount === 1 ? "" : "s"} processed this week_`);
    }
  }
  if (d.youtube.newsHighlights.length > 0) {
    lines.push("");
    lines.push("**News highlights (mined from this week's videos):**");
    for (const n of d.youtube.newsHighlights) {
      const noveltyTag = n.novelty > 0.4 ? " 🆕" : n.videoCount > 2 ? " 📈" : "";
      lines.push(`- **${n.headline}**${noveltyTag} — ${n.what}`);
      if (n.whyItMatters) lines.push(`  - _Why it matters:_ ${n.whyItMatters}`);
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

/** How many top items to show inline in the short Telegram summary. */
const TELEGRAM_TOP_ITEMS_N = 3;

/**
 * Build the `/tma/digest/:week` reader URL using the same host source as the
 * bot's Mini App menu button (src/telegram/index.ts:109's
 * `https://${config.TELEGRAM_WEBHOOK_HOST}/tma`). Returns null when the host
 * isn't configured so callers can omit the link instead of producing a dead
 * `https:///tma/digest/...` URL.
 */
function digestReaderUrl(week: string): string | null {
  const host = getConfig().TELEGRAM_WEBHOOK_HOST;
  if (!host) return null;
  return `https://${host}/tma/digest/${week}`;
}

/**
 * Short Telegram-HTML summary: week-in-numbers + top 2-3 items + a link to
 * the full `/tma/digest/:week` reader. The full richness (research, YouTube
 * ranking + news highlights, rising entities, weekly themes) lives only in
 * the archived markdown / Mini App reader — see renderMarkdown().
 */
function renderTelegram(d: Omit<WeeklyDigest, "telegramChunks" | "markdown">): string[] {
  const parts: string[] = [];

  parts.push(`<b>📬 Weekly Digest — ${escapeTg(d.week)}</b>`);

  // Week in numbers
  const n = d.numbers;
  const numLines = [
    `<b>Week in numbers</b>`,
    `Captured: <b>${n.capturedTotal}</b> · Triaged: <b>${n.triagedCount}</b> · Researched: <b>${n.researchedCount}</b> · YouTube: <b>${n.youtubeCount}</b>`,
  ];
  parts.push(numLines.join("\n"));

  // Top 2-3 items only — the rest lives behind the full-digest link.
  if (d.topItems.length > 0) {
    const items = d.topItems.slice(0, TELEGRAM_TOP_ITEMS_N).map((item) => {
      const p = item.priority != null ? `(P${item.priority}) ` : "";
      const title = escapeTg(item.title);
      const link = item.url ? `<a href="${escapeTg(item.url)}">${title}</a>` : title;
      const plat = item.platform ? ` — ${escapeTg(item.platform)}` : "";
      return `${p}${link}${plat}`;
    });
    const heading = d.topItems.length > TELEGRAM_TOP_ITEMS_N
      ? `<b>Top items</b> (${TELEGRAM_TOP_ITEMS_N} of ${d.topItems.length})`
      : `<b>Top items</b>`;
    parts.push([heading, ...items].join("\n"));
  }

  // Full digest link — the plan's own spec: short Telegram summary + link.
  const readerUrl = digestReaderUrl(d.week);
  if (readerUrl) {
    parts.push(`<a href="${escapeTg(readerUrl)}">Full digest →</a>`);
  }

  // Join sections with blank lines, then chunk to Telegram's message limit
  // (chunking is defensive here — this summary should always fit in one).
  const full = parts.join("\n\n");
  return splitMessage(full);
}
