/**
 * Z.AI MCP server configurations for GLM backend agents.
 * These provide web search, page reading, and vision capabilities
 * when running under the GLM backend (api.z.ai).
 */

import { getConfig } from "../config.ts";

interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

interface McpStdioConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

type McpConfig = McpHttpConfig | McpStdioConfig;

export function getGlmMcpServers(): Record<string, McpConfig> {
  const config = getConfig();
  const authToken = config.GLM_AUTH_TOKEN;

  if (!authToken) return {};

  return {
    "web-search-prime": {
      type: "http",
      url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
    "web-reader": {
      type: "http",
      url: "https://api.z.ai/api/mcp/web_reader/mcp",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
    "zai-vision": {
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: {
        Z_AI_API_KEY: authToken,
        Z_AI_MODE: "ZAI",
      },
    },
    zread: {
      type: "http",
      url: "https://api.z.ai/api/mcp/zread/mcp",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
  };
}
