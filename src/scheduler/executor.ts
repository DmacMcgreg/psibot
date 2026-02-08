import { AgentService } from "../agent/index.ts";
import {
  getJob,
  createJobRun,
  completeJobRun,
  updateJob,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { splitMessage, formatCost, formatDuration } from "../telegram/format.ts";
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

  async execute(jobId: number): Promise<void> {
    const job = getJob(jobId);
    if (!job) {
      log.error("Job not found", { jobId });
      return;
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
        maxBudgetUsd: job.max_budget_usd,
        allowedTools,
        useBrowser: Boolean(job.use_browser),
      });

      let status: RunStatus = "success";
      if (result.costUsd >= job.max_budget_usd) {
        status = "budget_exceeded";
      }

      completeJobRun(run.id, {
        status,
        result: result.result,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
      });

      updateJob(jobId, { last_run_at: new Date().toISOString() });

      if (job.type === "once") {
        updateJob(jobId, { status: "completed" });
      }

      log.info("Job completed", {
        jobId,
        name: job.name,
        status,
        cost: result.costUsd,
        duration: Date.now() - startTime,
      });

      // Notify via Telegram
      await this.notify(
        `Job "${job.name}" completed\n\n${result.result}\n\n${formatCost(result.costUsd)} / ${formatDuration(result.durationMs)}`
      );
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
          await this.bot.api.sendMessage(userId, chunk);
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
