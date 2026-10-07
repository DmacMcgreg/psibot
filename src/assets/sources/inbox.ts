/**
 * pending_items pollers: GitHub stars (source_kind "github") and the other
 * things David saved himself — Chrome-extension saves, Reddit saves, Telegram
 * and manual links (source_kind "inbox"). All are explicit choices.
 *
 * GitHub items read the README through the REST API (the stored page text is
 * navigation chrome). Other items use the stored title, description and triage
 * summaries; X captures that only got the "JavaScript is disabled" page are
 * skipped.
 */

import { getDb } from "../../db/index.ts";
import { daysAgo, type ListOptions, type Source, type SourceItem } from "./types.ts";
import { fetchRepoText, repoFromUrl } from "./github.ts";

const CAPTURE_FAILED = /JavaScript[- ](is )?disabled|could not be accessed|capture failure|no (actual )?(post )?content was (extracted|retrievable)/i;

interface Row {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  source: string;
  quick_scan_summary: string | null;
  triage_summary: string | null;
  extracted_value: string | null;
  published_at: string | null;
  created_at: string;
}

function listPending(kind: "github" | "inbox", opts: ListOptions): SourceItem[] {
  const where = [kind === "github" ? "source = 'github'" : "source IN ('chrome-extension','reddit','telegram','manual')", "status != 'deleted'"];
  const args: (string | number)[] = [];
  if (opts.after) { where.push("created_at > ?"); args.push(opts.after); }
  if (opts.sinceDays) { where.push("created_at >= ?"); args.push(daysAgo(opts.sinceDays)); }
  args.push(opts.limit);
  const rows = getDb().prepare<Row, (string | number)[]>(
    `SELECT id, url, title, description, source, quick_scan_summary, triage_summary, extracted_value, published_at, created_at
     FROM pending_items WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(...args);

  const out: SourceItem[] = [];
  for (const r of rows) {
    const stored = [r.description, r.quick_scan_summary, r.triage_summary, r.extracted_value].filter(Boolean).join("\n\n");
    if (kind === "inbox" && CAPTURE_FAILED.test(stored) && stored.length < 800) continue;
    const repo = repoFromUrl(r.url);
    const label = r.source === "github" ? "David starred this GitHub repo."
      : r.source === "reddit" ? "David saved this Reddit post."
      : r.source === "chrome-extension" ? "David saved this page with the browser extension."
      : "David sent this link himself.";
    out.push({
      source_kind: kind,
      source_ref: kind === "github" && repo ? repo.toLowerCase() : `pending:${r.id}`,
      url: r.url,
      title: r.title ?? r.url,
      published_at: r.published_at,
      created_at: r.created_at,
      explicit: true,
      gate_text: stored,
      context: `${label}${repo ? " Text below is the repo's metadata and README. If the repo itself fits a track, emit it as a tool (or skill) asset." : ""}`,
      loadText: async () => {
        if (repo) {
          const t = await fetchRepoText(repo);
          if (t) return t;
        }
        return `${r.title ?? ""}\n\n${stored}`;
      },
    });
  }
  return out;
}

export const githubSource: Source = { kind: "github", list: (o) => listPending("github", o) };
export const inboxSource: Source = { kind: "inbox", list: (o) => listPending("inbox", o) };
