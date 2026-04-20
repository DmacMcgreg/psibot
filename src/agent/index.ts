import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { MemorySystem } from "../memory/index.ts";
import { createAgentTools, type ToolDeps } from "./tools.ts";
import { createMediaTools } from "./media-tools.ts";
import { createYoutubeTools } from "./youtube-tools.ts";
import { loadAgentDefinitions } from "./subagents.ts";
import { buildSystemPrompt, buildJobPrompt } from "./prompts.ts";
import { getGlmMcpServers } from "./glm-mcp.ts";
import { createTradingMcpServer } from "./trading-mcp.ts";
import {
  insertChatMessage,
  upsertSession,
  insertToolUse,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import type { AgentRunOptions, AgentRunResult, StopReason } from "../shared/types.ts";

const log = createLogger("agent");

function toolInputSummary(input?: Record<string, unknown>): string | null {
  if (!input) return null;
  // Serialize all string/number/boolean fields as key=value pairs
  const parts: string[] = [];
  for (const [key, val] of Object.entries(input)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "string") {
      // Truncate long values, collapse newlines
      const short = val.replace(/\n/g, " ").slice(0, 120);
      parts.push(`${key}=${short}${val.length > 120 ? "..." : ""}`);
    } else if (typeof val === "number" || typeof val === "boolean") {
      parts.push(`${key}=${val}`);
    }
  }
  if (parts.length === 0) return null;
  const summary = parts.join("; ");
  return summary.slice(0, 500);
}

export type AgentServiceDeps = ToolDeps;

export class AgentService {
  private memory: MemorySystem;
  private deps: AgentServiceDeps;
  private activeQueries = new Map<string, { interrupt: () => Promise<void> }>();
  private _keepAlive: (() => void) | null = null;
  private _pendingRestart = false;

  get pendingRestart(): boolean {
    return this._pendingRestart;
  }

  scheduleRestart(): void {
    this._pendingRestart = true;
  }

  consumeRestart(): boolean {
    const pending = this._pendingRestart;
    this._pendingRestart = false;
    return pending;
  }

  constructor(deps: AgentServiceDeps) {
    this.memory = deps.memory;
    this.deps = deps;
  }

  /** Create fresh MCP servers for each run to avoid transport conflicts. */
  private createMcpServers(chatContext?: AgentRunOptions["chatContext"]) {
    const toolBundle = createAgentTools(this.deps);
    toolBundle.setChatContext(chatContext);
    return {
      toolBundle,
      servers: {
        "agent-tools": toolBundle.server,
        "media-tools": createMediaTools(),
        "youtube-tools": createYoutubeTools({
          getBot: this.deps.getBot,
          defaultChatIds: this.deps.defaultChatIds,
          keepAlive: () => this._keepAlive?.(),
        }),
        "trading-bot": createTradingMcpServer(),
      } as Record<string, ReturnType<typeof createAgentTools>["server"]>,
    };
  }

  /**
   * Build the fallback tier ladder for a run.
   *
   * Ladder: primary backend first (model 1 + retry, model 2 + retry), then the
   * other backend (model 1 + retry, model 2 + retry). 8 tiers worst case.
   *
   * Only advances on `first_response_timeout` — every other stop reason is final.
   */
  private buildFallbackTiers(
    options: AgentRunOptions,
  ): Array<{ backend: "claude" | "glm"; model: string; attempt: number }> {
    const config = getConfig();
    const primaryBackend = options.backend ?? "claude";
    const primaryModel = options.model ?? config.DEFAULT_MODEL;

    // Resolve the "family" (primary tier) and its fallback model per backend.
    // Uses short aliases so GLM env-overrides map them to the right concrete IDs.
    const isOpus = /opus/i.test(primaryModel);
    const isSonnet = /sonnet/i.test(primaryModel);
    const isHaiku = /haiku/i.test(primaryModel);

    // For the primary backend, preserve exactly what the caller asked for as tier 1,
    // then step down one rung for tier 2.
    const primaryTopModel = primaryModel;
    const primaryFallbackModel = isOpus ? "sonnet" : isSonnet ? "haiku" : isHaiku ? "haiku" : primaryModel;

    // For the secondary backend, start at the same rung the caller asked for.
    const secondaryTopModel = isOpus ? "opus" : isSonnet ? "sonnet" : isHaiku ? "haiku" : primaryModel;
    const secondaryFallbackModel = isOpus ? "sonnet" : isSonnet ? "haiku" : isHaiku ? "haiku" : primaryModel;

    const secondaryBackend: "claude" | "glm" = primaryBackend === "claude" ? "glm" : "claude";

    return [
      { backend: primaryBackend, model: primaryTopModel, attempt: 1 },
      { backend: primaryBackend, model: primaryTopModel, attempt: 2 },
      { backend: primaryBackend, model: primaryFallbackModel, attempt: 1 },
      { backend: primaryBackend, model: primaryFallbackModel, attempt: 2 },
      { backend: secondaryBackend, model: secondaryTopModel, attempt: 1 },
      { backend: secondaryBackend, model: secondaryTopModel, attempt: 2 },
      { backend: secondaryBackend, model: secondaryFallbackModel, attempt: 1 },
      { backend: secondaryBackend, model: secondaryFallbackModel, attempt: 2 },
    ];
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const tiers = this.buildFallbackTiers(options);
    let lastResult: AgentRunResult | null = null;

    for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
      const tier = tiers[tierIdx];
      log.info("Attempting tier", {
        tier: tierIdx + 1,
        totalTiers: tiers.length,
        backend: tier.backend,
        model: tier.model,
        attempt: tier.attempt,
      });

      const result = await this.runOnce({
        ...options,
        model: tier.model,
        backend: tier.backend,
      });
      lastResult = result;

      // Advance on two signals:
      //   - first_response_timeout (never got a message — SDK hung / rate-limited)
      //   - error (SDK returned an error result, e.g. 401 auth, upstream failure)
      // Every other outcome is final — we don't throw away real work on a
      // mid-run stale_timeout, budget_exceeded, max_turns, or success.
      const retryable = result.stopReason === "first_response_timeout" || result.stopReason === "error";
      if (!retryable) {
        if (tierIdx > 0) {
          log.info("Tier succeeded after fallback", {
            tier: tierIdx + 1,
            backend: tier.backend,
            model: tier.model,
            stopReason: result.stopReason,
          });
          // Annotate the result so downstream (Telegram, logs) knows this came from a fallback path.
          result.result = `[fallback: ${tier.backend}/${tier.model}, tier ${tierIdx + 1}/${tiers.length}]\n\n${result.result}`;
        }
        return result;
      }

      log.warn("Tier failed, advancing to next tier", {
        tier: tierIdx + 1,
        backend: tier.backend,
        model: tier.model,
        stopReason: result.stopReason,
      });
    }

    // All tiers exhausted.
    log.error("All fallback tiers exhausted", { totalTiers: tiers.length });
    if (lastResult) {
      lastResult.result = `[all ${tiers.length} fallback tiers exhausted — final stopReason: ${lastResult.stopReason}]\n\n${lastResult.result}`;
      return lastResult;
    }
    // Unreachable — tiers is always non-empty — but satisfy the type checker.
    throw new Error("buildFallbackTiers returned no tiers");
  }

  private async runOnce(options: AgentRunOptions): Promise<AgentRunResult> {
    const config = getConfig();
    const maxBudget = options.maxBudgetUsd ?? config.DEFAULT_MAX_BUDGET_USD;
    const maxTurns = options.maxTurns ?? config.DEFAULT_MAX_TURNS;
    const runId = crypto.randomUUID();
    const FIRST_RESPONSE_TIMEOUT_MS = 90 * 1000; // 90s to get first assistant message before treating run as stuck
    const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no messages = stale (after first response)
    const TOOL_STALE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes during tool execution
    const MAX_LOOP_MESSAGES = maxTurns * 5; // Hard ceiling on total messages in the loop

    log.info("Starting agent run", {
      runId,
      source: options.source,
      sessionId: options.sessionId ?? "new",
      maxBudget,
    });

    const useLight = options.source === "job" && options.allowedTools?.length;
    const systemPrompt = useLight
      ? buildJobPrompt()
      : buildSystemPrompt(this.memory, options.chatContext);
    log.info("System prompt built", { runId, length: systemPrompt.length });

    const model = options.model ?? config.DEFAULT_MODEL;
    const backend = options.backend ?? "claude";

    // Build env overrides for GLM backend
    const envOverride = backend === "glm" && config.GLM_AUTH_TOKEN
      ? {
          ...process.env,
          ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
          ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: config.GLM_HAIKU_MODEL,
          ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
          ANTHROPIC_DEFAULT_OPUS_MODEL: config.GLM_OPUS_MODEL,
        }
      : undefined;

    // Create fresh MCP servers for this run (avoids transport conflicts on concurrent runs)
    const { servers: mcpServers } = this.createMcpServers(options.chatContext);
    if (backend === "glm") {
      Object.assign(mcpServers, getGlmMcpServers());
    }

    // Build agents record fresh from DB each run so dashboard edits and per-agent
    // memory files take effect immediately.
    let agents = loadAgentDefinitions();

    if (options.agentName && agents[options.agentName]) {
      // Override agent prompt if provided
      if (options.agentPrompt) {
        agents = { ...agents, [options.agentName]: { ...agents[options.agentName], prompt: options.agentPrompt } };
      }
    }

    // Filter subagents if specified
    if (options.subagentNames) {
      const allowed = new Set(options.subagentNames);
      if (options.agentName) allowed.add(options.agentName);
      agents = Object.fromEntries(Object.entries(agents).filter(([name]) => allowed.has(name)));
    }

    log.info("Calling query()", { runId, model, backend });
    const agentQuery = query({
      prompt: options.prompt,
      options: {
        systemPrompt,
        model,
        permissionMode: "bypassPermissions",
        maxTurns,
        // Budget enforcement disabled — leave code for reference
        // maxBudgetUsd: maxBudget,
        settingSources: [],
        ...(options.allowedTools ? { allowedTools: [...options.allowedTools, "Skill"] } : {}),
        mcpServers,
        agents,
        ...(options.agentName && agents[options.agentName] ? { agent: options.agentName } : {}),
        ...(options.sessionId ? { resume: options.sessionId } : {}),
        ...(envOverride ? { env: envOverride } : {}),
        stderr: (data: string) => {
          const trimmed = data.trim();
          if (trimmed) log.debug("claude-cli stderr", { runId, data: trimmed.slice(0, 500) });
        },
      },
    });
    log.info("query() returned iterator", { runId });

    this.activeQueries.set(runId, agentQuery);

    let sessionId = options.sessionId ?? "";
    let resultText = "";
    let totalCost = 0;
    let durationMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let contextWindow = 0;
    let numTurns = 0;
    let stopReason: StopReason = "unknown";
    const toolCache = new Map<string, { name: string; input?: Record<string, unknown>; emitted: boolean }>();
    let lastMessageAt = Date.now();
    let staleTimer: ReturnType<typeof setTimeout> | null = null;

    let awaitingToolResult = false;
    let firstAssistantMessageReceived = false;
    const resetStaleTimer = () => {
      lastMessageAt = Date.now();
      if (staleTimer) clearTimeout(staleTimer);
      const timeout = !firstAssistantMessageReceived
        ? FIRST_RESPONSE_TIMEOUT_MS
        : awaitingToolResult
          ? TOOL_STALE_TIMEOUT_MS
          : STALE_TIMEOUT_MS;
      staleTimer = setTimeout(async () => {
        const staleSec = Math.round((Date.now() - lastMessageAt) / 1000);
        log.warn("Agent run stale, interrupting", { runId, staleSec, awaitingToolResult, firstAssistantMessageReceived });
        stopReason = firstAssistantMessageReceived ? "stale_timeout" : "first_response_timeout";
        try {
          await agentQuery.interrupt();
        } catch {
          // ignore interrupt errors
        }
      }, timeout);
    };

    this._keepAlive = resetStaleTimer;
    try {
      // Store user message
      if (sessionId) {
        insertChatMessage({
          session_id: sessionId,
          role: "user",
          content: options.prompt,
          source: options.source,
          source_id: options.sourceId,
        });
      }

      log.info("Entering message loop", { runId });
      resetStaleTimer();
      let messageCount = 0;
      for await (const message of agentQuery) {
        awaitingToolResult = false;
        resetStaleTimer();
        messageCount++;
        if (messageCount > MAX_LOOP_MESSAGES) {
          log.warn("Message loop exceeded limit, interrupting", { runId, messageCount, maxTurns });
          stopReason = "message_limit";
          await agentQuery.interrupt();
          break;
        }
        log.info("Message received", { runId, type: message.type, subtype: "subtype" in message ? message.subtype : undefined });
        switch (message.type) {
          case "system":
            if (message.subtype === "init") {
              sessionId = message.session_id;
              log.info("Agent session initialized", { sessionId });

              // Store user message now that we have session ID
              if (!options.sessionId) {
                insertChatMessage({
                  session_id: sessionId,
                  role: "user",
                  content: options.prompt,
                  source: options.source,
                  source_id: options.sourceId,
                });
              }
            }
            break;

          case "assistant": {
            firstAssistantMessageReceived = true;
            const content = message.message.content;
            let hasToolUse = false;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") {
                  options.onText?.(block.text);
                } else if (block.type === "tool_use") {
                  hasToolUse = true;
                  const input = block.input as Record<string, unknown> | undefined;
                  toolCache.set(block.id, { name: block.name, input, emitted: true });
                  options.onToolUse?.(block.name, input, false);
                  if (sessionId) {
                    try {
                      insertToolUse({
                        session_id: sessionId,
                        tool_name: block.name,
                        input_summary: toolInputSummary(input),
                        is_subagent: false,
                      });
                    } catch { /* non-critical */ }
                  }
                }
              }
            }
            if (hasToolUse) {
              awaitingToolResult = true;
              resetStaleTimer(); // re-arm with longer timeout for tool execution
            }
            break;
          }

          case "tool_progress": {
            // Deduplicate: only emit if assistant message hasn't already
            // Tools not in cache are from subagents (Task children)
            const id = message.tool_use_id;
            if (!toolCache.has(id)) {
              toolCache.set(id, { name: message.tool_name, emitted: true });
              options.onToolUse?.(message.tool_name, undefined, true);
              if (sessionId) {
                try {
                  insertToolUse({
                    session_id: sessionId,
                    tool_name: message.tool_name,
                    is_subagent: true,
                  });
                } catch { /* non-critical */ }
              }
            }
            break;
          }

          case "result": {
            resultText = "result" in message ? String(message.result) : "";
            totalCost = message.total_cost_usd;
            durationMs = message.duration_ms;
            numTurns = message.num_turns;

            // Only override stopReason from SDK if we didn't already set it
            // (stale_timeout / message_limit take priority since they're our interrupts)
            if (stopReason === "unknown") {
              const subtype = message.subtype as string;
              if (subtype === "end_turn") stopReason = "end_turn";
              else if (subtype === "max_turns") stopReason = "max_turns";
              else if (subtype === "budget_exceeded") stopReason = "budget_exceeded";
              else if (subtype === "interrupted") stopReason = "interrupted";
              else if (subtype === "error_during_execution" || subtype === "error") stopReason = "error";
              else stopReason = "end_turn";
            }

            for (const usage of Object.values(message.modelUsage)) {
              inputTokens += usage.inputTokens;
              outputTokens += usage.outputTokens;
              cacheReadTokens += usage.cacheReadInputTokens;
              if (usage.contextWindow > contextWindow) {
                contextWindow = usage.contextWindow;
              }
            }

            log.info("Agent run completed", {
              sessionId,
              cost: totalCost,
              durationMs,
              subtype: message.subtype,
              stopReason,
              inputTokens,
              outputTokens,
              numTurns,
            });
            break;
          }
        }
      }

      // Generate fallback text if the agent didn't produce a response
      if (!resultText.trim() && stopReason !== "end_turn") {
        const reasons: Record<StopReason, string> = {
          max_turns: `Agent reached the turn limit (${maxTurns} turns) before completing a response. Try simplifying your request or increasing the turn limit.`,
          budget_exceeded: `Agent reached the budget limit ($${maxBudget.toFixed(2)}) before completing a response. The work done so far has been saved to the session.`,
          interrupted: "Agent was interrupted before completing a response.",
          stale_timeout: "Agent became unresponsive (no activity for 5 minutes) and was stopped.",
          first_response_timeout: "Agent never produced a first response within 90 seconds — likely an API or routing issue.",
          message_limit: `Agent exceeded the message processing limit and was stopped. Try breaking your request into smaller parts.`,
          error: "Agent encountered an error before completing a response.",
          end_turn: "",
          unknown: "Agent stopped without producing a response.",
        };
        resultText = reasons[stopReason] || reasons.unknown;
        log.warn("Agent produced no response text, using fallback", { runId, stopReason });
      }

      // Store assistant response
      insertChatMessage({
        session_id: sessionId,
        role: "assistant",
        content: resultText,
        source: options.source,
        source_id: options.sourceId,
        cost_usd: totalCost,
        duration_ms: durationMs,
      });

      // Update session record
      upsertSession({
        session_id: sessionId,
        source: options.source,
        source_id: options.sourceId,
        model,
        cost_usd: totalCost,
      });

      const result: AgentRunResult = {
        sessionId,
        result: resultText,
        costUsd: totalCost,
        durationMs,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        contextWindow,
        numTurns,
        stopReason,
      };

      options.onComplete?.(result);
      return result;
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err);

      // If we already received a valid result, this is a post-result CLI crash
      // (e.g., "Claude Code process exited with code 1" during shutdown).
      // Return the successful result instead of throwing.
      if (resultText.trim() && stopReason !== "unknown") {
        log.warn("Post-result CLI error (returning successful result)", { runId, error: errMessage, stopReason });

        insertChatMessage({
          session_id: sessionId,
          role: "assistant",
          content: resultText,
          source: options.source,
          source_id: options.sourceId,
          cost_usd: totalCost,
          duration_ms: durationMs,
        });

        upsertSession({
          session_id: sessionId,
          source: options.source,
          source_id: options.sourceId,
          model,
          cost_usd: totalCost,
        });

        const result: AgentRunResult = {
          sessionId,
          result: resultText,
          costUsd: totalCost,
          durationMs,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          contextWindow,
          numTurns,
          stopReason,
        };

        options.onComplete?.(result);
        return result;
      }

      log.error("Agent run failed", { runId, error: errMessage });

      // If we have a session, store a fallback response so the user sees something
      if (sessionId) {
        const fallback = `Agent encountered an error: ${errMessage}`;
        insertChatMessage({
          session_id: sessionId,
          role: "assistant",
          content: fallback,
          source: options.source,
          source_id: options.sourceId,
          cost_usd: totalCost,
          duration_ms: Date.now() - (durationMs || Date.now()),
        });
      }

      throw err;
    } finally {
      if (staleTimer) clearTimeout(staleTimer);
      this._keepAlive = null;
      this.activeQueries.delete(runId);
    }
  }

  async interrupt(runId: string): Promise<void> {
    const q = this.activeQueries.get(runId);
    if (q) {
      await q.interrupt();
      this.activeQueries.delete(runId);
    }
  }

  get activeRunCount(): number {
    return this.activeQueries.size;
  }
}
