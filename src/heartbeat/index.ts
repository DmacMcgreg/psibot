import { Cron } from "croner";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";
import {
  getPendingItems,
  getPendingItemCount,
  getUnsurfacedTriagedItems,
  markItemsSurfaced,
  getQueuedResearchItems,
  getDueReminders,
  updateReminder,
  dismissOverCapReminders,
  completeReminder,
  snoozeReminder,
  updatePendingItem,
  getPendingItemById,
  isTopicMuted,
} from "../db/queries.ts";
import { getUrgencySnoozeMs } from "../shared/reminder-snooze.ts";
import { triageAllPending } from "../triage/index.ts";
import { preliminaryResearch, deepResearch, createResearchNote } from "../research/index.ts";
import { scoreSignals } from "./signals.ts";
import { scanInbox } from "./inbox-watcher.ts";
import { detectThemes } from "./themes.ts";
import { InlineKeyboard } from "grammy";
import { briefingActionKeyboard } from "../telegram/keyboards.ts";
import type { Bot } from "grammy";
import type { PendingItem } from "../shared/types.ts";
import { checkAutonomyRule } from "./autonomy.ts";
import type { MemorySystem } from "../memory/index.ts";
import { embedBatch } from "../shared/embeddings.ts";
import { getDb } from "../db/index.ts";
import { indexItemEntities } from "../atlas/entities.ts";
import type { AtlasItem } from "../atlas/index.ts";
import type { AgentService } from "../agent/index.ts";
import { maybeRunCurator } from "../curator/index.ts";
import { tmaLink } from "../telegram/format.ts";
import { markExportNudged, exportNudgeId } from "../skills/usage.ts";

const log = createLogger("heartbeat");
const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

function hhmm(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

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
  memory: MemorySystem;
  /**
   * Optional agent reference. When provided, the heartbeat will call
   * `maybeRunCurator` once per tick. Without it, the autonomous skill
   * curator is silently disabled (the rest of the heartbeat keeps working).
   */
  agent?: AgentService;
}

interface TickResult {
  pendingProcessed: number;
  triagedCount: number;
  droppedCount: number;
  topItems: PendingItem[];
  autoResearchItems: PendingItem[];
}

interface ResearchCompletionRecord {
  itemId: number;
  title: string;
  label: "Quick" | "Deep";
  notePath: string | null;
  summary: string;
  url: string | null;
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
  private memory: MemorySystem;
  private agent?: AgentService;
  /**
   * Timestamp of the last observed agent activity. The curator's idle gate
   * is `now - lastAgentActiveAt`. We bump this forward whenever the agent
   * has any active run, leaving it alone when idle — so it tracks the
   * "last not-idle" moment.
   */
  private lastAgentActiveAt: number = Date.now();

  constructor(deps: OrchestratorDeps) {
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.digestChatId = deps.digestChatId;
    this.digestTopicId = deps.digestTopicId;
    this.config = deps.config;
    this.memory = deps.memory;
    this.agent = deps.agent;
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

      // --- Phase 3c: Atlas embedding queue ---
      try {
        const embedded = await this.phaseEmbedding();
        if (embedded > 0) {
          log.info("Atlas embedding queue processed", { embedded });
        }
      } catch (err) {
        log.error("Atlas embedding queue failed", { error: String(err) });
      }

      // --- Phase 3d: Atlas entity extraction queue ---
      try {
        const extracted = await this.phaseEntityExtraction();
        if (extracted > 0) {
          log.info("Atlas entity extraction processed", { items: extracted });
        }
      } catch (err) {
        log.error("Atlas entity extraction failed", { error: String(err) });
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
      // Surface items from this tick's intake
      if (result.triagedCount > 0 || result.topItems.length > 0) {
        await this.phaseSurfacing(result);
      }

      // Also surface previously triaged but never-surfaced items
      await this.surfaceBacklog();

      // --- Phase 5: Execute queued research (silent — saves to NotePlan only) ---
      const researchCompletions = await this.executeQueuedResearch();

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

      this.writeTickDailyLog(result, researchCompletions);
    } catch (err) {
      log.error("Heartbeat orchestrator error", { error: String(err) });
    }

    // Check due reminders (runs even if pipeline fails)
    try {
      await this.checkDueReminders();
    } catch (err) {
      log.error("Due reminders check failed", { error: String(err) });
    }

    // --- Phase 6: Skill curator ---
    // Best-effort. `shouldRunNow()` gates on enabled + interval; the
    // min-idle-hours gate is applied here using `lastAgentActiveAt`. The
    // curator itself is a long-running LLM pass — fire-and-forget so the
    // heartbeat tick stays bounded. The curator's own state file prevents
    // a second concurrent run on the next tick.
    if (this.agent) {
      // Refresh "last active" if anything is currently running.
      if (this.agent.activeRunCount > 0) {
        this.lastAgentActiveAt = Date.now();
      }
      const idleForSeconds = (Date.now() - this.lastAgentActiveAt) / 1000;
      void maybeRunCurator(this.agent, {
        idleForSeconds,
        onSummary: (s) => log.info(s),
        onExportCandidates: (names) => this.notifyExportCandidates(names),
      }).catch((err) => log.warn("Curator tick failed", { error: String(err) }));
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

    // --- Phase 2: Signal Scoring + Autonomy ---
    for (const item of triaged) {
      // Score using triage output (priority + value_type)
      const signalResult = scoreSignals(item);

      // Check learned autonomy rules using compound key
      let autoDecision: string | null = signalResult.autoAction;
      if (!autoDecision) {
        const compoundRule = checkAutonomyRule("compound", signalResult.compoundKey);
        if (compoundRule) {
          autoDecision = compoundRule.action;
          log.info("Autonomy auto-decision", {
            itemId: item.id,
            action: compoundRule.action,
            level: compoundRule.level,
            signal: signalResult.compoundKey,
          });
        }
      }

      updatePendingItem(item.id, {
        signal_score: signalResult.score,
        ...(autoDecision ? { auto_decision: autoDecision } : {}),
      });
    }

    // Build top items list sorted by triage priority and score
    const enrichedTriaged = getPendingItems("triaged", 50);
    const topItems = enrichedTriaged
      .filter((item) => item.priority !== null && item.priority <= 2)
      .sort((a, b) => (b.signal_score ?? 0) - (a.signal_score ?? 0) || (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 5);

    // Collect items with auto-actions that need execution
    const autoResearchItems = enrichedTriaged.filter(
      (item) => item.auto_decision === "deep_research_queued" || item.auto_decision === "quick_research_queued"
    );

    return {
      pendingProcessed: processed,
      triagedCount: triageResult.totalProcessed - triageResult.dropped,
      droppedCount: triageResult.dropped,
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

    // Mark freshly-surfaced items so they don't appear in backlog surfacing
    const surfacedIds = result.topItems.map((i) => i.id);
    if (surfacedIds.length > 0) {
      markItemsSurfaced(surfacedIds);
    }
  }

  // --- Surface backlog: triaged items that were never sent to the user ---
  private async surfaceBacklog(): Promise<void> {
    const unsurfaced = getUnsurfacedTriagedItems(5);
    if (unsurfaced.length === 0) return;

    const bot = this.getBot();
    if (!bot) return;

    const targetChatIds: (string | number)[] = this.digestChatId
      ? [this.digestChatId]
      : this.defaultChatIds;
    const topicOpts = this.digestChatId && this.digestTopicId
      ? { message_thread_id: this.digestTopicId }
      : {};

    if (targetChatIds.length === 0) return;

    // Skip if digest topic is muted
    if (this.digestChatId && isTopicMuted(this.digestChatId, this.digestTopicId ?? null)) {
      log.info("Backlog surfacing skipped (topic muted)");
      return;
    }

    const totalUnsurfaced = unsurfaced.length;
    log.info("Surfacing backlog items", { count: totalUnsurfaced });

    const surfacedIds: number[] = [];

    for (const chatId of targetChatIds) {
      for (const item of unsurfaced) {
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
            `<b>${badge}</b>${item.priority ? ` (P${item.priority})` : ""} ${link}`,
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
          surfacedIds.push(item.id);
        } catch (err) {
          log.error("Failed to send backlog item", { chatId, itemId: item.id, error: String(err) });
        }
      }
    }

    if (surfacedIds.length > 0) {
      markItemsSurfaced(surfacedIds);
      log.info("Marked items as surfaced", { count: surfacedIds.length });
    }
  }

  // --- Phase 5: Execute queued research (triggered by Telegram buttons or NotePlan tags) ---
  private async executeQueuedResearch(): Promise<ResearchCompletionRecord[]> {
    const queued = getQueuedResearchItems(3);
    if (queued.length === 0) return [];

    log.info("Executing queued research", { count: queued.length });

    const completions: ResearchCompletionRecord[] = [];

    for (const item of queued) {
      const isDeep = item.auto_decision === "deep_research_queued";
      const label: "Quick" | "Deep" = isDeep ? "Deep" : "Quick";

      try {
        updatePendingItem(item.id, { auto_decision: isDeep ? "deep_research_running" : "quick_research_running" });

        log.info(`${label} research starting`, { itemId: item.id, url: item.url });
        const result = isDeep
          ? await deepResearch(item)
          : await preliminaryResearch(item);

        const notePath = createResearchNote(item, result);

        const updates: Record<string, string | null> = {
          status: "archived",
          auto_decision: isDeep ? "deep_research_done" : "quick_research_done",
          quick_scan_summary: result.summary,
        };
        if (notePath) {
          updates.noteplan_path = notePath;
        } else {
          log.error(`${label} research note creation failed — research content may be lost`, {
            itemId: item.id,
            title: result.title,
            url: item.url,
          });
        }
        updatePendingItem(item.id, updates as Parameters<typeof updatePendingItem>[1]);

        log.info(`${label} research complete`, { itemId: item.id, title: result.title, noteSaved: !!notePath });

        const completion: ResearchCompletionRecord = {
          itemId: item.id,
          title: result.title,
          label,
          notePath,
          summary: result.summary,
          url: item.url ?? null,
        };
        completions.push(completion);

        // Notify the digest topic that research finished (was previously
        // silent — this is why the pipeline felt like a black hole).
        await this.notifyResearchComplete(completion);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${label} research failed`, { itemId: item.id, error: message });
        updatePendingItem(item.id, { auto_decision: isDeep ? "deep_research_failed" : "quick_research_failed" });
      }
    }

    return completions;
  }

  // --- Research-complete notification (1 message per completed item) ---
  // Sends a short HTML line to the digest topic with the note path, following
  // the exact send pattern used by phaseSurfacing (thread_id + DM fallback).
  // Quiet hours are already gated at the tick() level; the topic-mute check
  // mirrors surfaceBacklog so a muted News topic stays quiet.
  private async notifyResearchComplete(c: ResearchCompletionRecord): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;

    const targetChatIds: (string | number)[] = this.digestChatId
      ? [this.digestChatId]
      : this.defaultChatIds;
    const topicOpts = this.digestChatId && this.digestTopicId
      ? { message_thread_id: this.digestTopicId }
      : {};

    if (targetChatIds.length === 0) return;

    // Respect a muted digest topic (same guard as surfaceBacklog).
    if (this.digestChatId && isTopicMuted(this.digestChatId, this.digestTopicId ?? null)) {
      return;
    }

    const title = escapeHtml(c.title || "Untitled");
    const summary = c.summary ? escapeHtml(truncate(c.summary, 200)) : "";
    const lines = [
      `🔬 Research done: <b>${title}</b>${summary ? ` — ${summary}` : ""}`,
    ];
    if (c.notePath) {
      lines.push(`<code>${escapeHtml(c.notePath)}</code>`);
    }
    const reviewLink = tmaLink("review");
    if (reviewLink) {
      lines.push(`<a href="${escapeHtml(reviewLink)}">Open review queue</a>`);
    }
    const msg = lines.join("\n");

    for (const chatId of targetChatIds) {
      try {
        await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", ...topicOpts });
      } catch (err) {
        log.error("Failed to send research-complete notification", {
          chatId,
          itemId: c.itemId,
          error: String(err),
        });
      }
    }
  }

  // --- Skill export-candidate nudge (curator Phase C) ---
  // The curator only *computes* which candidates are new (export.ts, backed
  // by the usage.ts nudge sidecar for dedupe); sending is done here because
  // this is where bot/chat-id access already lives (same pattern as
  // notifyResearchComplete). Approve/Skip are handled by the "sxa"/"sxs"
  // callback cases in telegram/keyboards.ts.
  private async notifyExportCandidates(names: string[]): Promise<void> {
    if (names.length === 0) return;
    const bot = this.getBot();
    if (!bot) return;

    const targetChatIds: (string | number)[] = this.digestChatId
      ? [this.digestChatId]
      : this.defaultChatIds;
    const topicOpts = this.digestChatId && this.digestTopicId
      ? { message_thread_id: this.digestTopicId }
      : {};
    if (targetChatIds.length === 0) return;

    if (this.digestChatId && isTopicMuted(this.digestChatId, this.digestTopicId ?? null)) {
      return;
    }

    const skillsLink = tmaLink("skills");

    for (const name of names) {
      const id = exportNudgeId(name);
      const lines = [
        `🧩 Skill export candidate: <b>${escapeHtml(name)}</b>`,
        `Meets the quality bar for export to ~/.claude/skills.`,
      ];
      if (skillsLink) {
        lines.push(`<a href="${escapeHtml(skillsLink)}">Review skills</a>`);
      }
      const msg = lines.join("\n");
      const kb = new InlineKeyboard().text("Approve", `sxa:${id}`).text("Skip", `sxs:${id}`);

      let sent = false;
      for (const chatId of targetChatIds) {
        try {
          await bot.api.sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: kb, ...topicOpts });
          sent = true;
        } catch (err) {
          log.error("Failed to send export-candidate nudge", { chatId, name, error: String(err) });
        }
      }
      // Only mark nudged once actually delivered somewhere — a fully-failed
      // send should be retried next tick rather than silently suppressed.
      if (sent) markExportNudged(name);
    }
  }

  // --- Phase 3c: Embed unembedded atlas_items via Gemini + sqlite-vec ---
  private async phaseEmbedding(): Promise<number> {
    const db = getDb();
    const BATCH = 20;
    const BODY_CAP = 2000;
    const rows = db
      .prepare<{ id: number; title: string; body: string }, [number]>(
        `SELECT id, title, body
         FROM atlas_items
         WHERE embedded_at IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(BATCH);

    if (rows.length === 0) return 0;

    const texts = rows.map((r) => {
      const title = (r.title ?? "").trim();
      const body = (r.body ?? "").slice(0, BODY_CAP).trim();
      return title && body ? `${title}\n\n${body}` : title || body || " ";
    });

    const vectors = await embedBatch(texts);

    const insert = db.prepare(
      "INSERT OR REPLACE INTO atlas_items_vec (rowid, embedding) VALUES (?, ?)",
    );
    const markEmbedded = db.prepare(
      "UPDATE atlas_items SET embedded_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    );

    let count = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const vec = vectors[i];
      try {
        insert.run(row.id, vec);
        markEmbedded.run(row.id);
        count++;
      } catch (err) {
        log.error("Failed to insert atlas vector", {
          id: row.id,
          error: String(err),
        });
      }
    }
    return count;
  }

  // --- Phase 3d: Extract entities from unprocessed atlas items ---
  private async phaseEntityExtraction(): Promise<number> {
    const db = getDb();
    const BATCH = 30;
    const rows = db
      .prepare<AtlasItem, [number]>(
        `SELECT *
         FROM atlas_items
         WHERE entity_extracted_at IS NULL
           AND length(body) + length(title) >= 50
         ORDER BY captured_at DESC
         LIMIT ?`,
      )
      .all(BATCH);

    if (rows.length === 0) return 0;

    let processed = 0;
    for (const item of rows) {
      try {
        const n = await indexItemEntities(item);
        processed++;
        log.info("Extracted entities", { itemId: item.id, kind: item.kind, count: n });
      } catch (err) {
        log.error("Per-item entity extraction failed", {
          itemId: item.id,
          error: String(err),
        });
        db.prepare(
          "UPDATE atlas_items SET entity_extracted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
        ).run(item.id);
      }
    }
    return processed;
  }

  private writeTickDailyLog(result: TickResult, completions: ResearchCompletionRecord[]): void {
    // Skip logging when nothing happened — avoids spamming daily log with zero-count entries
    const totalActivity = result.pendingProcessed + result.triagedCount + completions.length;
    if (totalActivity === 0) return;

    const parts: string[] = [];
    if (result.pendingProcessed > 0) parts.push(`${result.pendingProcessed} intake`);
    if (result.triagedCount > 0) parts.push(`${result.triagedCount} triaged`);
    if (result.droppedCount > 0) parts.push(`${result.droppedCount} dropped`);
    if (result.topItems.length > 0) parts.push(`${result.topItems.length} surfaced`);
    if (result.autoResearchItems.length > 0) parts.push(`${result.autoResearchItems.length} queued for research`);
    if (completions.length > 0) {
      const titles = completions.map((c) => c.title).slice(0, 3).join(", ");
      parts.push(`${completions.length} researched (${titles})`);
    }

    const line = `- ${hhmm()} heartbeat: ${parts.join(", ")}`;
    try {
      this.memory.appendDailyLog(line);
    } catch (err) {
      log.error("Failed to append heartbeat daily log", { error: String(err) });
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
    // getDueReminders() filters out rows that have already reached
    // max_reminds (correct — they should never be sent again), which means
    // this loop can never see an over-cap row itself. Sweep those separately
    // so they actually get dismissed instead of sitting inert forever.
    const dismissedCount = dismissOverCapReminders();
    if (dismissedCount > 0) {
      log.info("Auto-dismissed reminders at max reminds", { count: dismissedCount });
    }

    const bot = this.getBot();
    if (!bot || this.defaultChatIds.length === 0) return;

    const dueReminders = getDueReminders();
    if (dueReminders.length === 0) return;

    log.info("Processing due reminders", { count: dueReminders.length });

    for (const reminder of dueReminders) {
      // Research reminders are silently completed — no Telegram notification
      if (reminder.type === "research") {
        completeReminder(reminder.id);
        log.info("Auto-completed research reminder (no Telegram notification)", { id: reminder.id, title: reminder.title });
        continue;
      }

      const keyboard = briefingActionKeyboard(reminder.id);

      const desc = reminder.description && reminder.description.length > 200
        ? reminder.description.slice(0, 200) + "..."
        : reminder.description;
      const messageText = `${reminder.type.toUpperCase()}: ${reminder.title}${desc ? "\n" + desc : ""}`;

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

      // Auto-snooze based on urgency tier (time until due_date)
      // 3+ days out: 4h, 1-2 days: 2h, due today/overdue: 1h, no due_date: 4h
      const snoozeMs = getUrgencySnoozeMs(reminder.due_date, reminder.priority);
      snoozeReminder(reminder.id, snoozeMs);
      log.info("Auto-snoozed reminder after send", {
        id: reminder.id,
        title: reminder.title,
        due_date: reminder.due_date,
        snoozeHours: Math.round(snoozeMs / 3600000),
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
