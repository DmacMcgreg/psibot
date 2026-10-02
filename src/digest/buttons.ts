/**
 * Weekly-digest action buttons — the asset-digest's proven button+receipt
 * shape (research/psibot-pipeline-value.md F3/F4) applied to the flagship
 * digest.
 *
 * Shape: one button ROW per top item, riding the digest's existing Telegram
 * chunk — never per-item cards (David's 2026-07-22 surface policy,
 * src/shared/surface-policy.ts, stays untouched). Every click writes ONE
 * attributed feedback_log row (content_type 'weekly_digest'); nothing else
 * mutates — no item status change, no autonomy learning (autonomy_rules
 * untouched by design for this surface; it measures intent, not triage).
 *
 * Gate (README): within 2 weeks, ≥1 weekly digest with ≥1 recorded button
 * action, recomputable from the registry alone:
 *   actions  → feedback_log WHERE content_type='weekly_digest'
 *   delivery → sent_messages WHERE source='weekly-digest'
 */

import { InlineKeyboard } from "grammy";
import { getPendingItemById, insertFeedbackLog, markResearchNoteConsumed } from "../db/queries.ts";
import type { TopItem } from "./compose.ts";

const trunc = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

/** Everything after "dg:" — verb, pending_items id, digest week. */
export const DIGEST_CALLBACK_RE = /^([wasn]):(\d+):(\d{4}-W\d{2})$/;

/** The three verbs and the feedback row each writes. */
const VERBS = {
  w: { userAction: "watch", toast: "Watching — will resurface", doneLabel: "👀 Watching" },
  a: { userAction: "archive", toast: "Archived intent recorded", doneLabel: "🗄 Archived" },
  s: { userAction: "snooze", toast: "Snoozed — ask again next week", doneLabel: "💤 Snoozed" },
} as const satisfies Record<string, { userAction: string; toast: string; doneLabel: string }>;

type Verb = keyof typeof VERBS;

/** `db:research_notes/<id>` — the note ref pending_items.noteplan_path carries. */
const NOTE_REF_RE = /^db:research_notes\/(\d+)$/;

/**
 * One button row per shown top item, numbered to match the digest's numbered
 * top-items list: `N 👀 Watch · 🗄 Archive · 💤 Snooze`. Callbacks stay far
 * under Telegram's 64-byte cap (`dg:w:12345:2026-W40` = 20 bytes).
 */
export function digestKeyboard(items: TopItem[], week: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  items.forEach((item, i) => {
    if (i > 0) kb.row();
    kb.text(`${i + 1} 👀 Watch`, `dg:w:${item.id}:${week}`)
      .text("🗄 Archive", `dg:a:${item.id}:${week}`)
      .text("💤 Snooze", `dg:s:${item.id}:${week}`);
  });
  return kb;
}

export interface DigestCallbackResult {
  ok: boolean;
  itemId: number | null;
  toast: string;
  /** Label for the inert button that replaces the item's row once handled. */
  doneLabel?: string;
}

/**
 * Handle one digest button. `payload` is what follows "dg:" — e.g. "w:12:2026-W40".
 * Never throws: failures come back as a toast, and a failed click writes no
 * feedback row (a receipt must correspond to a real attributable action).
 */
export function handleDigestCallback(payload: string): DigestCallbackResult {
  const m = DIGEST_CALLBACK_RE.exec(payload);
  if (!m) return { ok: false, itemId: null, toast: "Bad button" };
  const [, verb, idStr, week] = m;
  const itemId = Number.parseInt(idStr, 10);
  if (verb === "n") return { ok: false, itemId, toast: "Already handled" };

  // A button can outlive its item (items are deletable); never fabricate a
  // receipt for something David can no longer see.
  const item = getPendingItemById(itemId);
  if (!item) return { ok: false, itemId, toast: "That item no longer exists" };

  const spec = VERBS[verb as Verb];
  insertFeedbackLog({
    item_id: itemId,
    content_type: "weekly_digest",
    source: "telegram",
    system_recommendation: "digest-top",
    user_action: spec.userAction,
    signal_snapshot: JSON.stringify({ digestWeek: week, title: trunc(item.title ?? "Untitled", 80) }),
  });

  // "Answer" receipt: acting on an item that has a research note counts as
  // consuming that note (first action wins; later opens don't overwrite).
  const noteRef = NOTE_REF_RE.exec(item.noteplan_path ?? "");
  if (noteRef) markResearchNoteConsumed(Number.parseInt(noteRef[1], 10));

  return {
    ok: true,
    itemId,
    toast: spec.toast,
    doneLabel: `${spec.doneLabel}: ${trunc(item.title ?? "Untitled", 30)}`,
  };
}

type Button = { text: string; callback_data?: string; url?: string };

/**
 * Replace the handled item's row with one inert "done" button (`dg:n:<id>`),
 * so the digest chunk keeps a visible record of what was done — same pattern
 * as the asset digest's markRowDone.
 */
export function markDigestRowDone(rows: Button[][], itemId: number, label: string): Button[][] {
  const mine = (b: Button) => {
    if (!b.callback_data || !/^dg:[wasn]:/.test(b.callback_data)) return false;
    return Number.parseInt(b.callback_data.split(":")[2] ?? "", 10) === itemId;
  };
  return rows.map((row) => (row.some(mine) ? [{ text: label, callback_data: `dg:n:${itemId}` }] : row));
}
