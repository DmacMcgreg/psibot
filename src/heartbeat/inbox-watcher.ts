import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.ts";
import { getPendingItems, updatePendingItem } from "../db/queries.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("heartbeat:inbox-watcher");
const NOTEPLAN_INBOX = join(homedir(), "Documents/NotePlan-Notes/Notes/00 - Inbox");

interface InboxAction {
  itemId: number;
  action: "research" | "watch" | "archived";
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

    // Only process notes with user-added action tags
    if (tags.includes("research") && item.auto_decision !== "deep_research_queued") {
      updatePendingItem(item.id, { status: "archived", auto_decision: "deep_research_queued" });
      actions.push({ itemId: item.id, action: "research", noteplanPath: filePath });
      log.info("Inbox action: research", { itemId: item.id, path: filePath });
    } else if (tags.includes("watch") && item.watch_status !== "watching") {
      updatePendingItem(item.id, { status: "archived", watch_status: "watching" });
      actions.push({ itemId: item.id, action: "watch", noteplanPath: filePath });
      log.info("Inbox action: watch", { itemId: item.id, path: filePath });
    } else if (tags.includes("dropped") && item.status !== "deleted") {
      updatePendingItem(item.id, { status: "deleted" });
      actions.push({ itemId: item.id, action: "archived", noteplanPath: filePath });
      log.info("Inbox action: dropped (tag)", { itemId: item.id, path: filePath });
    } else if (tags.includes("archived") && item.status !== "archived") {
      updatePendingItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archived", noteplanPath: filePath });
      log.info("Inbox action: archived (tag)", { itemId: item.id, path: filePath });
    }
  }

  // Check for deleted notes (item has noteplan_path but file is gone)
  for (const [path, item] of itemsByPath) {
    if (!existsSync(path) && item.status !== "archived" && item.status !== "deleted") {
      updatePendingItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archived", noteplanPath: path });
      log.info("Inbox action: archived (note deleted)", { itemId: item.id, path });
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
