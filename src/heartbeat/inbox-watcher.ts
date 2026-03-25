import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.ts";
import { getPendingItems, updatePendingItem } from "../db/queries.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("heartbeat:inbox-watcher");
const NOTEPLAN_INBOX = join(homedir(), "Documents/NotePlan-Notes/Notes/00 - Inbox");

export interface InboxAction {
  itemId: number;
  action: "research-quick" | "research-deep" | "watch" | "archive" | "drop" | "retriage";
  noteplanPath: string;
}

/**
 * Scan NotePlan inbox for user-tagged notes and dispatch actions.
 * Returns list of actions taken for reporting in the digest.
 */
export function scanInbox(): InboxAction[] {
  if (!existsSync(NOTEPLAN_INBOX)) return [];

  const actions: InboxAction[] = [];

  // Get all items that have noteplan_paths (triaged or archived — buttons archive them)
  const triaged = getPendingItems("triaged", 200);
  const archived = getPendingItems("archived", 200);
  const allItems = [...triaged, ...archived];
  const itemsByPath = new Map<string, PendingItem>();
  for (const item of allItems) {
    if (item.noteplan_path) {
      itemsByPath.set(item.noteplan_path, item);
    }
  }

  // Scan each note that has a DB entry (regardless of folder)
  for (const [filePath, item] of itemsByPath) {
    if (!existsSync(filePath)) continue; // Handled below as "deleted"

    const content = readFileSync(filePath, "utf-8");
    const tags = extractFrontmatterTags(content);

    // Only process notes with user-added action tags (namespaced under action/)
    const hasTag = (t: string) => tags.includes(t) || tags.includes(`action/${t}`);

    if (hasTag("retriage") && item.status !== "pending") {
      updatePendingItem(item.id, {
        status: "pending",
        auto_decision: null,
        signal_score: null,
        quick_scan_summary: null,
        surfaced_at: null,
      });
      actions.push({ itemId: item.id, action: "retriage", noteplanPath: filePath });
      log.info("Inbox action: retriage", { itemId: item.id, path: filePath });
    } else if (hasTag("research-quick") && item.auto_decision !== "quick_research_queued") {
      updatePendingItem(item.id, { auto_decision: "quick_research_queued" });
      actions.push({ itemId: item.id, action: "research-quick", noteplanPath: filePath });
      log.info("Inbox action: research-quick", { itemId: item.id, path: filePath });
    } else if ((hasTag("research-deep") || hasTag("research")) && item.auto_decision !== "deep_research_queued") {
      updatePendingItem(item.id, { auto_decision: "deep_research_queued" });
      actions.push({ itemId: item.id, action: "research-deep", noteplanPath: filePath });
      log.info("Inbox action: research-deep", { itemId: item.id, path: filePath });
    } else if (hasTag("watch") && item.watch_status !== "watching") {
      updatePendingItem(item.id, { status: "archived", watch_status: "watching" });
      actions.push({ itemId: item.id, action: "watch", noteplanPath: filePath });
      log.info("Inbox action: watch", { itemId: item.id, path: filePath });
    } else if (hasTag("drop") && item.status !== "deleted") {
      updatePendingItem(item.id, { status: "deleted" });
      actions.push({ itemId: item.id, action: "drop", noteplanPath: filePath });
      log.info("Inbox action: drop", { itemId: item.id, path: filePath });
    } else if (hasTag("archive") && item.status !== "archived") {
      updatePendingItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archive", noteplanPath: filePath });
      log.info("Inbox action: archive", { itemId: item.id, path: filePath });
    }
  }

  // Check for deleted notes (item has noteplan_path but file is gone)
  for (const [path, item] of itemsByPath) {
    if (!existsSync(path) && item.status !== "archived" && item.status !== "deleted") {
      updatePendingItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archive", noteplanPath: path });
      log.info("Inbox action: archive (note deleted)", { itemId: item.id, path });
    }
  }

  return actions;
}

function extractFrontmatterTags(content: string): string[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  const fm = fmMatch[1];
  const tagsMatch = fm.match(/tags:\n((?:\s+-\s+.+\n)*)/);
  if (!tagsMatch) return [];

  return tagsMatch[1]
    .split("\n")
    .map((l) => l.replace(/^\s+-\s+/, "").trim())
    .filter(Boolean);
}
