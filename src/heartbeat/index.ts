import { Cron } from "croner";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
  getFleetState,
  setFleetState,
} from "../db/queries.ts";
import { getConfig } from "../config.ts";
import { getUrgencySnoozeMs } from "../shared/reminder-snooze.ts";
import { triageAllPending } from "../triage/index.ts";
import { preliminaryResearch, deepResearch, createResearchNote } from "../research/index.ts";
import { scoreSignals } from "./signals.ts";
import { scanInbox } from "./inbox-watcher.ts";
import { detectThemes } from "./themes.ts";
import { InlineKeyboard } from "grammy";
import { briefingActionKeyboard, fleetProposalKeyboard } from "../telegram/keyboards.ts";
import { ChatState } from "../telegram/state.ts";
import type { Bot } from "grammy";
import type { PendingItem } from "../shared/types.ts";
import { isInboxSurfaceable } from "../shared/surface-policy.ts";
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
import {
  readAlertedEventBatchSince,
  readLatestSnapshot,
  readPendingFleetProposals,
  type FleetEvent,
  type FleetProposal,
  type FleetSnapshot,
} from "./fleet-reader.ts";

const log = createLogger("heartbeat");
const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");
const HUB_DOCTOR_CLEANUP_TIMEOUT_MS = 1_000;
const HUB_KICKSTART_TIMEOUT_MS = 5_000;
const PROCESS_REAP_TIMEOUT_MS = 1_000;
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

class OperationTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new OperationTimeoutError(`${operation} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T, operation: string): Promise<T> {
  try {
    return await withTimeout(promise, timeoutMs, operation);
  } catch {
    return fallback;
  }
}

function fleetCallbackData(action: "fr" | "fs", entity: string): string | undefined {
  const callbackData = `${action}:${entity}`;
  return Buffer.byteLength(callbackData, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES
    ? callbackData
    : undefined;
}

function keyboardForEvent(event: Pick<FleetEvent, "entity" | "verbs">): InlineKeyboard | undefined {
  const keyboard = new InlineKeyboard();
  let hasButtons = false;
  for (const verb of event.verbs) {
    if (verb === "restart") {
      const callbackData = fleetCallbackData("fr", event.entity);
      if (callbackData !== undefined) {
        keyboard.text("🔄 Restart", callbackData);
        hasButtons = true;
      }
    } else if (verb === "silence") {
      const callbackData = fleetCallbackData("fs", event.entity);
      if (callbackData !== undefined) {
        keyboard.text("🔕 Silence", callbackData);
        hasButtons = true;
      }
    }
  }
  return hasButtons ? keyboard : undefined;
}

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
  fleetPreludeIntervalMinutes: number;
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
  now?: () => number;
  state?: ChatState;
  /** Test seam; production opens fleet.db read-only for every proposal pass. */
  readPendingFleetProposals?: (nowMs?: number) => FleetProposal[];
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

/**
 * Render only the Fleet facts that E2 can state honestly from its cached
 * read-only snapshot. A missing snapshot remains invisible to the digest.
 */
export function buildFleetDigestLines(snapshot: FleetSnapshot | null): string[] {
  if (snapshot === null) return [];

  const notUp = snapshot.entities.filter((entity) => entity.alertState !== "up");
  const total = snapshot.entities.length;
  const fleetLine = notUp.length === 0
    ? `Fleet: ${total}/${total} up`
    : `Fleet: ${notUp.length} of ${total} not up (${notUp.map((entity) => escapeHtml(entity.id)).join(", ")})`;
  const lines = [fleetLine];

  if (snapshot.approvals.pending > 0) {
    lines.push(`Approvals pending: ${snapshot.approvals.pending}`);
  }

  // Pool/quota is intentionally not rendered here: E2-T05 does not own that
  // surface, and an absent or future value must not become a guessed claim.
  return lines;
}

export function buildFleetProposalCard(proposal: FleetProposal): string {
  return [
    "🗳 <b>Fleet proposal</b>",
    `<b>Entity:</b> <code>${escapeHtml(proposal.entity)}</code>`,
    `<b>Action:</b> <code>${escapeHtml(proposal.verb)}</code>`,
    `<b>Why:</b> ${escapeHtml(proposal.rationale)}`,
    `<b>ID:</b> <code>${escapeHtml(proposal.id)}</code>`,
  ].join("\n");
}

export class HeartbeatRunner {
  private cron: Cron | null = null;
  private fleetPreludeCron: Cron | null = null;
  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private digestChatId?: string;
  private digestTopicId?: number;
  private config: OrchestratorConfig;
  private running = false;
  private statePath: string;
  private memory: MemorySystem;
  private agent?: AgentService;
  private now: () => number;
  private telegramState: ChatState;
  private readPendingProposals: (nowMs?: number) => FleetProposal[];
  private lastFleetPreludeSlot: number | null = null;
  private fleetStaleStreak = 0;
  private hubDeathAlerted = false;
  private sourceLostAlerted = false;
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
    this.now = deps.now ?? (() => Date.now());
    this.telegramState = deps.state ?? new ChatState();
    this.readPendingProposals = deps.readPendingFleetProposals ?? readPendingFleetProposals;
    this.statePath = join(KNOWLEDGE_DIR, "orchestrator-state.json");
  }

  start(): void {
    const pattern = `*/${this.config.intervalMinutes} * * * *`;
    const fleetPreludePattern = `*/${this.config.fleetPreludeIntervalMinutes} * * * *`;
    log.info("Starting heartbeat orchestrator", { pattern, fleetPreludePattern, config: this.config });

    this.cron = new Cron(pattern, () => {
      this.tick().catch((err) => {
        log.error("Heartbeat tick failed", { error: String(err) });
      });
    });

    this.fleetPreludeCron = new Cron(fleetPreludePattern, () => {
      this.fleetPreludeTick().catch((err) => {
        log.error("Fleet prelude tick failed", { error: String(err) });
      });
    });
  }

  stop(): void {
    let stopped = false;
    if (this.cron) {
      this.cron.stop();
      this.cron = null;
      stopped = true;
    }
    if (this.fleetPreludeCron) {
      this.fleetPreludeCron.stop();
      this.fleetPreludeCron = null;
      stopped = true;
    }
    if (stopped) {
      log.info("Heartbeat orchestrator stopped");
    }
  }

  private async fleetPreludeTick(): Promise<void> {
    if (this.running) {
      log.info("Fleet prelude skipped (heartbeat already running)");
      return;
    }

    this.running = true;
    try {
      await this.runFleetPrelude();
    } finally {
      this.running = false;
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

    this.running = true;
    try {
      await this.runFleetPrelude();

      if (this.isQuietHours()) {
        log.info("Heartbeat skipped (quiet hours)");
        return;
      }

      const state = this.readState();

      // --- Phase 1: Intake ---
      try {
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

    } finally {
      this.running = false;
    }
  }

  private async runFleetPrelude(): Promise<void> {
    // E2 §5.1 keeps this prelude in the regular tick; ADR-0042 also gives it
    // a dedicated schedule. Collapse both callback paths into one cadence slot.
    const slotMs = this.config.fleetPreludeIntervalMinutes * 60_000;
    const slot = Math.floor(this.now() / slotMs);
    if (this.lastFleetPreludeSlot === slot) {
      log.info("Fleet prelude skipped (cadence slot already processed)", { slot });
      return;
    }
    this.lastFleetPreludeSlot = slot;

    try {
      await this.phaseFleetAlerts();
    } catch (err) {
      log.error("Fleet alerts phase failed", { error: String(err) });
    }

    try {
      await this.phaseFleetProposals();
    } catch (err) {
      log.error("Fleet proposals phase failed", { error: String(err) });
    }

    try {
      await this.phaseFleetStaleness();
    } catch (err) {
      log.error("Fleet staleness phase failed", { error: String(err) });
    }
  }

  private async phaseFleetProposals(): Promise<void> {
    const proposals = this.readPendingProposals(this.now());
    const unseen = proposals.filter(({ id }) => !this.telegramState.renderedFleetProposalIds.has(id));
    if (unseen.length === 0) return;

    const destination: string | number | undefined = this.digestChatId
      ?? this.defaultChatIds[0];
    if (destination === undefined) {
      log.warn("Fleet proposals pending but no destination chats configured");
      return;
    }
    const bot = this.getBot();
    if (!bot) {
      log.warn("Fleet proposals pending but bot unavailable");
      return;
    }

    for (const proposal of unseen) {
      let keyboard: InlineKeyboard;
      try {
        keyboard = fleetProposalKeyboard(proposal.id);
      } catch (error) {
        log.warn("Skipping fleet proposal with unsafe callback id", {
          proposalId: proposal.id,
          error: String(error),
        });
        continue;
      }

      try {
        await bot.api.sendMessage(destination, buildFleetProposalCard(proposal), {
          parse_mode: "HTML",
          reply_markup: keyboard,
          ...(this.digestTopicId ? { message_thread_id: this.digestTopicId } : {}),
        });
        this.telegramState.renderedFleetProposalIds.add(proposal.id);
      } catch (error) {
        log.error("Failed to send fleet proposal", {
          chatId: destination,
          proposalId: proposal.id,
          error: String(error),
        });
      }
    }
  }

  private async phaseFleetAlerts(): Promise<void> {
    const watermarkStr = getFleetState("fleet_event_watermark");
    const parsedWatermark = watermarkStr === null ? 0 : Number(watermarkStr);
    const watermark = Number.isSafeInteger(parsedWatermark) && parsedWatermark >= 0
      ? parsedWatermark
      : 0;
    if (watermarkStr !== null && watermark === 0 && parsedWatermark !== 0) {
      log.warn("Invalid fleet event watermark; using 0", { watermark: watermarkStr });
    }
    const batch = readAlertedEventBatchSince(watermark, 50);
    const { events } = batch;
    if (events.length === 0) {
      if (batch.maxScannedId > watermark) {
        setFleetState("fleet_event_watermark", String(batch.maxScannedId));
      }
      return;
    }

    if (this.defaultChatIds.length === 0) {
      log.warn("Fleet alerts pending but no destination chats configured");
      return;
    }

    const bot = this.getBot();
    if (!bot) {
      log.warn("Fleet alerts pending but bot unavailable");
      return;
    }

    for (const event of events) {
      const entity = escapeHtml(event.entity);
      const detail = escapeHtml(event.detail);
      let message: string;

      if (event.kind === "transition" && event.toState === "down") {
        message = `🔴 <b>${entity}</b> DOWN — ${detail}`;
      } else if (event.kind === "transition" && event.fromState === "down" && event.toState === "up") {
        message = `✅ <b>${entity}</b> recovered — ${detail}`;
      } else if (event.kind === "transition" && event.toState === "flapping") {
        message = `⚠️ <b>${entity}</b> flapping — ${detail}`;
      } else {
        message = `ℹ️ <b>${entity}</b> ${escapeHtml(event.kind)}: ${detail}`;
      }
      const keyboard = keyboardForEvent(event);

      for (const chatId of this.defaultChatIds) {
        try {
          await bot.api.sendMessage(chatId, message, {
            parse_mode: "HTML",
            ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
          });
        } catch (err) {
          log.error("Failed to send fleet alert", { chatId, eventId: event.id, error: String(err) });
        }
      }
    }

    setFleetState("fleet_event_watermark", String(batch.maxScannedId));
  }

  private async phaseFleetStaleness(): Promise<void> {
    const config = getConfig();
    const everSeen = getFleetState("fleet_snapshot_last_seen_ms") !== null;
    const snapshot = readLatestSnapshot();

    if (snapshot === null) {
      this.fleetStaleStreak = 0;
      if (!everSeen) return;

      if (!this.sourceLostAlerted) {
        await this.sendFleetStatusAlert(
          "⚠️ hub-core fleet.db unreadable — previously-seen snapshot source is now missing/corrupt",
          "source-lost",
        );
        this.sourceLostAlerted = true;
      }
      return;
    }

    setFleetState("fleet_snapshot_last_seen_ms", String(snapshot.generatedAtMs));

    const pollIntervalMs = snapshot.pollIntervalMs || config.FLEET_POLL_MS_FALLBACK;
    const ageMs = Date.now() - snapshot.generatedAtMs;
    const threshold = config.FLEET_STALE_FACTOR * pollIntervalMs;

    if (ageMs <= threshold) {
      if (this.hubDeathAlerted) {
        await this.sendFleetStatusAlert("✅ hub-core snapshot fresh again", "recovery");
      }
      this.hubDeathAlerted = false;
      this.sourceLostAlerted = false;
      this.fleetStaleStreak = 0;
      return;
    }

    this.fleetStaleStreak++;
    if (this.fleetStaleStreak < config.FLEET_STALE_CONSECUTIVE) return;
    if (this.hubDeathAlerted) return;

    const hubAlive = await this.confirmHubDoctor(config.FLEET_HUB_DOCTOR_TIMEOUT_MS);
    if (hubAlive) {
      log.warn("Fleet snapshot stale but hub_doctor succeeded", { ageMs, threshold });
      this.fleetStaleStreak = 0;
      return;
    }

    const kickstart = await this.kickstartHubCore();
    const kickstartStatus = kickstart?.exitCode === 0
      ? "✓"
      : kickstart
        ? `(exit ${kickstart.exitCode})`
        : "(failed to start)";
    await this.sendFleetStatusAlert(
      `🔴 hub-core silent for ~${Math.round(ageMs / 1000)}s (confirmed via failed hub_doctor ping). Ran: launchctl kickstart -k com.dmac.hub-core ${kickstartStatus}`,
      "confirmed-death",
    );
    this.hubDeathAlerted = true;
  }

  private async confirmHubDoctor(timeoutMs: number): Promise<boolean> {
    const config = getConfig();
    const hubEdgeBin = config.HUB_EDGE_BIN.startsWith("~")
      ? join(homedir(), config.HUB_EDGE_BIN.slice(1))
      : config.HUB_EDGE_BIN;
    let client: Client | null = null;
    let transport: StdioClientTransport | null = null;

    try {
      const stdioTransport = new StdioClientTransport({
        command: hubEdgeBin,
        args: ["--client", "other"],
      });
      transport = stdioTransport;
      const doctorClient = new Client({ name: "psibot-fleet-staleness", version: "0.1.0" });
      client = doctorClient;

      const doctor = (async (): Promise<void> => {
        await doctorClient.connect(stdioTransport);
        await doctorClient.callTool({ name: "hub_doctor", arguments: {} });
      })();
      await withTimeout(doctor, timeoutMs, "hub_doctor");
      return true;
    } catch (err) {
      log.warn("hub_doctor confirm failed", { error: String(err) });
      return false;
    } finally {
      const transportPid = transport?.pid ?? null;
      const cleanup = client?.close() ?? transport?.close();
      if (cleanup) {
        try {
          await withTimeout(cleanup, HUB_DOCTOR_CLEANUP_TIMEOUT_MS, "hub_doctor cleanup");
        } catch (err) {
          log.warn("hub_doctor cleanup exceeded bound", { pid: transportPid, error: String(err) });
          if (transportPid !== null) {
            try {
              process.kill(transportPid, "SIGKILL");
            } catch (killError) {
              log.debug("hub_doctor SIGKILL fallback failed", {
                pid: transportPid,
                error: String(killError),
              });
            }
          }
        }
      }
    }
  }

  private async kickstartHubCore(
    timeoutMs = HUB_KICKSTART_TIMEOUT_MS,
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
    try {
      const proc = Bun.spawn(["launchctl", "kickstart", "-k", "com.dmac.hub-core"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdoutPromise = new Response(proc.stdout).text();
      const stderrPromise = new Response(proc.stderr).text();
      const completion = Promise.all([proc.exited, stdoutPromise, stderrPromise]);

      try {
        const [exitCode, stdout, stderr] = await withTimeout(completion, timeoutMs, "hub-core kickstart");
        log.info("hub-core kickstart attempted", { exitCode, stdout, stderr });
        return { exitCode, stdout, stderr };
      } catch (err) {
        if (proc.exitCode === null) {
          try {
            proc.kill("SIGKILL");
          } catch (killError) {
            log.error("hub-core kickstart SIGKILL failed", { error: String(killError) });
          }
        }

        const [exitCode, stdout, stderr] = await Promise.all([
          settleWithin(proc.exited, PROCESS_REAP_TIMEOUT_MS, proc.exitCode ?? 124, "kickstart reap"),
          settleWithin(stdoutPromise, PROCESS_REAP_TIMEOUT_MS, "", "kickstart stdout drain"),
          settleWithin(stderrPromise, PROCESS_REAP_TIMEOUT_MS, "", "kickstart stderr drain"),
        ]);
        log.error("hub-core kickstart failed or timed out", {
          exitCode,
          stdout,
          stderr,
          error: String(err),
        });
        return { exitCode, stdout, stderr };
      }
    } catch (err) {
      log.error("hub-core kickstart failed", { error: String(err) });
      return null;
    }
  }

  private async sendFleetStatusAlert(message: string, kind: string): Promise<void> {
    const bot = this.getBot();
    if (!bot) {
      log.warn("Fleet status alert pending but bot unavailable", { kind });
      return;
    }

    for (const chatId of this.defaultChatIds) {
      try {
        await bot.api.sendMessage(chatId, message, { parse_mode: "HTML" });
      } catch (err) {
        log.error("Failed to send fleet status alert", { chatId, kind, error: String(err) });
      }
    }
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
      // Discover-only sources (e.g. YouTube) are browsed in the Mini App, never
      // pushed to the channel. Single gate — see shared/surface-policy.ts.
      .filter(isInboxSurfaceable)
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

    headerLines.push(...buildFleetDigestLines(readLatestSnapshot()));

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
        if (!isInboxSurfaceable(item)) continue; // never post Discover-only sources
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
        if (!isInboxSurfaceable(item)) continue; // never post Discover-only sources
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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "...";
}
