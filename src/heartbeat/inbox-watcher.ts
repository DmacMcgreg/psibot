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

  // Get all triaged items that have noteplan_paths
  const triaged = getPendingItems("triaged", 200);
  const itemsByPath = new Map<string, PendingItem>();
  for (const item of triaged) {
    if (item.noteplan_path) {
      itemsByPath.set(item.noteplan_path, item);
    }
  }

  // Check each note in the inbox
  const files = readdirSync(NOTEPLAN_INBOX).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(NOTEPLAN_INBOX, file);
    const item = itemsByPath.get(filePath);
    if (!item) continue; // Not a psibot-managed note

    const content = readFileSync(filePath, "utf-8");
    const tags = extractFrontmatterTags(content);

    // Only process notes that have tags beyond psibot-triage
    const userTags = tags.filter((t) => t !== "psibot-triage" && t !== "inbox");
    if (userTags.length === 0) continue;

    if (userTags.includes("research")) {
      updatePendingItem(item.id, { auto_decision: "deep_research_queued" });
      actions.push({ itemId: item.id, action: "research", noteplanPath: filePath });
      log.info("Inbox action: research", { itemId: item.id, file });
    } else if (userTags.includes("watch")) {
      updatePendingItem(item.id, { watch_status: "watching" });
      actions.push({ itemId: item.id, action: "watch", noteplanPath: filePath });
      log.info("Inbox action: watch", { itemId: item.id, file });
    }
    // Any other user tag = acknowledged, will be themed by clustering
  }

  // Check for deleted notes (item has noteplan_path but file is gone)
  for (const [path, item] of itemsByPath) {
    if (!existsSync(path)) {
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
