#!/usr/bin/env bun
/**
 * Integration test for Claude and GLM backends.
 * Tests real API calls — no mocking.
 *
 * Run: bun run scripts/test-backends.ts
 *
 * Requires:
 *   - Claude Max plan (authenticated via claude CLI)
 *   - GLM_AUTH_TOKEN in .env
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, getConfig } from "../src/config.ts";

loadConfig();
const config = getConfig();

interface TestResult {
  name: string;
  backend: string;
  model: string;
  passed: boolean;
  result?: string;
  error?: string;
  durationMs: number;
  cost?: number;
}

const results: TestResult[] = [];

function buildEnv(backend: "claude" | "glm"): Record<string, string | undefined> | undefined {
  if (backend !== "glm" || !config.GLM_AUTH_TOKEN) return undefined;
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.GLM_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.GLM_OPUS_MODEL,
  };
}

async function runTest(
  name: string,
  backend: "claude" | "glm",
  model: string,
  prompt: string,
  extra?: {
    mcpServers?: Record<string, unknown>;
    agents?: Record<string, { description: string; prompt: string; model?: "sonnet" | "opus" | "haiku" | "inherit"; tools?: string[] }>;
    agent?: string;
    maxTurns?: number;
  },
): Promise<void> {
  const start = Date.now();
  console.log(`\n--- ${name} (${backend}/${model}) ---`);

  const envOverride = buildEnv(backend);

  try {
    let resultText = "";
    let cost = 0;
    const toolsUsed: string[] = [];

    for await (const message of query({
      prompt,
      options: {
        model,
        maxTurns: extra?.maxTurns ?? 5,
        permissionMode: "bypassPermissions",
        persistSession: false,
        ...(envOverride ? { env: envOverride } : {}),
        ...(extra?.mcpServers ? { mcpServers: extra.mcpServers as Record<string, never> } : {}),
        ...(extra?.agents ? { agents: extra.agents } : {}),
        ...(extra?.agent ? { agent: extra.agent } : {}),
      },
    })) {
      if (message.type === "assistant" && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === "tool_use" && !toolsUsed.includes(block.name)) {
            toolsUsed.push(block.name);
          }
        }
      }
      if (message.type === "result") {
        resultText = "result" in message ? String(message.result) : "";
        cost = message.total_cost_usd;
      }
    }

    const elapsed = Date.now() - start;
    const preview = resultText.slice(0, 200).replace(/\n/g, " ");
    console.log(`  PASS (${elapsed}ms, $${cost.toFixed(4)})`);
    if (toolsUsed.length > 0) console.log(`  Tools: ${toolsUsed.join(", ")}`);
    console.log(`  Response: ${preview}...`);

    results.push({
      name,
      backend,
      model,
      passed: true,
      result: preview,
      durationMs: elapsed,
      cost,
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL (${elapsed}ms): ${errMsg}`);

    results.push({
      name,
      backend,
      model,
      passed: false,
      error: errMsg,
      durationMs: elapsed,
    });
  }
}

// --- Tests ---

console.log("=== PsiBot Backend Integration Tests ===\n");
console.log(`Claude backend: default (Claude Max plan)`);
console.log(`GLM backend: ${config.GLM_BASE_URL}`);
console.log(`GLM auth: ${config.GLM_AUTH_TOKEN ? "configured" : "MISSING"}`);

// Test 1: Claude Haiku — basic prompt
await runTest(
  "Claude Haiku basic",
  "claude",
  "haiku",
  "Respond with exactly: CLAUDE_HAIKU_OK",
);

// Test 2: Claude Sonnet — basic prompt
await runTest(
  "Claude Sonnet basic",
  "claude",
  "sonnet",
  "Respond with exactly: CLAUDE_SONNET_OK",
);

// Test 3: GLM Haiku (glm-4.7) — basic prompt
if (config.GLM_AUTH_TOKEN) {
  await runTest(
    "GLM Haiku (glm-4.7) basic",
    "glm",
    "haiku",
    "Respond with exactly: GLM_HAIKU_OK",
  );

  // Test 4: GLM Sonnet (glm-5-turbo) — basic prompt
  await runTest(
    "GLM Sonnet (glm-5-turbo) basic",
    "glm",
    "sonnet",
    "Respond with exactly: GLM_SONNET_OK",
  );

  // Test 5: GLM with web search MCP
  await runTest(
    "GLM web search MCP",
    "glm",
    "sonnet",
    "Use the webSearchPrime tool to search for 'Ottawa weather today'. Report the first result title.",
    {
      mcpServers: {
        "web-search-prime": {
          type: "http",
          url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
          headers: {
            Authorization: `Bearer ${config.GLM_AUTH_TOKEN}`,
          },
        },
      },
    },
  );

  // Test 6: GLM with web reader MCP
  await runTest(
    "GLM web reader MCP",
    "glm",
    "sonnet",
    "Use the webReader tool to fetch https://httpbin.org/json and report the 'slideshow.title' value from the response.",
    {
      mcpServers: {
        "web-reader": {
          type: "http",
          url: "https://api.z.ai/api/mcp/web_reader/mcp",
          headers: {
            Authorization: `Bearer ${config.GLM_AUTH_TOKEN}`,
          },
        },
      },
    },
  );
  // Test 7: GLM with --agent flag (agent as main thread)
  await runTest(
    "GLM --agent flag (summarizer agent)",
    "glm",
    "sonnet",
    "Summarize this in one sentence: The quick brown fox jumps over the lazy dog. This is a test of the emergency broadcast system. All your base are belong to us.",
    {
      agent: "summarizer",
      agents: {
        summarizer: {
          description: "Summarizes text concisely",
          prompt: "You are a summarizer. Given any text, respond with a single concise sentence summary. Never use more than one sentence.",
          model: "inherit",
        },
      },
    },
  );

  // Test 8: GLM main agent spawning a subagent
  await runTest(
    "GLM subagent delegation",
    "glm",
    "sonnet",
    'You have a subagent called "fact-checker". Delegate to it by using the Agent tool to ask: "What is 2+2?" Then report its answer.',
    {
      maxTurns: 10,
      agents: {
        "fact-checker": {
          description: "Answers factual questions accurately",
          prompt: "You are a fact checker. Answer questions with precise, factual responses. Keep answers very short.",
          model: "haiku",
        },
      },
    },
  );
} else {
  console.log("\nSkipping GLM tests — GLM_AUTH_TOKEN not set");
}

// Test 9: Claude with --agent flag
await runTest(
  "Claude --agent flag (calculator agent)",
  "claude",
  "haiku",
  "What is 137 * 29?",
  {
    agent: "calculator",
    agents: {
      calculator: {
        description: "Performs mathematical calculations",
        prompt: "You are a calculator. Given a math problem, compute and return the answer. Show your work briefly, then give the final answer.",
        model: "inherit",
        tools: [], // No tools needed, just compute
      },
    },
  },
);

// Test 10: Claude main agent spawning a subagent
await runTest(
  "Claude subagent delegation",
  "claude",
  "sonnet",
  'You have a subagent called "researcher". Use the Agent tool to delegate this task to it: "Read the file package.json and tell me the project name." Then report its finding.',
  {
    maxTurns: 10,
    agents: {
      researcher: {
        description: "Reads files and reports findings",
        prompt: "You are a researcher. Read the requested files and report what you find. Be concise.",
        model: "haiku",
        tools: ["Read", "Glob"],
      },
    },
  },
);

// --- Summary ---
console.log("\n=== Summary ===\n");
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed).length;
console.log(`${passed} passed, ${failed} failed, ${results.length} total\n`);

for (const r of results) {
  const status = r.passed ? "PASS" : "FAIL";
  const detail = r.passed
    ? `${r.durationMs}ms, $${r.cost?.toFixed(4) ?? "?"}`
    : r.error?.slice(0, 100);
  console.log(`  [${status}] ${r.name} (${r.backend}/${r.model}) — ${detail}`);
}

if (failed > 0) {
  process.exit(1);
}
