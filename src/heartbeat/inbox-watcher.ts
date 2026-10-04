import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger, type Logger } from "../shared/logger.ts";
import { getPendingItems, updatePendingItem } from "../db/queries.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("heartbeat:inbox-watcher");
const NOTEPLAN_INBOX = join(homedir(), "Documents/NotePlan-Notes/Notes/00 - Inbox");
const RESEARCH_OUTPUT_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research");

const RESEARCH_DECISION_STATES = new Set([
  "deep_research_queued",
  "deep_research_running",
  "deep_research_done",
  "deep_research_failed",
  "quick_research_queued",
  "quick_research_running",
  "quick_research_done",
  "quick_research_failed",
]);

function hasResearchDecision(decision: string | null): boolean {
  return decision !== null && RESEARCH_DECISION_STATES.has(decision);
}

const EPERM_SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Daemon-process memory: survives across heartbeat ticks, resets on restart.
 * At most one EPERM summary line is logged per interval, so a TCC-blocked
 * inbox file says something once a day instead of ERRORing every 30 min.
 */
let lastEpermSummaryAt: number | null = null;

/** Test hook: the mute window is module state; reset it between tests. */
export function resetEpermSummaryForTests(): void {
  lastEpermSummaryAt = null;
}

export interface InboxAction {
  itemId: number;
  action: "research-quick" | "research-deep" | "watch" | "archive" | "drop" | "retriage";
  noteplanPath: string;
}

/** Injected seam so the suite can pin EPERM-skip behaviour without the live DB/fs. */
export interface InboxScanDeps {
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  getPendingItems?: typeof getPendingItems;
  updatePendingItem?: typeof updatePendingItem;
  logger?: Logger;
  now?: () => number;
}

/**
 * Scan NotePlan inbox for user-tagged notes and dispatch actions.
 * Returns list of actions taken for reporting in the digest.
 *
 * A per-file EPERM (macOS TCC) skips just that file — with one summary line
 * per 24h — while any other open failure still throws, so the heartbeat tick
 * keeps its full ERROR (src/heartbeat/index.ts catch site).
 */
export function scanInbox(deps: InboxScanDeps = {}): InboxAction[] {
  const exists = deps.exists ?? existsSync;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const loadItems = deps.getPendingItems ?? getPendingItems;
  const updateItem = deps.updatePendingItem ?? updatePendingItem;
  const logger = deps.logger ?? log;
  const now = deps.now ?? Date.now;

  if (!exists(NOTEPLAN_INBOX)) return [];

  const actions: InboxAction[] = [];
  const skippedEpermPaths: string[] = [];

  // Get all items that have noteplan_paths (triaged or archived — buttons archive them)
  const triaged = loadItems("triaged", 200);
  const archived = loadItems("archived", 200);
  const allItems = [...triaged, ...archived];
  const itemsByPath = new Map<string, PendingItem>();
  for (const item of allItems) {
    if (item.noteplan_path) {
      itemsByPath.set(item.noteplan_path, item);
    }
  }

  // Scan each note that has a DB entry (regardless of folder)
  for (const [filePath, item] of itemsByPath) {
    if (!exists(filePath)) continue; // Handled below as "deleted"

    // Skip research output notes — they carry the `research` tag by design and
    // must never re-trigger the research pipeline. Without this, completed
    // research loops forever (it updates `noteplan_path` to its own output).
    if (filePath.startsWith(RESEARCH_OUTPUT_DIR)) continue;

    let content: string;
    try {
      content = readFile(filePath);
    } catch (err) {
      // Per-file macOS TCC (com.apple.macl) opens fail EPERM: skip just this
      // file and summarize once per 24h (census 2026-10-03). Everything else
      // still throws, so the heartbeat tick keeps its full ERROR.
      if (err instanceof Error && "code" in err && err.code === "EPERM") {
        skippedEpermPaths.push(filePath);
        continue;
      }
      throw err;
    }
    const tags = extractFrontmatterTags(content);

    // Only process notes with user-added action tags (namespaced under action/)
    const hasTag = (t: string) => tags.includes(t) || tags.includes(`action/${t}`);

    if (hasTag("retriage") && item.status !== "pending") {
      updateItem(item.id, {
        status: "pending",
        auto_decision: null,
        signal_score: null,
        quick_scan_summary: null,
        surfaced_at: null,
      });
      actions.push({ itemId: item.id, action: "retriage", noteplanPath: filePath });
      logger.info("Inbox action: retriage", { itemId: item.id, path: filePath });
    } else if (hasTag("research-quick") && !hasResearchDecision(item.auto_decision)) {
      updateItem(item.id, { auto_decision: "quick_research_queued" });
      actions.push({ itemId: item.id, action: "research-quick", noteplanPath: filePath });
      logger.info("Inbox action: research-quick", { itemId: item.id, path: filePath });
    } else if ((hasTag("research-deep") || hasTag("research")) && !hasResearchDecision(item.auto_decision)) {
      updateItem(item.id, { auto_decision: "deep_research_queued" });
      actions.push({ itemId: item.id, action: "research-deep", noteplanPath: filePath });
      logger.info("Inbox action: research-deep", { itemId: item.id, path: filePath });
    } else if (hasTag("watch") && item.watch_status !== "watching") {
      updateItem(item.id, { status: "archived", watch_status: "watching" });
      actions.push({ itemId: item.id, action: "watch", noteplanPath: filePath });
      logger.info("Inbox action: watch", { itemId: item.id, path: filePath });
    } else if (hasTag("drop") && item.status !== "deleted") {
      updateItem(item.id, { status: "deleted" });
      actions.push({ itemId: item.id, action: "drop", noteplanPath: filePath });
      logger.info("Inbox action: drop", { itemId: item.id, path: filePath });
    } else if (hasTag("archive") && item.status !== "archived") {
      updateItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archive", noteplanPath: filePath });
      logger.info("Inbox action: archive", { itemId: item.id, path: filePath });
    }
  }

  // Check for deleted notes (item has noteplan_path but file is gone)
  for (const [path, item] of itemsByPath) {
    if (!exists(path) && item.status !== "archived" && item.status !== "deleted") {
      updateItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archive", noteplanPath: path });
      logger.info("Inbox action: archive (note deleted)", { itemId: item.id, path });
    }
  }

  // One muted summary line per 24h naming the skipped file(s) — the census
  // alternative to an ERROR every 30 min while the owner-side macl fix pends.
  if (skippedEpermPaths.length > 0) {
    const at = now();
    if (lastEpermSummaryAt === null || at - lastEpermSummaryAt >= EPERM_SUMMARY_INTERVAL_MS) {
      lastEpermSummaryAt = at;
      logger.warn(
        `Inbox watcher skipping ${skippedEpermPaths.length} NotePlan file(s) it cannot open (EPERM, per-file macOS TCC); owner-side fix: re-save the file or grant Full Disk Access`,
        { paths: skippedEpermPaths }
      );
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
