/**
 * Library items to categorise, loaded read-only from data/app.db.
 *
 * Kinds and item keys (the contract the vivaldi-home /library page reads):
 *   video:<video_id>        youtube_videos the user chose (Watch Later, sent
 *                           manually = never seen by discovery) plus discovery
 *                           videos marked 'interested' in Discover.
 *   research:<id>           research_notes (new write-ups; table may not exist yet).
 *   archive:<id>            noteplan_archive rows with source_kind='research_completed'.
 *   article:<id>            non-YouTube pending_items with status triaged|archived.
 *   tab:<id>                archived browser tabs from the tab-archive app's own DB
 *                           (~/.local/share/tab-archive/data/app.db, read-only; latest
 *                           capture per URL, excluded and dead tabs skipped).
 *
 * Also owns the two tables this feature writes (item_categories,
 * item_category_overrides); src/db/schema.ts carries the same DDL so a
 * daemon restart creates them too.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parseTags, summaryLead } from "./labels.ts";

export type LibKind = "video" | "research" | "archive" | "article" | "tab";
export const LIB_KINDS: LibKind[] = ["video", "research", "archive", "article", "tab"];
export const TAB_ARCHIVE_DB = process.env.TAB_ARCHIVE_DB ?? `${homedir()}/.local/share/tab-archive/data/app.db`;

export interface LibItem {
  key: string;
  kind: LibKind;
  title: string;
  url: string | null;
  /** Profile-free description sent to Jev as state. */
  content: Record<string, unknown>;
  /** Plain text for the lexical (BM25) prefilter. */
  text: string;
}

// ─── DDL ────────────────────────────────────────────────────────────────────

export const CATEGORY_DDL = [
  `CREATE TABLE IF NOT EXISTS item_categories (
    item_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    leaf TEXT NOT NULL,
    confidence REAL NOT NULL,
    alt_json TEXT,
    taxonomy_version TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_item_categories_path ON item_categories(path)`,
  `CREATE TABLE IF NOT EXISTS item_category_overrides (
    item_key TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_item_category_overrides_key ON item_category_overrides(item_key, created_at)`,
];

export function ensureCategoryTables(db: Database): void {
  for (const sql of CATEGORY_DDL) db.exec(sql);
}

export function tableExists(db: Database, name: string): boolean {
  return !!db.query<{ n: string }, [string]>(`SELECT name AS n FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

// ─── text helpers (pure) ────────────────────────────────────────────────────

export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Lead of a research write-up: the "## Summary" section (else the body),
 * with code fences, tool-call noise and markdown markup removed.
 */
export function researchLead(body: string, maxChars = 700): string {
  let t = body.replace(/\r/g, "").replace(/```[\s\S]*?```/g, " ");
  const m = t.match(/##\s*Summary\s*\n+([\s\S]*?)(\n##\s|$)/i);
  let lead = m ? m[1] : t.replace(/^#.*$/m, "");
  // Drop tool-call transcript lines ("**🌐 Z.ai Built-in Tool: …**", "*Executing on server...*").
  lead = lead
    .split("\n")
    .filter((l) => !/Built-in Tool|Executing on server|^\*\*(Input|Output)|webReader|^\s*\*\*\w+_result/i.test(l))
    .join(" ");
  if (lead.replace(/\W/g, "").length < 40) {
    const k = t.match(/##\s*Key Findings\s*\n+([\s\S]*?)(\n##\s|$)/i);
    if (k) lead = `${lead} ${k[1]}`;
  }
  lead = lead.replace(/[*_#>`]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return clip(lead, maxChars);
}

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ─── loaders ────────────────────────────────────────────────────────────────

export function loadLibraryVideos(db: Database): LibItem[] {
  const rows = db
    .query<{ video_id: string; title: string; channel_title: string; url: string; tags: string; markdown_summary: string }, []>(
      `SELECT yv.video_id, yv.title, yv.channel_title, yv.url, yv.tags, yv.markdown_summary
         FROM youtube_videos yv
        WHERE yv.playlist_item_id IS NOT NULL
           OR yv.video_id NOT IN (SELECT video_id FROM discovery_candidates)
           OR yv.video_id IN (
                SELECT ai.source_id FROM discover_feedback df
                  JOIN atlas_items ai ON ai.id = df.atlas_item_id
                 WHERE ai.source_table = 'youtube_videos' AND df.sentiment = 'interested')
        ORDER BY yv.created_at`,
    )
    .all();
  return rows.map((r) => {
    const tags = parseTags(r.tags);
    const summary = summaryLead(r.markdown_summary);
    return {
      key: `video:${r.video_id}`,
      kind: "video" as const,
      title: r.title,
      url: r.url,
      content: { type: "YouTube video", title: r.title, channel: r.channel_title, tags, summary },
      text: [r.title, r.channel_title, tags.join(" "), summary].join(" \n "),
    };
  });
}

export function loadLibraryResearch(db: Database): LibItem[] {
  if (!tableExists(db, "research_notes")) return [];
  const rows = db
    .query<{ id: number; title: string; url: string | null; summary: string | null; markdown: string; depth: string }, []>(
      `SELECT id, title, url, summary, markdown, depth FROM research_notes ORDER BY id`,
    )
    .all();
  return rows.map((r) => {
    const summary = r.summary?.trim() ? clip(r.summary, 700) : researchLead(r.markdown);
    return {
      key: `research:${r.id}`,
      kind: "research" as const,
      title: r.title,
      url: r.url,
      content: { type: "research write-up", title: r.title, source: hostOf(r.url), summary },
      text: [r.title, summary].join(" \n "),
    };
  });
}

export function loadLibraryArchive(db: Database): LibItem[] {
  const rows = db
    .query<{ id: number; title: string | null; body: string; rel_path: string }, []>(
      `SELECT id, title, body, rel_path FROM noteplan_archive WHERE source_kind = 'research_completed' ORDER BY id`,
    )
    .all();
  return rows.map((r) => {
    const title = r.title?.trim() || r.rel_path.split("/").pop()!.replace(/\.(md|txt)$/, "");
    const summary = researchLead(r.body);
    const url = r.body.match(/##\s*Sources\s*\n+\s*-\s*(https?:\/\/\S+)/i)?.[1] ?? null;
    return {
      key: `archive:${r.id}`,
      kind: "archive" as const,
      title,
      url,
      content: { type: "research write-up", title, source: hostOf(url), summary },
      text: [title, summary].join(" \n "),
    };
  });
}

export function loadLibraryArticles(db: Database): LibItem[] {
  const rows = db
    .query<{ id: number; url: string; title: string | null; platform: string | null; triage_summary: string | null; extracted_value: string | null; description: string | null }, []>(
      `SELECT id, url, title, platform, triage_summary, extracted_value, description
         FROM pending_items
        WHERE status IN ('triaged','archived')
          AND COALESCE(platform, '') <> 'youtube' AND source <> 'youtube'
          AND url NOT LIKE '%youtube.com/%' AND url NOT LIKE '%youtu.be/%'
        ORDER BY id`,
    )
    .all();
  return rows.map((r) => {
    const title = r.title?.trim() || hostOf(r.url);
    const summary = clip(r.triage_summary || r.description, 600);
    const value = clip(r.extracted_value, 300);
    return {
      key: `article:${r.id}`,
      kind: "article" as const,
      title,
      url: r.url,
      content: { type: "saved link", title: clip(title, 300), site: r.platform ?? hostOf(r.url), summary, extracted_value: value },
      text: [title, summary, value].join(" \n "),
    };
  });
}

export function loadLibraryTabs(path = TAB_ARCHIVE_DB): LibItem[] {
  if (!existsSync(path)) return [];
  const tdb = new Database(path, { readonly: true });
  try {
    const rows = tdb
      .query<{ id: string; url: string; title: string; summary: string | null; description: string | null }, []>(
        `SELECT t.id, t.url, t.title, t.summary, t.description FROM tab_archive_tabs t
          WHERE t.excluded = 0 AND t.status != 'dead'
            AND t.rowid = (SELECT max(t2.rowid) FROM tab_archive_tabs t2 WHERE t2.url_hash = t.url_hash)
          ORDER BY t.rowid`,
      )
      .all();
    return rows.map((r) => {
      const title = r.title?.trim() || hostOf(r.url);
      const summary = clip(r.summary || r.description, 600);
      return {
        key: `tab:${r.id}`,
        kind: "tab" as const,
        title,
        url: r.url,
        content: { type: "archived browser tab", title: clip(title, 300), site: hostOf(r.url), summary },
        text: [title, summary].join(" \n "),
      };
    });
  } finally {
    tdb.close();
  }
}

export function loadLibrary(db: Database, kinds: LibKind[] = LIB_KINDS): LibItem[] {
  const out: LibItem[] = [];
  if (kinds.includes("video")) out.push(...loadLibraryVideos(db));
  if (kinds.includes("research")) out.push(...loadLibraryResearch(db));
  if (kinds.includes("archive")) out.push(...loadLibraryArchive(db));
  if (kinds.includes("article")) out.push(...loadLibraryArticles(db));
  if (kinds.includes("tab")) out.push(...loadLibraryTabs());
  return out;
}
