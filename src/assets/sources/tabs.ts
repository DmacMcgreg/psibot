/**
 * tab-archive poller. Reads ~/.local/share/tab-archive/data/app.db read-only
 * (the tab-archive daemon owns it) and uses each tab's inner_text and summary.
 *
 * Tabs that can never hold an asset are skipped before the gate: shopping,
 * travel, search pages, chats, private dashboards, local/tailnet hosts and
 * David's own GitHub repos. GitHub repo tabs use the README via the API, since
 * their page text is navigation chrome. YouTube tabs whose video is already in
 * youtube_videos are left to the YouTube poller.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { getDb } from "../../db/index.ts";
import { daysAgo, type ListOptions, type Source, type SourceItem } from "./types.ts";
import { fetchRepoText, repoFromUrl } from "./github.ts";

export const TAB_DB_PATH = process.env.TAB_ARCHIVE_DB ?? `${homedir()}/.local/share/tab-archive/data/app.db`;

const SKIP_HOST = /(^|\.)(amazon\.[a-z.]+|costco\.[a-z.]+|walmart\.[a-z.]+|bestbuy\.[a-z.]+|ebay\.[a-z.]+|hotels\.com|airbnb\.[a-z.]+|tripadvisor\.[a-z.]+|getyourguide\.com|booking\.com|expedia\.[a-z.]+|kayak\.[a-z.]+|claude\.ai|chatgpt\.com|gemini\.google\.com|aistudio\.google\.com|platform\.claude\.com|console\.anthropic\.com|mail\.google\.com|calendar\.google\.com|drive\.google\.com|docs\.google\.com|accounts\.google\.com|openrouter\.ai|railway\.com|tradingview\.com|localhost|ts\.net)$/i;
const SKIP_URL = [
  /^https?:\/\/(www\.)?google\.[a-z.]+\/(search|maps)/i,
  /^https?:\/\/(\d{1,3}\.){3}\d{1,3}/,
  /^https?:\/\/(www\.)?github\.com\/(DmacMcgreg|users\/DmacMcgreg|notifications|settings)\b/i,
  /^https?:\/\/(www\.)?vercel\.com\/(?!templates|blog|docs)/i,
  /^(chrome|vivaldi|about|file|chrome-extension):/i,
];

export function skipTabUrl(url: string): boolean {
  if (SKIP_URL.some((re) => re.test(url))) return true;
  try {
    return SKIP_HOST.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

interface Row {
  id: string;
  url: string;
  title: string;
  description: string | null;
  summary: string | null;
  text_head: string | null;
  archived_at: string;
}

let tabDb: Database | null = null;
function openTabDb(): Database | null {
  if (tabDb) return tabDb;
  if (!existsSync(TAB_DB_PATH)) return null;
  tabDb = new Database(TAB_DB_PATH, { readonly: true });
  tabDb.exec("PRAGMA busy_timeout = 5000");
  return tabDb;
}

function youtubeId(url: string): string | null {
  return url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/)|youtu\.be\/)([\w-]{11})/)?.[1] ?? null;
}

export const tabSource: Source = {
  kind: "tab",
  list(opts: ListOptions): SourceItem[] {
    const db = openTabDb();
    if (!db) return [];
    const where = ["excluded = 0", "status != 'dead'"];
    const args: (string | number)[] = [];
    if (opts.after) { where.push("archived_at > ?"); args.push(opts.after); }
    if (opts.sinceDays) { where.push("archived_at >= ?"); args.push(daysAgo(opts.sinceDays, true)); }
    args.push(opts.limit);
    const rows = db.prepare<Row, (string | number)[]>(
      `SELECT id, url, title, description, summary, substr(inner_text, 1, 2500) AS text_head, archived_at
       FROM tab_archive_tabs WHERE ${where.join(" AND ")}
       ORDER BY archived_at DESC LIMIT ?`,
    ).all(...args);

    const known = getDb().prepare<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM youtube_videos WHERE video_id = ?`);
    const out: SourceItem[] = [];
    for (const r of rows) {
      if (skipTabUrl(r.url)) continue;
      const yt = youtubeId(r.url);
      if (yt && known.get(yt)!.n > 0) continue;
      if (!r.summary && (r.text_head ?? "").length < 200) continue;
      const repo = repoFromUrl(r.url);
      const isRepoRoot = !!repo && /^https?:\/\/(www\.)?github\.com\/[\w.-]+\/[\w.-]+\/?(#.*|\?.*)?$/i.test(r.url);
      out.push({
        source_kind: "tab",
        source_ref: r.id,
        url: r.url,
        title: r.title || r.url,
        published_at: null,
        created_at: r.archived_at,
        explicit: false,
        gate_text: [r.summary, r.description, r.text_head].filter(Boolean).join(" \n"),
        context: `A browser tab David had open and archived.${isRepoRoot ? " Text below is the GitHub repo's README." : ""}`,
        loadText: async () => {
          if (isRepoRoot) {
            const t = await fetchRepoText(repo!);
            if (t) return t;
          }
          const full = db.prepare<{ inner_text: string | null; summary: string | null; description: string | null }, [string]>(
            `SELECT inner_text, summary, description FROM tab_archive_tabs WHERE id = ?`,
          ).get(r.id);
          return [full?.summary ? `Tab summary: ${full.summary}` : "", full?.description ? `Meta description: ${full.description}` : "", full?.inner_text ?? ""]
            .filter(Boolean).join("\n\n");
        },
      });
    }
    return out;
  },
};
