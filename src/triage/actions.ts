/**
 * Shared triage-item actions — the single source of truth for what "Research /
 * Watch / Archive / Drop" do to a `pending_items` row.
 *
 * Extracted from the Telegram callback handler (src/telegram/keyboards.ts) so
 * both surfaces — the inline-keyboard buttons in Telegram AND the Mini App
 * Review queue (/tma/review) — apply identical DB effects, NotePlan tag
 * side-effects, feedback logging, and autonomy learning.
 *
 * The four actions and their effects mirror the "Inbox Triage & NotePlan Tag
 * Flow" table in CLAUDE.md:
 *
 *   research → status: archived, auto_decision: deep_research_queued, tag action/research
 *   watch    → status: archived, watch_status: watching,            tag action/watch
 *   archive  → status: archived,                                    tag action/archive
 *   drop     → status: deleted,                                     tag action/drop
 *
 * In all four cases we also insert a feedback_log row (user_action vs the
 * "triage" system recommendation) and feed the autonomy learner. The autonomy
 * level-change, if any, is returned so callers can surface it however they like
 * (Telegram posts a News-topic ping; the Mini App ignores it).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  getPendingItemById,
  updatePendingItem,
  insertFeedbackLog,
} from "../db/queries.ts";
import { updateAutonomyFromFeedback } from "../heartbeat/autonomy.ts";
import type { AutonomyLevelChange } from "../heartbeat/autonomy.ts";
import type { PendingItem } from "../shared/types.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("triage:actions");

/** The four terminal user actions on a triaged item. */
export type ItemAction = "research" | "watch" | "archive" | "drop";

/** Whether a string is one of the four valid actions (route/input validation). */
export function isItemAction(s: string): s is ItemAction {
  return s === "research" || s === "watch" || s === "archive" || s === "drop";
}

export interface ApplyItemActionResult {
  ok: boolean;
  /** Short human-facing message (toast / callback answer). */
  message: string;
  /** The autonomy rule level change, if the action moved it; else null. */
  change: AutonomyLevelChange | null;
}

/** Build a compound signal key from an item's triage data for autonomy learning. */
function compoundSignalKey(item: {
  platform: string | null;
  profile: string | null;
  value_type: string | null;
}): string {
  const platform = item.platform ?? "unknown";
  const profile = item.profile ?? "*";
  const valueType = item.value_type ?? "unknown";
  return `${platform}:${profile}:${valueType}`;
}

/** Update (append) a tag in a NotePlan note's YAML frontmatter. No-op if missing. */
function addNoteplanTag(noteplanPath: string | null, tag: string): void {
  if (!noteplanPath || !existsSync(noteplanPath)) return;
  try {
    const content = readFileSync(noteplanPath, "utf-8");
    if (!content.startsWith("---")) return;
    const endIdx = content.indexOf("---", 3);
    if (endIdx === -1) return;
    const frontmatter = content.slice(0, endIdx + 3);
    const body = content.slice(endIdx + 3);

    // Check if tag already exists
    if (frontmatter.includes(`- ${tag}`)) return;

    // Insert tag after existing tags
    const tagsMatch = frontmatter.match(/^tags:\n((?:\s+-\s+.+\n)*)/m);
    if (tagsMatch) {
      const insertPos = frontmatter.indexOf(tagsMatch[0]) + tagsMatch[0].length;
      const updated = frontmatter.slice(0, insertPos) + `  - ${tag}\n` + frontmatter.slice(insertPos);
      writeFileSync(noteplanPath, updated + body, "utf-8");
    } else {
      // No tags section — add one before closing ---
      const updated = frontmatter.slice(0, endIdx) + `tags:\n  - ${tag}\n` + frontmatter.slice(endIdx);
      writeFileSync(noteplanPath, updated + body, "utf-8");
    }
  } catch (err) {
    log.error("Failed to update NotePlan tag", { noteplanPath, tag, error: String(err) });
  }
}

/** Per-action wiring: the DB patch, NotePlan tag, and success message. */
const ACTIONS: Record<
  ItemAction,
  { patch: Parameters<typeof updatePendingItem>[1]; tag: string; message: string }
> = {
  research: {
    patch: { status: "archived", auto_decision: "deep_research_queued" },
    tag: "action/research",
    message: "Research requested",
  },
  watch: {
    patch: { status: "archived", watch_status: "watching" },
    tag: "action/watch",
    message: "Watching this topic",
  },
  archive: {
    patch: { status: "archived" },
    tag: "action/archive",
    message: "Archived",
  },
  drop: {
    patch: { status: "deleted" },
    tag: "action/drop",
    message: "Dropped",
  },
};

/**
 * Apply one of the four terminal actions to a triaged item.
 *
 * Idempotent from the caller's perspective: if the item no longer exists it
 * returns `{ ok: false }` rather than throwing. On success the DB is patched,
 * the NotePlan note tagged, a feedback_log row inserted, and autonomy learning
 * updated; any resulting autonomy level change is returned on `change`.
 */
export function applyItemAction(itemId: number, action: ItemAction): ApplyItemActionResult {
  const spec = ACTIONS[action];
  const item: PendingItem | null = getPendingItemById(itemId);
  if (!item) {
    return { ok: false, message: "Item not found", change: null };
  }

  updatePendingItem(itemId, spec.patch);
  addNoteplanTag(item.noteplan_path ?? null, spec.tag);
  insertFeedbackLog({ item_id: itemId, user_action: action, system_recommendation: "triage" });

  let change: AutonomyLevelChange | null = null;
  try {
    change = updateAutonomyFromFeedback({
      signalType: "compound",
      signalValue: compoundSignalKey(item),
      systemRecommendation: "triage",
      userAction: action,
    });
  } catch (err) {
    log.error("Autonomy update failed", { itemId, action, error: String(err) });
  }

  return { ok: true, message: spec.message, change };
}
