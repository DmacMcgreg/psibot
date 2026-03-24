import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { MemorySystem } from "../memory/index.ts";
import { createAgentTools, type ToolDeps } from "./tools.ts";
import { createMediaTools } from "./media-tools.ts";
import { createYoutubeTools } from "./youtube-tools.ts";
import { buildAgentDefinitions } from "./subagents.ts";
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
  private toolServer: ReturnType<typeof createAgentTools>;
  private mediaToolServer: ReturnType<typeof createMediaTools>;
  private youtubeToolServer: ReturnType<typeof createYoutubeTools>;
  private agentDefinitions: ReturnType<typeof buildAgentDefinitions>;
  private tradingServer: ReturnType<typeof createTradingMcpServer>;
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
    this.toolServer = createAgentTools(deps);
    this.mediaToolServer = createMediaTools();
    this.youtubeToolServer = createYoutubeTools({
      getBot: deps.getBot,
      defaultChatIds: deps.defaultChatIds,
      keepAlive: () => this._keepAlive?.(),
    });
    this.agentDefinitions = buildAgentDefinitions();
    this.tradingServer = createTradingMcpServer();
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const config = getConfig();
    const maxBudget = options.maxBudgetUsd ?? config.DEFAULT_MAX_BUDGET_USD;
    const maxTurns = options.maxTurns ?? config.DEFAULT_MAX_TURNS;
    const runId = crypto.randomUUID();
    const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no messages = stale
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

    // Build MCP servers — add GLM-specific servers when using GLM backend
    const mcpServers: Record<string, unknown> = {
      "agent-tools": this.toolServer,
      "media-tools": this.mediaToolServer,
      "youtube-tools": this.youtubeToolServer,
      "trading-bot": this.tradingServer,
    };
    if (backend === "glm") {
      Object.assign(mcpServers, getGlmMcpServers());
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
        mcpServers: mcpServers as Record<string, ReturnType<typeof createAgentTools>>,
        agents: this.agentDefinitions,
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
    const resetStaleTimer = () => {
      lastMessageAt = Date.now();
      if (staleTimer) clearTimeout(staleTimer);
      const timeout = awaitingToolResult ? TOOL_STALE_TIMEOUT_MS : STALE_TIMEOUT_MS;
      staleTimer = setTimeout(async () => {
        const staleSec = Math.round((Date.now() - lastMessageAt) / 1000);
        log.warn("Agent run stale, interrupting", { runId, staleSec, awaitingToolResult });
        stopReason = "stale_timeout";
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
