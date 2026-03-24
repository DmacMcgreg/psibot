import { AgentService } from "../agent/index.ts";
import {
  getJob,
  createJobRun,
  completeJobRun,
  updateJob,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { splitMessage, markdownToTelegramV2 } from "../telegram/format.ts";
import { PLIST_LABEL } from "../cli/paths.ts";
import type { RunStatus } from "../shared/types.ts";
import type { Bot } from "grammy";

const log = createLogger("scheduler:executor");

export class JobExecutor {
  private agent: AgentService;
  private bot: Bot | null = null;
  private notifyUserIds: number[] = [];

  constructor(agent: AgentService) {
    this.agent = agent;
  }

  setNotifier(bot: Bot, userIds: number[]): void {
    this.bot = bot;
    this.notifyUserIds = userIds;
  }

  async execute(jobId: number, options?: { manualTrigger?: boolean }): Promise<void> {
    const job = getJob(jobId);
    if (!job) {
      log.error("Job not found", { jobId });
      return;
    }

    // Check pause conditions (skipped for manual triggers)
    if (!options?.manualTrigger) {
      if (job.paused_until) {
        const pausedUntil = new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z");
        if (pausedUntil > new Date()) {
          log.info("Job paused until future date, skipping", { jobId, paused_until: job.paused_until });
          return;
        }
        // Pause expired, clear it
        updateJob(jobId, { paused_until: null });
      }
      if (job.skip_runs > 0) {
        updateJob(jobId, { skip_runs: job.skip_runs - 1 });
        log.info("Job skip_runs decremented, skipping execution", { jobId, remaining: job.skip_runs - 1 });
        return;
      }
    }

    log.info("Executing job", { jobId, name: job.name });

    const run = createJobRun(jobId);
    const startTime = Date.now();

    try {
      const allowedTools = job.allowed_tools
        ? job.allowed_tools.split(",").map((t) => t.trim())
        : undefined;

      const result = await this.agent.run({
        prompt: job.prompt,
        source: "job",
        sourceId: String(jobId),
        // maxBudgetUsd: job.max_budget_usd, // Budget enforcement disabled
        allowedTools,
        useBrowser: Boolean(job.use_browser),
        model: job.model ?? undefined,
        backend: (job.backend as "claude" | "glm") ?? undefined,
      });

      // Budget enforcement disabled — always report success
      const status: RunStatus = "success";

      completeJobRun(run.id, {
        status,
        result: result.result,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        session_id: result.sessionId,
      });

      updateJob(jobId, { last_run_at: new Date().toISOString() });

      if (job.type === "once") {
        updateJob(jobId, { status: "completed" });
      } else if (job.type === "cron" && job.status === "failed") {
        // Auto-recover cron jobs that succeed after a failure
        updateJob(jobId, { status: "enabled" });
        log.info("Job recovered from failed status", { jobId, name: job.name });
      }

      log.info("Job completed", {
        jobId,
        name: job.name,
        status,
        cost: result.costUsd,
        duration: Date.now() - startTime,
      });

      // Notify via Telegram — skip no-ops and routine results
      const isSilent = result.result.includes("[SILENT]")
        || /no (new |pending )?items/i.test(result.result)
        || /nothing to/i.test(result.result)
        || /\b0 (new |items)/i.test(result.result)
        || /\bfound 0\b/i.test(result.result)
        || /no new /i.test(result.result)
        || /don't have access to/i.test(result.result)
        || /tool isn't available/i.test(result.result)
        || /cannot invoke it manually/i.test(result.result)
        || /doesn't appear to be registered/i.test(result.result);
      if (!isSilent) {
        await this.notify(
          `Job "${job.name}" completed\n\n${result.result}`
        );
      } else {
        log.info("Job notification suppressed (silent/no-op)", { jobId, name: job.name });
      }

      // Check for pending restart after notification is sent
      if (this.agent.consumeRestart()) {
        const uid = process.getuid?.() ?? 501;
        const target = `gui/${uid}/${PLIST_LABEL}`;
        log.info("Executing deferred daemon restart (job)", { target, jobId });
        Bun.spawn(["bash", "-c", `sleep 1 && launchctl kickstart -k ${target}`], {
          stdout: "ignore", stderr: "ignore", stdin: "ignore",
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Job execution failed", { jobId, error: message });

      completeJobRun(run.id, {
        status: "error",
        error: message,
        duration_ms: Date.now() - startTime,
      });

      updateJob(jobId, {
        last_run_at: new Date().toISOString(),
        status: "failed",
      });

      await this.notify(`Job "${job.name}" failed: ${message}`);
    }
  }

  private async notify(text: string): Promise<void> {
    if (!this.bot || this.notifyUserIds.length === 0) return;
    const chunks = splitMessage(text);
    for (const userId of this.notifyUserIds) {
      try {
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(userId, markdownToTelegramV2(chunk), { parse_mode: "MarkdownV2" });
        }
      } catch (err) {
        log.error("Failed to send notification", {
          userId,
          error: String(err),
        });
      }
    }
  }
}
