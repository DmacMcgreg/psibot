import { AgentService } from "../agent/index.ts";
import {
  getJob,
  createJobRun,
  completeJobRun,
  updateJob,
  getJobRuns,
  isTopicMuted,
  getAgentBySlug,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { splitMessage, markdownToTelegramV2 } from "../telegram/format.ts";
import { briefKeyboard } from "../telegram/keyboards.ts";
import { PLIST_LABEL } from "../cli/paths.ts";
import { decideNotify } from "../agent/notify-policy.ts";
import { applyOutputTemplate } from "../agent/output-template.ts";
import type { RunStatus, ChatContext, Job } from "../shared/types.ts";
import type { Bot, InlineKeyboard } from "grammy";

const log = createLogger("scheduler:executor");

/** Cooldown per job to prevent diagnostic loops (15 min) */
const DIAG_COOLDOWN_MS = 15 * 60 * 1000;

/** Build a ChatContext from a job's notify routing so the agent's inline
 *  telegram_send_* tools default to the job's configured topic instead of DM. */
function jobChatContext(job: Job): ChatContext | undefined {
  if (!job.notify_chat_id) return undefined;
  const chatType = job.notify_chat_id.startsWith("-") ? "supergroup" : "private";
  return {
    chatId: job.notify_chat_id,
    topicId: job.notify_topic_id ?? undefined,
    chatType,
  };
}

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

      // Inject current date/time so job agents always know when they're running
      const now = new Date();
      const localTime = now.toLocaleString("en-US", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
      const jobPrompt = `[Current time: ${localTime} ET | UTC: ${now.toISOString()}]\n\n${job.prompt}`;

      const result = await this.agent.run({
        prompt: jobPrompt,
        source: "job",
        sourceId: String(jobId),
        chatContext: jobChatContext(job),
        // maxBudgetUsd: job.max_budget_usd, // Budget enforcement disabled
        allowedTools,
        useBrowser: Boolean(job.use_browser),
        model: job.model ?? undefined,
        backend: (job.backend as "claude" | "glm") ?? undefined,
        agentName: job.agent_name ?? undefined,
        agentPrompt: job.agent_prompt ?? undefined,
        subagentNames: job.subagents ? JSON.parse(job.subagents) : undefined,
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

      // Pipeline handoff
      if (job.next_job_id) {
        const nextJob = getJob(job.next_job_id);
        if (nextJob && nextJob.status === "enabled") {
          log.info("Pipeline handoff", { fromJob: job.id, toJob: job.next_job_id, fromName: job.name, toName: nextJob.name });
          // Fire and forget — don't block current job completion
          this.executePipelineStep(job.next_job_id, run.id, result.result).catch((err) => {
            log.error("Pipeline step failed", { toJob: job.next_job_id, error: String(err) });
          });
        }
      }

      // Notify via Telegram — policy-driven (agent.notify_policy with job override)
      const agent = job.agent_name ? getAgentBySlug(job.agent_name) : null;
      const decision = decideNotify({
        agent,
        job,
        status,
        result: result.result,
        previousHash: job.last_output_hash,
      });
      updateJob(jobId, { last_output_hash: decision.hash });

      if (decision.notify) {
        const template = job.output_template ?? agent?.output_template ?? null;
        const rendered = template ? applyOutputTemplate(template, decision.cleanedResult) : decision.cleanedResult;
        const isBrief = /brief/i.test(job.name);
        const keyboard = isBrief ? briefKeyboard(run.id) : undefined;

        await this.notify(
          `Job "${job.name}" completed\n\n${rendered}`,
          job.notify_chat_id ?? undefined,
          job.notify_topic_id ?? undefined,
          keyboard,
        );
      } else {
        log.info("Job notification suppressed", { jobId, name: job.name, policy: decision.policy, reason: decision.reason });
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

  private async executePipelineStep(jobId: number, triggeredByRunId: number, previousResult: string, depth: number = 0): Promise<void> {
    if (depth >= 10) {
      log.error("Pipeline depth limit reached", { jobId, depth });
      return;
    }

    const job = getJob(jobId);
    if (!job || job.status !== "enabled") return;

    log.info("Executing pipeline step", { jobId, name: job.name, depth });

    const run = createJobRun(jobId, triggeredByRunId);
    const startTime = Date.now();

    try {
      const now = new Date();
      const localTime = now.toLocaleString("en-US", { timeZone: "America/Toronto", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
      const pipelinePrompt = `[Current time: ${localTime} ET | UTC: ${now.toISOString()}]\n\n## Previous Job Output\n\n${previousResult}\n\n---\n\n${job.prompt}`;

      const allowedTools = job.allowed_tools
        ? job.allowed_tools.split(",").map((t) => t.trim())
        : undefined;

      const result = await this.agent.run({
        prompt: pipelinePrompt,
        source: "job",
        sourceId: String(jobId),
        chatContext: jobChatContext(job),
        allowedTools,
        useBrowser: Boolean(job.use_browser),
        model: job.model ?? undefined,
        backend: (job.backend as "claude" | "glm") ?? undefined,
        agentName: job.agent_name ?? undefined,
        agentPrompt: job.agent_prompt ?? undefined,
        subagentNames: job.subagents ? JSON.parse(job.subagents) : undefined,
      });

      completeJobRun(run.id, {
        status: "success",
        result: result.result,
        cost_usd: result.costUsd,
        duration_ms: result.durationMs,
        session_id: result.sessionId,
      });

      updateJob(jobId, { last_run_at: new Date().toISOString() });

      log.info("Pipeline step completed", { jobId, name: job.name, cost: result.costUsd });

      // Continue pipeline
      if (job.next_job_id) {
        const nextJob = getJob(job.next_job_id);
        if (nextJob && nextJob.status === "enabled") {
          await this.executePipelineStep(job.next_job_id, run.id, result.result, depth + 1);
        }
      }

      // Notify only at the end of the pipeline (no next job) — policy-driven
      if (!job.next_job_id) {
        const agent = job.agent_name ? getAgentBySlug(job.agent_name) : null;
        const decision = decideNotify({
          agent,
          job,
          status: "success",
          result: result.result,
          previousHash: job.last_output_hash,
        });
        updateJob(jobId, { last_output_hash: decision.hash });
        if (decision.notify) {
          const template = job.output_template ?? agent?.output_template ?? null;
          const rendered = template ? applyOutputTemplate(template, decision.cleanedResult) : decision.cleanedResult;
          await this.notify(
            `Pipeline "${job.name}" completed\n\n${rendered}`,
            job.notify_chat_id ?? undefined,
            job.notify_topic_id ?? undefined,
          );
        } else {
          log.info("Pipeline notification suppressed", { jobId, policy: decision.policy, reason: decision.reason });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Pipeline step failed", { jobId, error: message });
      completeJobRun(run.id, {
        status: "error",
        error: message,
        duration_ms: Date.now() - startTime,
      });
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
