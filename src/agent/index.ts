import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { MemorySystem } from "../memory/index.ts";
import { createAgentTools, type ToolDeps } from "./tools.ts";
import { createMediaTools } from "./media-tools.ts";
import { createYoutubeTools } from "./youtube-tools.ts";
import { buildAgentDefinitions } from "./subagents.ts";
import { buildSystemPrompt } from "./prompts.ts";
import {
  insertChatMessage,
  upsertSession,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import type { AgentRunOptions, AgentRunResult, StopReason } from "../shared/types.ts";

const log = createLogger("agent");

export type AgentServiceDeps = ToolDeps;

export class AgentService {
  private memory: MemorySystem;
  private toolServer: ReturnType<typeof createAgentTools>;
  private mediaToolServer: ReturnType<typeof createMediaTools>;
  private youtubeToolServer: ReturnType<typeof createYoutubeTools>;
  private agentDefinitions: ReturnType<typeof buildAgentDefinitions>;
  private activeQueries = new Map<string, { interrupt: () => Promise<void> }>();
  private _keepAlive: (() => void) | null = null;

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
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const config = getConfig();
    const maxBudget = options.maxBudgetUsd ?? config.DEFAULT_MAX_BUDGET_USD;
    const maxTurns = options.maxTurns ?? config.DEFAULT_MAX_TURNS;
    const runId = crypto.randomUUID();
    const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no messages = stale
    const MAX_LOOP_MESSAGES = maxTurns * 5; // Hard ceiling on total messages in the loop

    log.info("Starting agent run", {
      runId,
      source: options.source,
      sessionId: options.sessionId ?? "new",
      maxBudget,
    });

    const systemPrompt = buildSystemPrompt(this.memory);
    log.info("System prompt built", { runId, length: systemPrompt.length });

    const model = options.model ?? config.DEFAULT_MODEL;
    log.info("Calling query()", { runId, model });
    const agentQuery = query({
      prompt: options.prompt,
      options: {
        systemPrompt,
        model,
        permissionMode: "bypassPermissions",
        maxTurns,
        maxBudgetUsd: maxBudget,
        settingSources: ["project"],
        allowedTools: [...(options.allowedTools ?? []), "Skill"],
        mcpServers: {
          "agent-tools": this.toolServer,
          "media-tools": this.mediaToolServer,
          "youtube-tools": this.youtubeToolServer,
        },
        agents: this.agentDefinitions,
        ...(options.sessionId ? { resume: options.sessionId } : {}),
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

    const resetStaleTimer = () => {
      lastMessageAt = Date.now();
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(async () => {
        const staleSec = Math.round((Date.now() - lastMessageAt) / 1000);
        log.warn("Agent run stale, interrupting", { runId, staleSec });
        stopReason = "stale_timeout";
        try {
          await agentQuery.interrupt();
        } catch {
          // ignore interrupt errors
        }
      }, STALE_TIMEOUT_MS);
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
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text") {
                  options.onText?.(block.text);
                } else if (block.type === "tool_use") {
                  const input = block.input as Record<string, unknown> | undefined;
                  toolCache.set(block.id, { name: block.name, input, emitted: true });
                  options.onToolUse?.(block.name, input, false);
                }
              }
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
