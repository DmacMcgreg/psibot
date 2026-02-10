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
import type { AgentRunOptions, AgentRunResult } from "../shared/types.ts";

const log = createLogger("agent");

export type AgentServiceDeps = ToolDeps;

export class AgentService {
  private memory: MemorySystem;
  private toolServer: ReturnType<typeof createAgentTools>;
  private mediaToolServer: ReturnType<typeof createMediaTools>;
  private youtubeToolServer: ReturnType<typeof createYoutubeTools>;
  private agentDefinitions: ReturnType<typeof buildAgentDefinitions>;
  private activeQueries = new Map<string, { interrupt: () => Promise<void> }>();

  constructor(deps: AgentServiceDeps) {
    this.memory = deps.memory;
    this.toolServer = createAgentTools(deps);
    this.mediaToolServer = createMediaTools();
    this.youtubeToolServer = createYoutubeTools();
    this.agentDefinitions = buildAgentDefinitions();
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const config = getConfig();
    const maxBudget = options.maxBudgetUsd ?? config.DEFAULT_MAX_BUDGET_USD;
    const maxTurns = options.maxTurns ?? 30;
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

    log.info("Calling query()", { runId, model: config.DEFAULT_MODEL });
    const agentQuery = query({
      prompt: options.prompt,
      options: {
        systemPrompt,
        model: config.DEFAULT_MODEL,
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
    const toolCache = new Map<string, { name: string; input?: Record<string, unknown>; emitted: boolean }>();
    let lastMessageAt = Date.now();
    let staleTimer: ReturnType<typeof setTimeout> | null = null;

    const resetStaleTimer = () => {
      lastMessageAt = Date.now();
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(async () => {
        const staleSec = Math.round((Date.now() - lastMessageAt) / 1000);
        log.warn("Agent run stale, interrupting", { runId, staleSec });
        try {
          await agentQuery.interrupt();
        } catch {
          // ignore interrupt errors
        }
      }, STALE_TIMEOUT_MS);
    };

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
              inputTokens,
              outputTokens,
              numTurns,
            });
            break;
          }
        }
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
        model: config.DEFAULT_MODEL,
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
      };

      options.onComplete?.(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Agent run failed", { runId, error: message });
      throw err;
    } finally {
      if (staleTimer) clearTimeout(staleTimer);
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
