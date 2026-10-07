/**
 * research_notes poller. Uses the note's markdown. Notes whose body carries
 * the leaked "Z.ai Built-in Tool" trace are broken (tool output instead of
 * research) and are skipped.
 *
 * A note is explicit (the gate's lower floor) only when David asked for that
 * research. The Telegram Research button and the Mini App review queue both go
 * through applyItemAction (src/triage/actions.ts), which logs a feedback_log
 * row with user_action "research" for the item; that row is the marker. Notes
 * without it (heartbeat auto-research, or any path that logs nothing) are
 * gated at the normal floor.
 *
 * To mark another path explicit when David starts it (the /research command,
 * the agent's research_item tool in a chat with David, NotePlan research tags),
 * log the same row there:
 *   insertFeedbackLog({ item_id, user_action: "research", system_recommendation: "command" })
 * Any user_action starting with "research" counts.
 */

import { getDb } from "../../db/index.ts";
import { daysAgo, type ListOptions, type Source, type SourceItem } from "./types.ts";

interface Row {
  id: number;
  title: string;
  url: string | null;
  summary: string | null;
  head: string;
  created_at: string;
  asked: number;
}

export const researchSource: Source = {
  kind: "research",
  list(opts: ListOptions): SourceItem[] {
    const where = ["r.markdown NOT LIKE '%Z.ai Built-in Tool%'"];
    const args: (string | number)[] = [];
    if (opts.after) { where.push("r.created_at > ?"); args.push(opts.after); }
    if (opts.sinceDays) { where.push("r.created_at >= ?"); args.push(daysAgo(opts.sinceDays, true)); }
    args.push(opts.limit);
    const rows = getDb().prepare<Row, (string | number)[]>(
      `SELECT r.id, r.title, r.url, r.summary, substr(r.markdown, 1, 3000) AS head, r.created_at,
              EXISTS (SELECT 1 FROM feedback_log f WHERE f.item_id = r.item_id AND f.user_action LIKE 'research%') AS asked
       FROM research_notes r WHERE ${where.join(" AND ")}
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    ).all(...args);
    return rows.map((r) => ({
      source_kind: "research" as const,
      source_ref: String(r.id),
      url: r.url,
      title: r.title,
      published_at: null,
      created_at: r.created_at,
      explicit: r.asked === 1,
      gate_text: r.summary ?? r.head.replace(/^---[\s\S]*?---/, ""),
      context: r.asked === 1
        ? "A research note PsiBot wrote because David pressed Research on this item."
        : "A research note PsiBot wrote on its own (auto-research); David did not ask for it.",
      loadText: async () =>
        getDb().prepare<{ markdown: string }, [number]>(`SELECT markdown FROM research_notes WHERE id = ?`).get(r.id)?.markdown ?? "",
    }));
  },
};
