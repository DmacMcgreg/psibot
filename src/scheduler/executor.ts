import { AgentService } from "../agent/index.ts";
import {
  getJob,
  createJobRun,
  completeJobRun,
  updateJob,
  getJobRuns,
  isTopicMuted,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { splitMessage, markdownToTelegramV2 } from "../telegram/format.ts";
import { briefKeyboard } from "../telegram/keyboards.ts";
import { PLIST_LABEL } from "../cli/paths.ts";
import type { RunStatus } from "../shared/types.ts";
import type { Bot, InlineKeyboard } from "grammy";

const log = createLogger("scheduler:executor");

/** Cooldown per job to prevent diagnostic loops (15 min) */
const DIAG_COOLDOWN_MS = 15 * 60 * 1000;

export class JobExecutor {
  private agent: AgentService;
  private bot: Bot | null = null;
  private notifyUserIds: number[] = [];
  private lastDiagAt = new Map<number, number>();

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
        // Attach interactive keyboard for briefs
        const isBrief = /brief/i.test(job.name);
        const keyboard = isBrief ? briefKeyboard(run.id) : undefined;

        await this.notify(
          `Job "${job.name}" completed\n\n${result.result}`,
          job.notify_chat_id ?? undefined,
          job.notify_topic_id ?? undefined,
          keyboard,
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

      await this.notify(
        `Job "${job.name}" failed: ${message}`,
        job.notify_chat_id ?? undefined,
        job.notify_topic_id ?? undefined,
      );

      // Spawn diagnostic agent (with cooldown to prevent loops)
      await this.diagnoseFailure(jobId, job.name, message);
    }
  }

  private async diagnoseFailure(jobId: number, jobName: string, error: string): Promise<void> {
    const lastDiag = this.lastDiagAt.get(jobId) ?? 0;
    if (Date.now() - lastDiag < DIAG_COOLDOWN_MS) {
      log.info("Diagnostic skipped (cooldown)", { jobId });
      return;
    }
    this.lastDiagAt.set(jobId, Date.now());

    // Gather recent run history for context
    const recentRuns = getJobRuns(jobId, 5);
    const runSummary = recentRuns.map((r) => (
      `  ${r.started_at} — ${r.status}${r.error ? `: ${r.error.slice(0, 100)}` : ""}`
    )).join("\n");

    const job = getJob(jobId);
    const prompt = `You are a job diagnostic agent for PsiBot. A scheduled job just failed. Diagnose the issue and take corrective action if possible.

JOB: "${jobName}" (ID: ${jobId})
TYPE: ${job?.type ?? "unknown"} | SCHEDULE: ${job?.schedule ?? "N/A"} | BACKEND: ${job?.backend ?? "claude"}
ERROR: ${error}

RECENT RUNS (newest first):
${runSummary || "  No previous runs found."}

INSTRUCTIONS:
1. Analyze the error pattern. Common causes:
   - "Claude Code process exited with code 1" = CLI crash during shutdown (usually harmless, post-result recovery should handle this)
   - "tool isn't available" / "doesn't appear to be registered" = MCP server not connected, may need daemon restart
   - Timeout / stale = agent hung, may need prompt simplification
   - Network errors = transient, re-enable the job

2. Take action using the available tools:
   - Use update_job to re-enable the job if it's a transient failure
   - Use update_job to pause the job (paused_until) if it's repeatedly failing with the same error
   - If the issue requires a daemon restart, use the restart_daemon tool

3. Respond with a brief diagnosis (2-3 sentences max). Start with [SILENT] if no user notification is needed.`;

    try {
      log.info("Spawning diagnostic agent", { jobId, jobName });
      await this.agent.run({
        prompt,
        source: "job",
        sourceId: `diag:${jobId}`,
        model: "claude-opus-4-6",
        backend: "claude",
      });
    } catch (err) {
      log.error("Diagnostic agent failed", { jobId, error: String(err) });
    }
  }

  private async notify(text: string, chatId?: string, topicId?: number, keyboard?: InlineKeyboard): Promise<void> {
    if (!this.bot) return;

    // Check topic-level mute
    if (chatId && isTopicMuted(chatId, topicId ?? null)) {
      log.info("Notification muted", { chatId, topicId });
      return;
    }

    const chunks = splitMessage(text);

    if (chatId) {
      // Send to specific group chat / topic
      try {
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          await this.bot.api.sendMessage(chatId, markdownToTelegramV2(chunks[i]), {
            parse_mode: "MarkdownV2",
            ...(topicId ? { message_thread_id: topicId } : {}),
            ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
          });
        }
      } catch (err) {
        log.error("Failed to send topic notification", { chatId, topicId, error: String(err) });
        // Fall through to DM as fallback
        for (const userId of this.notifyUserIds) {
          try {
            for (let i = 0; i < chunks.length; i++) {
              const isLast = i === chunks.length - 1;
              await this.bot.api.sendMessage(userId, markdownToTelegramV2(chunks[i]), {
                parse_mode: "MarkdownV2",
                ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
              });
            }
          } catch (e) {
            log.error("Failed to send DM fallback", { userId, error: String(e) });
          }
        }
      }
    } else {
      // Default: DM to all notify users
      for (const userId of this.notifyUserIds) {
        try {
          for (let i = 0; i < chunks.length; i++) {
            const isLast = i === chunks.length - 1;
            await this.bot.api.sendMessage(userId, markdownToTelegramV2(chunks[i]), {
              parse_mode: "MarkdownV2",
              ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
            });
          }
        } catch (err) {
          log.error("Failed to send notification", { userId, error: String(err) });
        }
      }
    }
  }
}
