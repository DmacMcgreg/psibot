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
import { splitMessage, markdownToTelegramV2, tmaLink } from "../telegram/format.ts";
import { briefKeyboard } from "../telegram/keyboards.ts";
import { PLIST_LABEL } from "../cli/paths.ts";
import { decideNotify } from "../agent/notify-policy.ts";
import { applyOutputTemplate } from "../agent/output-template.ts";
import { tryPublishFromText } from "../agent/agent-run-publisher.ts";
import { readSkill } from "../skills/index.ts";
import { bumpUse, markExposed } from "../skills/usage.ts";
import type { RunStatus, ChatContext, Job } from "../shared/types.ts";
import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";

const log = createLogger("scheduler:executor");

/**
 * Inline the full bodies of a job's pinned skills (jobs.skills, comma-
 * separated slugs) ahead of the job prompt. Deterministic injection at the
 * job seam — the job agent doesn't need to discover anything. Counts as a
 * real `use` and stamps first exposure. A missing skill logs and is skipped;
 * a job must never fail on skill plumbing.
 */
function buildSkillPreamble(job: Job): string {
  if (!job.skills) return "";
  const names = job.skills.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) return "";
  const sections: string[] = [];
  for (const name of names) {
    try {
      const skill = readSkill(name);
      if (!skill) {
        log.warn("Job references missing skill", { jobId: job.id, skill: name });
        continue;
      }
      bumpUse(name);
      sections.push(`### Skill: ${name}\n\n${skill.body.trim()}`);
    } catch (e) {
      log.warn("Skill injection failed", { jobId: job.id, skill: name, error: String(e) });
    }
  }
  if (sections.length === 0) return "";
  markExposed(names);
  return `## Procedural skills for this job\n\nFollow these established procedures where they apply:\n\n${sections.join("\n\n---\n\n")}\n\n---\n\n`;
}

/** Cooldown per job to prevent diagnostic loops (15 min) */
const DIAG_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Append an "Open in app" URL button deep-linking to `/tma/jobs/{jobId}` onto
 * an existing keyboard (or create one if none). No-op (returns the keyboard
 * unchanged) when TELEGRAM_WEBHOOK_HOST isn't configured, so notifications
 * degrade gracefully with no dangling button. The link rides on the button
 * row, never the message text, so it never grows chunk count / message size.
 */
function withAppLink(keyboard: InlineKeyboard | undefined, jobId: number): InlineKeyboard | undefined {
  const link = tmaLink(`jobs/${jobId}`);
  if (!link) return keyboard;
  return new InlineKeyboard(keyboard?.inline_keyboard ?? []).row().url("Open in app", link);
}

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
      const jobPrompt = `[Current time: ${localTime} ET | UTC: ${now.toISOString()}]\n\n${buildSkillPreamble(job)}${job.prompt}`;

      // Backend precedence: job.backend > agent.backend > global default.
      const agentForBackend = job.agent_name ? getAgentBySlug(job.agent_name) : null;
      const resolvedBackend =
        (job.backend as "claude" | "glm" | null) ??
        (agentForBackend?.backend as "claude" | "glm" | null) ??
        undefined;

      const result = await this.agent.run({
        prompt: jobPrompt,
        source: "job",
        sourceId: String(jobId),
        chatContext: jobChatContext(job),
        // maxBudgetUsd: job.max_budget_usd, // Budget enforcement disabled
        allowedTools,
        useBrowser: Boolean(job.use_browser),
        model: job.model ?? undefined,
        backend: resolvedBackend,
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

      // Publish agent-run envelope to trading-bot dashboard (non-blocking).
      // Failure here never affects the upstream job — see agent-run-publisher.ts.
      const completedAt = new Date().toISOString();
      const startedAt = new Date(startTime).toISOString();
      tryPublishFromText(result.result, {
        jobId,
        runId: run.id,
        startedAt,
        completedAt,
        costUsd: result.costUsd ?? null,
        durationMs: result.durationMs ?? null,
      }).catch((err) => log.warn("Envelope publish threw", { jobId, error: String(err) }));

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
      // Prefer a [NOTIFY]...[/NOTIFY] block captured mid-run over the final
      // result text. This survives cases where a late turn (e.g. a backgrounded
      // task completion the agent blocks on with TaskOutput) replaces the final
      // message with a meta-acknowledgment, which would otherwise clobber the brief.
      const decision = decideNotify({
        agent,
        job,
        status,
        result: result.notifyText ?? result.result,
        previousHash: job.last_output_hash,
      });
      updateJob(jobId, { last_output_hash: decision.hash });

      if (decision.notify && result.deliveredViaTool) {
        log.info("Job wrapper notification suppressed (agent already sent via telegram tool)", { jobId, name: job.name });
      } else if (decision.notify) {
        const template = job.output_template ?? agent?.output_template ?? null;
        const rendered = template ? applyOutputTemplate(template, decision.cleanedResult) : decision.cleanedResult;
        const isBrief = /brief/i.test(job.name);
        const keyboard = isBrief ? briefKeyboard(run.id) : undefined;

        await this.notify(
          rendered,
          job.notify_chat_id ?? undefined,
          job.notify_topic_id ?? undefined,
          withAppLink(keyboard, jobId),
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
        withAppLink(undefined, jobId),
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
      const pipelinePrompt = `[Current time: ${localTime} ET | UTC: ${now.toISOString()}]\n\n${buildSkillPreamble(job)}## Previous Job Output\n\n${previousResult}\n\n---\n\n${job.prompt}`;

      const allowedTools = job.allowed_tools
        ? job.allowed_tools.split(",").map((t) => t.trim())
        : undefined;

      const agentForBackend = job.agent_name ? getAgentBySlug(job.agent_name) : null;
      const resolvedBackend =
        (job.backend as "claude" | "glm" | null) ??
        (agentForBackend?.backend as "claude" | "glm" | null) ??
        undefined;

      const result = await this.agent.run({
        prompt: pipelinePrompt,
        source: "job",
        sourceId: String(jobId),
        chatContext: jobChatContext(job),
        allowedTools,
        useBrowser: Boolean(job.use_browser),
        model: job.model ?? undefined,
        backend: resolvedBackend,
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

      // Pipeline-step envelopes also get published. Same non-blocking semantics.
      const stepCompletedAt = new Date().toISOString();
      const stepStartedAt = new Date(startTime).toISOString();
      tryPublishFromText(result.result, {
        jobId,
        runId: run.id,
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
        costUsd: result.costUsd ?? null,
        durationMs: result.durationMs ?? null,
      }).catch((err) => log.warn("Envelope publish threw (pipeline)", { jobId, error: String(err) }));

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
          result: result.notifyText ?? result.result,
          previousHash: job.last_output_hash,
        });
        updateJob(jobId, { last_output_hash: decision.hash });
        if (decision.notify && result.deliveredViaTool) {
          log.info("Pipeline wrapper notification suppressed (agent already sent via telegram tool)", { jobId });
        } else if (decision.notify) {
          const template = job.output_template ?? agent?.output_template ?? null;
          const rendered = template ? applyOutputTemplate(template, decision.cleanedResult) : decision.cleanedResult;
          await this.notify(
            rendered,
            job.notify_chat_id ?? undefined,
            job.notify_topic_id ?? undefined,
            withAppLink(undefined, jobId),
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
        model: undefined,
        backend: undefined,
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
