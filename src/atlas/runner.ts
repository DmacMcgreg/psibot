import { Cron } from "croner";
import type { Bot } from "grammy";
import { createLogger } from "../shared/logger.ts";
import type { MemorySystem } from "../memory/index.ts";
import {
  synthesizeDailyNarrative,
  synthesizeWeeklyThemes,
  synthesizeMonthly,
  type DailyNarrativeResult,
  type WeeklyThemesResult,
  type MonthlySynthResult,
} from "./synthesize.ts";
import { proposeAliases, type ProposeAliasesResult } from "./alias-producer.ts";

const log = createLogger("atlas:runner");

export interface SynthesisRunnerDeps {
  getBot: () => Bot | null;
  defaultChatIds: number[];
  memory: MemorySystem;
  /** Chat ID for News topic posts (weekly, daily footer). */
  newsChatId?: string;
  newsTopicId?: number;
  /** Chat ID for Trading topic posts (monthly scan synthesis). */
  tradingChatId?: string;
  tradingTopicId?: number;
  /** Cron schedules, overridable for tests. */
  dailyCron?: string;
  weeklyCron?: string;
  monthlyCron?: string;
  aliasCron?: string;
}

/** Periodic narrative synthesis: daily log, weekly themes, monthly scan map-reduce. */
export class SynthesisRunner {
  private dailyJob: Cron | null = null;
  private weeklyJob: Cron | null = null;
  private monthlyJob: Cron | null = null;
  private aliasJob: Cron | null = null;

  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private memory: MemorySystem;

  private newsChatId?: string;
  private newsTopicId?: number;
  private tradingChatId?: string;
  private tradingTopicId?: number;

  private dailyCron: string;
  private weeklyCron: string;
  private monthlyCron: string;
  private aliasCron: string;

  private dailyRunning = false;
  private weeklyRunning = false;
  private monthlyRunning = false;
  private aliasRunning = false;

  constructor(deps: SynthesisRunnerDeps) {
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.memory = deps.memory;
    this.newsChatId = deps.newsChatId;
    this.newsTopicId = deps.newsTopicId;
    this.tradingChatId = deps.tradingChatId;
    this.tradingTopicId = deps.tradingTopicId;
    this.dailyCron = deps.dailyCron ?? "15 23 * * *";
    this.weeklyCron = deps.weeklyCron ?? "0 20 * * 0";
    this.monthlyCron = deps.monthlyCron ?? "0 6 1 * *";
    this.aliasCron = deps.aliasCron ?? "0 21 * * 0";
  }

  start(): void {
    log.info("Starting synthesis runner", {
      daily: this.dailyCron,
      weekly: this.weeklyCron,
      monthly: this.monthlyCron,
      alias: this.aliasCron,
    });
    this.dailyJob = new Cron(this.dailyCron, () => {
      this.runDaily().catch((err) => log.error("Daily synthesis crashed", { error: String(err) }));
    });
    this.weeklyJob = new Cron(this.weeklyCron, () => {
      this.runWeekly().catch((err) => log.error("Weekly synthesis crashed", { error: String(err) }));
    });
    this.monthlyJob = new Cron(this.monthlyCron, () => {
      this.runMonthly().catch((err) => log.error("Monthly synthesis crashed", { error: String(err) }));
    });
    this.aliasJob = new Cron(this.aliasCron, () => {
      this.runAliases().catch((err) => log.error("Alias proposal crashed", { error: String(err) }));
    });
  }

  stop(): void {
    this.dailyJob?.stop();
    this.weeklyJob?.stop();
    this.monthlyJob?.stop();
    this.aliasJob?.stop();
    this.dailyJob = null;
    this.weeklyJob = null;
    this.monthlyJob = null;
    this.aliasJob = null;
    log.info("Synthesis runner stopped");
  }

  /** Kick off daily synthesis manually (used by admin commands and the scheduled cron). */
  async runDaily(): Promise<DailyNarrativeResult> {
    if (this.dailyRunning) {
      log.info("Daily synthesis skipped (already running)");
      return { date: "", text: "", written: false, itemCount: 0 };
    }
    this.dailyRunning = true;
    try {
      const result = await synthesizeDailyNarrative(this.memory);
      if (result.written) {
        await this.notifyDaily(result);
      } else {
        log.info("Daily synthesis produced no narrative (thin day)", { date: result.date });
      }
      return result;
    } finally {
      this.dailyRunning = false;
    }
  }

  async runWeekly(): Promise<WeeklyThemesResult> {
    if (this.weeklyRunning) {
      log.info("Weekly synthesis skipped (already running)");
      return { week: "", text: "", path: null, written: false };
    }
    this.weeklyRunning = true;
    try {
      const result = await synthesizeWeeklyThemes();
      if (result.written) {
        await this.notifyWeekly(result);
      } else {
        log.info("Weekly synthesis produced no themes", { week: result.week });
      }
      return result;
    } finally {
      this.weeklyRunning = false;
    }
  }

  async runMonthly(): Promise<MonthlySynthResult> {
    if (this.monthlyRunning) {
      log.info("Monthly synthesis skipped (already running)");
      return { mapped: 0, reduced: false, appendedTo: [] };
    }
    this.monthlyRunning = true;
    try {
      const result = await synthesizeMonthly();
      if (result.reduced) {
        await this.notifyMonthly(result);
      } else {
        log.info("Monthly synthesis produced no appends", { mapped: result.mapped });
      }
      return result;
    } finally {
      this.monthlyRunning = false;
    }
  }

  /** Weekly alias-proposal pass — deterministic string rules, surfaced for user approval. */
  async runAliases(): Promise<ProposeAliasesResult> {
    if (this.aliasRunning) {
      log.info("Alias proposal skipped (already running)");
      return { proposed: 0, skippedExistingAlias: 0, skippedExistingProposal: 0 };
    }
    this.aliasRunning = true;
    try {
      const result = proposeAliases();
      if (result.proposed > 0) {
        await this.notifyAliases(result);
      } else {
        log.info("Alias proposal produced no new candidates", {
          skippedExistingAlias: result.skippedExistingAlias,
          skippedExistingProposal: result.skippedExistingProposal,
        });
      }
      return result;
    } finally {
      this.aliasRunning = false;
    }
  }

  private async notifyDaily(result: DailyNarrativeResult): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;
    const firstLine = result.text.split(/\n+/).find((l) => l.trim().length > 0) ?? "";
    const preview = firstLine.length > 240 ? firstLine.slice(0, 237) + "..." : firstLine;
    const msg = [
      `<b>Daily narrative — ${escapeHtml(result.date)}</b>`,
      `Items considered: ${result.itemCount}`,
      "",
      escapeHtml(preview),
    ].join("\n");

    // Prefer News topic so the footer stays with the digest stream; fall back to DM.
    if (this.newsChatId) {
      await this.sendSafe(bot, this.newsChatId, msg, this.newsTopicId);
    } else {
      for (const chatId of this.defaultChatIds) {
        await this.sendSafe(bot, chatId, msg);
      }
    }
  }

  private async notifyWeekly(result: WeeklyThemesResult): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;
    const headings = extractTopHeadings(result.text, 3);
    const lines = [
      `<b>Weekly themes — ${escapeHtml(result.week)}</b>`,
      result.path ? `<code>${escapeHtml(result.path.replace(process.cwd() + "/", ""))}</code>` : "",
      "",
      ...headings.map((h) => `\u2022 ${escapeHtml(h)}`),
    ].filter(Boolean);
    const msg = lines.join("\n");

    if (this.newsChatId) {
      await this.sendSafe(bot, this.newsChatId, msg, this.newsTopicId);
    } else {
      for (const chatId of this.defaultChatIds) {
        await this.sendSafe(bot, chatId, msg);
      }
    }
  }

  private async notifyMonthly(result: MonthlySynthResult): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;
    const appended = result.appendedTo
      .map((p) => p.replace(process.cwd() + "/", ""))
      .map((p) => `\u2022 ${escapeHtml(p)}`)
      .join("\n");
    const msg = [
      `<b>Monthly scan synthesis</b>`,
      `Scans mapped this run: ${result.mapped}`,
      appended ? `Appended to:\n${appended}` : "No append candidates this month.",
    ].join("\n");

    if (this.tradingChatId) {
      await this.sendSafe(bot, this.tradingChatId, msg, this.tradingTopicId);
    } else {
      for (const chatId of this.defaultChatIds) {
        await this.sendSafe(bot, chatId, msg);
      }
    }
  }

  private async notifyAliases(result: ProposeAliasesResult): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;
    const plural = result.proposed === 1 ? "" : "s";
    const msg = [
      `<b>Alias proposals ready</b>`,
      `${result.proposed} new suggestion${plural} awaiting review.`,
      `Open the Library \u2192 Aliases tab to approve or reject.`,
    ].join("\n");

    if (this.newsChatId) {
      await this.sendSafe(bot, this.newsChatId, msg, this.newsTopicId);
    } else {
      for (const chatId of this.defaultChatIds) {
        await this.sendSafe(bot, chatId, msg);
      }
    }
  }

  private async sendSafe(
    bot: Bot,
    chatId: string | number,
    text: string,
    topicId?: number,
  ): Promise<void> {
    try {
      await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        ...(topicId ? { message_thread_id: topicId } : {}),
      });
    } catch (err) {
      log.error("Synthesis notify failed", { chatId, topicId, error: String(err) });
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractTopHeadings(markdown: string, n: number): string[] {
  const out: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^##\s+(?!Open threads\b)(.+)$/i.exec(line.trim());
    if (m) {
      out.push(m[1].trim());
      if (out.length >= n) break;
    }
  }
  return out;
}
