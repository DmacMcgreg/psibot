/**
 * local-mcp-hub tool integration.
 *
 * Wires the `hub-edge` binary as an external stdio MCP server so the telegram
 * agent gets the hub's lazily-exposed tool surface: hub_search / hub_describe /
 * hub_call for anything not already visible, hub_route for golden-path
 * workflows, vault_* for any credential-shaped operation, and mac_status /
 * hub_doctor for machine + hub health. The SDK surfaces the hub's own
 * serverInstructions automatically once connected.
 *
 * Same shape as glm-mcp.ts: pure config-derived record, no side effects.
 * Fail-soft — returns {} when disabled or when the binary is missing, so a
 * machine without the hub installed simply runs without it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("agent.hub-mcp");

interface McpStdioConfig {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export function getHubMcpServer(): Record<string, McpStdioConfig> {
  const config = getConfig();
  if (!config.HUB_MCP_ENABLED) return {};

  const bin = expandHome(config.HUB_EDGE_BIN || "~/.local/bin/hub-edge");
  if (!existsSync(bin)) {
    log.info("Hub MCP disabled — binary not found", { bin });
    return {};
  }

  return {
    hub: {
      type: "stdio",
      command: bin,
      // `other` marks PsiBot as a distinct hub client from Claude Code.
      args: ["--client", "other"],
    },
  };
}
