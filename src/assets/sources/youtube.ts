/**
 * youtube_videos poller. Text = transcript, falling back to the stored summary.
 * Rows whose summary is a fallback placeholder and that have no transcript
 * carry nothing to extract and are skipped.
 *
 * Explicit = David chose it: in Watch Later (playlist_item_id) or sent by
 * Telegram (no non-manual discovery candidate). Everything else is discovery.
 */

import { getDb } from "../../db/index.ts";
import { daysAgo, type ListOptions, type Source, type SourceItem } from "./types.ts";

export const FALLBACK_RE = /Auto-generated fallback|Review the full transcript for detailed insights/i;

interface Row {
  id: number;
  video_id: string;
  title: string;
  channel_title: string;
  url: string;
  summary_head: string;
  transcript_head: string;
  transcript_len: number;
  published_at: string | null;
  created_at: string;
  watch_later: number;
  discovered: number;
}

/** Summary without the markdown scaffolding, for gate embedding. */
function plain(md: string): string {
  return md.replace(/^#+\s.*$/gm, " ").replace(/[*_`>#-]+/g, " ").replace(/\s+/g, " ").trim();
}

export const youtubeSource: Source = {
  kind: "youtube",
  list(opts: ListOptions): SourceItem[] {
    const where = ["1=1"];
    const args: (string | number)[] = [];
    if (opts.after) { where.push("v.created_at > ?"); args.push(opts.after); }
    if (opts.sinceDays) { where.push("v.created_at >= ?"); args.push(daysAgo(opts.sinceDays)); }
    args.push(opts.limit);
    const rows = getDb().prepare<Row, (string | number)[]>(
      `SELECT v.id, v.video_id, v.title, v.channel_title, v.url,
              substr(v.markdown_summary, 1, 3000) AS summary_head,
              substr(v.transcript_text, 1, 2500) AS transcript_head,
              length(v.transcript_text) AS transcript_len,
              v.published_at, v.created_at,
              (v.playlist_item_id IS NOT NULL) AS watch_later,
              EXISTS (SELECT 1 FROM discovery_candidates c WHERE c.video_id = v.video_id AND c.source != 'manual') AS discovered
       FROM youtube_videos v
       WHERE ${where.join(" AND ")}
       ORDER BY v.created_at DESC, v.id DESC LIMIT ?`,
    ).all(...args);

    const out: SourceItem[] = [];
    for (const r of rows) {
      const fallback = FALLBACK_RE.test(r.summary_head);
      const hasTranscript = r.transcript_len >= 200;
      if (fallback && !hasTranscript) continue;
      const explicit = r.watch_later === 1 || r.discovered === 0;
      const gate = !fallback ? plain(r.summary_head) : r.transcript_head;
      out.push({
        source_kind: "youtube",
        source_ref: r.video_id,
        url: r.url,
        title: r.title,
        published_at: r.published_at,
        created_at: r.created_at,
        explicit,
        gate_text: `Channel: ${r.channel_title}. ${gate}`,
        context: `YouTube video by ${r.channel_title}${r.watch_later ? " (David saved it to Watch Later)" : explicit ? " (David sent it himself)" : " (found by auto-discovery)"}. Text below is the ${hasTranscript ? "transcript" : "stored summary"}.`,
        loadText: async () => {
          const row = getDb().prepare<{ transcript_text: string; markdown_summary: string }, [number]>(
            `SELECT transcript_text, markdown_summary FROM youtube_videos WHERE id = ?`,
          ).get(r.id);
          if (!row) return "";
          return row.transcript_text.length >= 200 ? row.transcript_text : row.markdown_summary;
        },
      });
    }
    return out;
  },
};
