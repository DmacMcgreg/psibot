import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { MemorySystem } from "../memory/index.ts";
import { createAgentTools } from "./tools.ts";
import { buildSystemPrompt } from "./prompts.ts";
import {
  insertChatMessage,
  upsertSession,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import type { AgentRunOptions, AgentRunResult } from "../shared/types.ts";

const log = createLogger("agent");

interface AgentServiceDeps {
  memory: MemorySystem;
  reloadScheduler: () => void;
  triggerJob: (jobId: number) => void;
}

export class AgentService {
  private memory: MemorySystem;
  private toolServer: ReturnType<typeof createAgentTools>;
  private activeQueries = new Map<string, { interrupt: () => Promise<void> }>();

  constructor(deps: AgentServiceDeps) {
    this.memory = deps.memory;
    this.toolServer = createAgentTools(deps);
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const config = getConfig();
    const maxBudget = options.maxBudgetUsd ?? config.DEFAULT_MAX_BUDGET_USD;
    const runId = crypto.randomUUID();

    log.info("Starting agent run", {
      runId,
      source: options.source,
      sessionId: options.sessionId ?? "new",
      maxBudget,
    });

    const systemPrompt = buildSystemPrompt(this.memory);

    const disallowedTools: string[] = [];
    if (!options.useBrowser) {
      disallowedTools.push("browser_task");
    }

    const agentQuery = query({
      prompt: options.prompt,
      options: {
        systemPrompt,
        model: config.DEFAULT_MODEL,
        permissionMode: "bypassPermissions",
        maxBudgetUsd: maxBudget,
        allowedTools: options.allowedTools,
        disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
        mcpServers: {
          "agent-tools": this.toolServer,
        },
        ...(options.sessionId ? { resume: options.sessionId } : {}),
      },
    });

    this.activeQueries.set(runId, agentQuery);

    let sessionId = options.sessionId ?? "";
    let resultText = "";
    let totalCost = 0;
    let durationMs = 0;

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

      for await (const message of agentQuery) {
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
                  options.onToolUse?.(block.name);
                }
              }
            }
            break;
          }

          case "result": {
            resultText = "result" in message ? String(message.result) : "";
            totalCost = message.total_cost_usd;
            durationMs = message.duration_ms;

            log.info("Agent run completed", {
              sessionId,
              cost: totalCost,
              durationMs,
              subtype: message.subtype,
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
      };

      options.onComplete?.(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Agent run failed", { runId, error: message });
      throw err;
    } finally {
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
