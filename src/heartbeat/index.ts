import { Cron } from "croner";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";
import {
  getPendingItems,
  getPendingItemCount,
  getDueReminders,
  updateReminder,
  dismissReminder,
  updatePendingItem,
} from "../db/queries.ts";
import { triageAllPending } from "../triage/index.ts";
import { quickScanBatch } from "../research/quick-scan.ts";
import { scoreSignals } from "./signals.ts";
import { scanInbox } from "./inbox-watcher.ts";
import { detectThemes } from "./themes.ts";
import type { QuickScanResult } from "../research/quick-scan.ts";
import { InlineKeyboard } from "grammy";
import { briefingActionKeyboard, approvalKeyboard } from "../telegram/keyboards.ts";
import type { Bot } from "grammy";
import type { PendingItem } from "../shared/types.ts";
import { checkAutonomyRule } from "./autonomy.ts";

const log = createLogger("heartbeat");
const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

interface OrchestratorState {
  lastRunAt: string | null;
  runCount: number;
  totalItemsProcessed: number;
}

interface OrchestratorConfig {
  intervalMinutes: number;
  quietStart: number;
  quietEnd: number;
}

interface OrchestratorDeps {
  getBot: () => Bot | null;
  defaultChatIds: number[];
  digestChatId?: string;
  digestTopicId?: number;
  config: OrchestratorConfig;
}

interface TickResult {
  pendingProcessed: number;
  triagedCount: number;
  droppedCount: number;
  topItems: PendingItem[];
  autoResearchItems: PendingItem[];
}

export class HeartbeatRunner {
  private cron: Cron | null = null;
  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private digestChatId?: string;
  private digestTopicId?: number;
  private config: OrchestratorConfig;
  private running = false;
  private statePath: string;

  constructor(deps: OrchestratorDeps) {
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.digestChatId = deps.digestChatId;
    this.digestTopicId = deps.digestTopicId;
    this.config = deps.config;
    this.statePath = join(KNOWLEDGE_DIR, "orchestrator-state.json");
  }

  start(): void {
    const pattern = `*/${this.config.intervalMinutes} * * * *`;
    log.info("Starting heartbeat orchestrator", { pattern, config: this.config });

    this.cron = new Cron(pattern, () => {
      this.tick().catch((err) => {
        log.error("Heartbeat tick failed", { error: String(err) });
      });
    });
  }

  stop(): void {
    if (this.cron) {
      this.cron.stop();
      this.cron = null;
      log.info("Heartbeat orchestrator stopped");
    }
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    const { quietStart, quietEnd } = this.config;
    if (quietStart > quietEnd) {
      return hour >= quietStart || hour < quietEnd;
    }
    return hour >= quietStart && hour < quietEnd;
  }

  private readState(): OrchestratorState {
    try {
      if (existsSync(this.statePath)) {
        return JSON.parse(readFileSync(this.statePath, "utf-8")) as OrchestratorState;
      }
    } catch {
      // Fall through to default
    }
    return { lastRunAt: null, runCount: 0, totalItemsProcessed: 0 };
  }

  private writeState(state: OrchestratorState): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  private async tick(): Promise<void> {
    if (this.running) {
      log.info("Heartbeat skipped (already running)");
      return;
    }

    if (this.isQuietHours()) {
      log.info("Heartbeat skipped (quiet hours)");
      return;
    }

    this.running = true;
    const state = this.readState();

    try {
      // --- Phase 1: Intake ---
      const result = await this.phaseIntake();

      // --- Phase 3: Inbox Watcher ---
      try {
        const inboxActions = scanInbox();
        if (inboxActions.length > 0) {
          log.info("Inbox watcher processed", { count: inboxActions.length });
        }
      } catch (err) {
        log.error("Inbox watcher failed", { error: String(err) });
      }

      // --- Phase 3b: Theme Clustering ---
      try {
        const themed = await detectThemes();
        if (themed > 0) {
          log.info("Theme clustering assigned items", { count: themed });
        }
      } catch (err) {
        log.error("Theme clustering failed", { error: String(err) });
      }

      // --- Phase 2b: Auto-research strong signals ---
      if (result.autoResearchItems.length > 0) {
        log.info("Auto-researching strong signal items", {
          count: result.autoResearchItems.length,
        });
        // Queue for deep research (actual research happens asynchronously)
        for (const item of result.autoResearchItems) {
          updatePendingItem(item.id, {
            auto_decision: "deep_research_queued",
          });
        }
      }

      // --- Phase 4: Surfacing ---
      if (result.triagedCount > 0 || result.topItems.length > 0) {
        await this.phaseSurfacing(result);
      }

      // Update state
      const newState: OrchestratorState = {
        lastRunAt: new Date().toISOString(),
        runCount: state.runCount + 1,
        totalItemsProcessed: state.totalItemsProcessed + result.pendingProcessed,
      };
      this.writeState(newState);

      log.info("Heartbeat tick completed", {
        processed: result.pendingProcessed,
        triaged: result.triagedCount,
        dropped: result.droppedCount,
        runCount: newState.runCount,
      });
    } catch (err) {
      log.error("Heartbeat orchestrator error", { error: String(err) });
    }

    // Check due reminders (runs even if pipeline fails)
    try {
      await this.checkDueReminders();
    } catch (err) {
      log.error("Due reminders check failed", { error: String(err) });
    }

    this.running = false;
  }

  private async phaseIntake(): Promise<TickResult> {
    const pendingCount = getPendingItemCount("pending");
    if (pendingCount === 0) {
      log.info("No pending items to process");
      return { pendingProcessed: 0, triagedCount: 0, droppedCount: 0, topItems: [], autoResearchItems: [] };
    }

    log.info("Phase 1: Intake", { pendingCount });

    // Run triage (handles metadata extraction + GLM value-extraction)
    const triageResult = await triageAllPending(50);
    const processed = triageResult.totalProcessed;

    // Get recently triaged items
    const triaged = getPendingItems("triaged", 50);

    // --- Phase 2: Quick Scan + Signal Scoring ---
    // Only scan items that don't already have a quick_scan_summary
    const needsScan = triaged
      .filter((item) => !item.quick_scan_summary && item.priority !== null && item.priority <= 3)
      .slice(0, 10);

    let scanResults = new Map<number, QuickScanResult>();
    if (needsScan.length > 0) {
      log.info("Phase 2: Quick Scan", { count: needsScan.length });
      scanResults = await quickScanBatch(needsScan, 3);

      // Persist quick scan results and signal scores
      for (const item of needsScan) {
        const scan = scanResults.get(item.id);
        if (!scan) continue;

        const signalResult = scoreSignals(item, scan);

        updatePendingItem(item.id, {
          quick_scan_summary: scan.summary,
          signal_score: signalResult.score,
          auto_decision: signalResult.autoAction,
        });
      }
    }

    // Check learned autonomy rules for items without strong contextual signals
    for (const item of triaged) {
      if (item.auto_decision) continue; // Already has a contextual signal decision

      const sourceSignal = item.source ? `source:${item.source}` : null;
      const platformSignal = item.platform ? `platform:${item.platform}` : null;

      for (const signalValue of [sourceSignal, platformSignal].filter(Boolean)) {
        const rule = checkAutonomyRule("digest_item", signalValue!);
        if (rule) {
          updatePendingItem(item.id, { auto_decision: rule.action });
          log.info("Autonomy auto-decision", {
            itemId: item.id,
            action: rule.action,
            level: rule.level,
            signal: signalValue,
          });
          break;
        }
      }
    }

    // Build top items list (now enriched with quick scan)
    const enrichedTriaged = getPendingItems("triaged", 50);
    const topItems = enrichedTriaged
      .filter((item) => item.priority !== null && item.priority <= 2)
      .sort((a, b) => (b.signal_score ?? 0) - (a.signal_score ?? 0) || (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 5);

    // Collect auto-research items (strong contextual signals)
    const autoResearchItems = enrichedTriaged.filter(
      (item) => item.auto_decision === "deep_research"
    );

    const droppedCount = processed - triaged.length;

    return {
      pendingProcessed: processed,
      triagedCount: triaged.length,
      droppedCount: Math.max(0, droppedCount),
      topItems,
      autoResearchItems,
    };
  }

  // --- Phase 4: Surfacing ---
  private async phaseSurfacing(result: TickResult): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;

    // Route digest to group topic if configured, otherwise DM
    const targetChatIds: (string | number)[] = this.digestChatId
      ? [this.digestChatId]
      : this.defaultChatIds;
    const topicOpts = this.digestChatId && this.digestTopicId
      ? { message_thread_id: this.digestTopicId }
      : {};

    if (targetChatIds.length === 0) return;

    // Header message
    const headerLines = [
      `<b>Inbox Digest</b>`,
      `${result.triagedCount} triaged | ${result.droppedCount} dropped`,
    ];

    if (result.autoResearchItems.length > 0) {
      const names = result.autoResearchItems
        .map((i) => i.title ?? "Untitled")
        .slice(0, 3)
        .join(", ");
      headerLines.push(`Auto-researching: ${escapeHtml(names)}`);
    }

    // Report learned autonomy actions
    const autoArchived = result.topItems.filter((i) => i.auto_decision === "archive");
    if (autoArchived.length > 0) {
      headerLines.push(`Auto-archived: ${autoArchived.length} items (learned pattern)`);
    }

    const header = headerLines.join("\n");

    for (const chatId of targetChatIds) {
      try {
        await bot.api.sendMessage(chatId, header, { parse_mode: "HTML", ...topicOpts });
      } catch (err) {
        log.error("Failed to send digest header", { chatId, error: String(err) });
      }

      // Each top item as its own message with action buttons
      for (const item of result.topItems) {
        try {
          const badge = this.valueTypeBadge(item.value_type ?? item.category);
          const title = escapeHtml(item.title ?? "Untitled");
          const link = item.url ? `<a href="${escapeHtml(item.url)}">${title}</a>` : title;
          const value = escapeHtml(truncate(
            item.quick_scan_summary ?? item.extracted_value ?? item.triage_summary ?? "", 200
          ));
          const source = item.platform ? ` — ${escapeHtml(item.platform)}` : "";
          const profile = item.profile ? `/${escapeHtml(item.profile)}` : "";

          const msg = [
            `<b>${badge}</b> (P${item.priority}) ${link}`,
            `${value}${source}${profile}`,
          ].join("\n");

          const kb = new InlineKeyboard()
            .text("Research", `rr:${item.id}`)
            .text("Watch", `rw:${item.id}`)
            .text("Archive", `rx:${item.id}`)
            .text("Drop", `rd:${item.id}`);

          await bot.api.sendMessage(chatId, msg, {
            parse_mode: "HTML",
            reply_markup: kb,
            ...topicOpts,
          });
        } catch (err) {
          log.error("Failed to send digest item", { chatId, itemId: item.id, error: String(err) });
        }
      }
    }
  }

  private valueTypeBadge(valueType: string | null): string {
    switch (valueType) {
      case "technique": return "Technique";
      case "tool": return "Tool";
      case "actionable": return "Action";
      default: return "Item";
    }
  }

  // --- Reminders ---
  private async checkDueReminders(): Promise<void> {
    const bot = this.getBot();
    if (!bot || this.defaultChatIds.length === 0) return;

    const dueReminders = getDueReminders();
    if (dueReminders.length === 0) return;

    log.info("Processing due reminders", { count: dueReminders.length });

    for (const reminder of dueReminders) {
      if (reminder.remind_count >= reminder.max_reminds) {
        dismissReminder(reminder.id);
        log.info("Auto-dismissed reminder (max reminds reached)", { id: reminder.id, title: reminder.title });
        continue;
      }

      const keyboard = reminder.type === "research"
        ? approvalKeyboard(reminder.id)
        : briefingActionKeyboard(reminder.id);

      const messageText = `${reminder.type.toUpperCase()}: ${reminder.title}${reminder.description ? "\n" + reminder.description : ""}`;

      for (const chatId of this.defaultChatIds) {
        try {
          await bot.api.sendMessage(chatId, messageText, {
            reply_markup: keyboard,
          });
        } catch (err) {
          log.error("Failed to send reminder", {
            chatId,
            reminderId: reminder.id,
            error: String(err),
          });
        }
      }

      updateReminder(reminder.id, {
        remind_count: reminder.remind_count + 1,
        status: "active",
      });
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "...";
}
