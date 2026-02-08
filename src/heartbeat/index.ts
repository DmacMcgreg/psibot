import { Cron } from "croner";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { createLogger } from "../shared/logger.ts";
import type { Bot } from "grammy";

const log = createLogger("heartbeat");

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

interface HeartbeatState {
  lastRunAt: string | null;
  lastRunCostUsd: number;
  runCount: number;
}

interface HeartbeatConfig {
  intervalMinutes: number;
  quietStart: number;
  quietEnd: number;
  maxBudgetUsd: number;
}

interface HeartbeatDeps {
  agent: AgentService;
  memory: MemorySystem;
  getBot: () => Bot | null;
  defaultChatIds: number[];
  config: HeartbeatConfig;
}

export class HeartbeatRunner {
  private cron: Cron | null = null;
  private agent: AgentService;
  private memory: MemorySystem;
  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private config: HeartbeatConfig;
  private running = false;
  private statePath: string;

  constructor(deps: HeartbeatDeps) {
    this.agent = deps.agent;
    this.memory = deps.memory;
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.config = deps.config;
    this.statePath = join(KNOWLEDGE_DIR, "heartbeat-state.json");
  }

  start(): void {
    const pattern = `*/${this.config.intervalMinutes} * * * *`;
    log.info("Starting heartbeat", { pattern, config: this.config });

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
      log.info("Heartbeat stopped");
    }
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    const { quietStart, quietEnd } = this.config;

    if (quietStart > quietEnd) {
      // Quiet period spans midnight (e.g., 23:00 - 08:00)
      return hour >= quietStart || hour < quietEnd;
    }
    // Quiet period within same day
    return hour >= quietStart && hour < quietEnd;
  }

  private readState(): HeartbeatState {
    try {
      if (existsSync(this.statePath)) {
        return JSON.parse(readFileSync(this.statePath, "utf-8")) as HeartbeatState;
      }
    } catch {
      // Fall through to default
    }
    return { lastRunAt: null, lastRunCostUsd: 0, runCount: 0 };
  }

  private writeState(state: HeartbeatState): void {
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
      // Load heartbeat task definitions
      const heartbeatTasks = this.memory.readKnowledgeFileOptional("HEARTBEAT.md") ?? "No heartbeat tasks defined.";

      // Build a summary of recent state
      const lastRunInfo = state.lastRunAt
        ? `Last heartbeat: ${state.lastRunAt} (total runs: ${state.runCount})`
        : "This is the first heartbeat run.";

      const prompt = `You are running as a heartbeat task - a periodic maintenance and monitoring routine.

${lastRunInfo}

## Heartbeat Tasks

${heartbeatTasks}

## Instructions

1. Review each heartbeat task above and perform what is relevant.
2. Be efficient - don't spend tokens on tasks that don't need attention right now.
3. If you discover something the user should know about, include [NOTIFY] at the start of that finding.
4. Update the daily log with a brief summary of what you did.
5. Keep total cost under $${this.config.maxBudgetUsd}.`;

      log.info("Running heartbeat agent");

      const result = await this.agent.run({
        prompt,
        source: "heartbeat",
        maxBudgetUsd: this.config.maxBudgetUsd,
        useBrowser: false,
      });

      // Update state
      const newState: HeartbeatState = {
        lastRunAt: new Date().toISOString(),
        lastRunCostUsd: result.costUsd,
        runCount: state.runCount + 1,
      };
      this.writeState(newState);

      log.info("Heartbeat completed", {
        cost: result.costUsd,
        durationMs: result.durationMs,
        runCount: newState.runCount,
      });

      // Send Telegram notification if result contains [NOTIFY]
      if (result.result.includes("[NOTIFY]")) {
        await this.sendNotification(result.result);
      }
    } catch (err) {
      log.error("Heartbeat agent error", { error: String(err) });
    } finally {
      this.running = false;
    }
  }

  private async sendNotification(text: string): Promise<void> {
    const bot = this.getBot();
    if (!bot || this.defaultChatIds.length === 0) return;

    // Extract lines containing [NOTIFY]
    const notifications = text
      .split("\n")
      .filter((line) => line.includes("[NOTIFY]"))
      .map((line) => line.replace("[NOTIFY]", "").trim())
      .join("\n");

    if (!notifications) return;

    const message = `Heartbeat notification:\n\n${notifications}`;

    for (const chatId of this.defaultChatIds) {
      try {
        await bot.api.sendMessage(chatId, message);
      } catch (err) {
        log.error("Failed to send heartbeat notification", {
          chatId,
          error: String(err),
        });
      }
    }
  }
}
