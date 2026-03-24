import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { getGlmMcpServers } from "../agent/glm-mcp.ts";
import { createLogger } from "../shared/logger.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("research:quick-scan");

export interface QuickScanResult {
  summary: string;
  notable: boolean;
  signals: string[];
}

/**
 * Quick scan: GLM + web search/zread to enrich a triaged item
 * with 3-5 sentences of external context. Fast (~5-10s per item).
 */
export async function quickScan(item: PendingItem): Promise<QuickScanResult> {
  const config = getConfig();

  if (!config.GLM_AUTH_TOKEN) {
    return { summary: "", notable: false, signals: [] };
  }

  const isGitHub = item.url.includes("github.com");
  const repoMatch = isGitHub ? item.url.match(/github\.com\/([^/]+\/[^/]+)/) : null;
  const repoSlug = repoMatch ? repoMatch[1] : null;

  const toolInstructions = repoSlug
    ? `Use the zread search_doc tool to look up "${repoSlug}" — get stars, recent issues, documentation summary, and project activity. Also use get_repo_structure to understand the project layout.`
    : `Use webSearchPrime to search for "${item.title ?? item.url}" and get recent context: what it is, how popular/notable, any red flags or standout features.`;

  const prompt = `You are a quick research scanner. Produce a concise enrichment of this item.

## Item
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Platform: ${item.platform ?? "unknown"}
- Triage Value: ${item.extracted_value ?? item.triage_summary ?? "none"}

## Instructions
${toolInstructions}

Then return a JSON object:
- "summary": 3-5 sentences of external context. Include specific numbers (stars, downloads, release date). Mention competitors or alternatives if relevant. Be factual, not promotional.
- "notable": true if this stands out (>1k stars, rapid growth, security advisory, addresses a known gap), false otherwise
- "signals": array of signal strings detected, e.g. ["matches-dependency:grammy", "rapid-growth", "security-advisory", "addresses-workflow-gap:browser-automation"]

Return ONLY the JSON object.`;

  const envOverride: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.GLM_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.GLM_OPUS_MODEL,
  };

  const glmServers = getGlmMcpServers();

  let response = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 8,
        permissionMode: "bypassPermissions",
        env: envOverride,
        mcpServers: glmServers as Record<string, ReturnType<typeof getGlmMcpServers>[string]>,
      },
    })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? (block.text ?? "") : ""
          )
          .join("");
      }
    }
  } catch (err) {
    log.error("Quick scan query failed", { itemId: item.id, error: String(err) });
    return { summary: "", notable: false, signals: [] };
  }

  // Parse JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn("Quick scan returned no JSON", { itemId: item.id });
    return { summary: response.slice(0, 500), notable: false, signals: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as QuickScanResult;
    return {
      summary: parsed.summary ?? "",
      notable: parsed.notable ?? false,
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    };
  } catch {
    log.warn("Quick scan JSON parse failed", { itemId: item.id });
    return { summary: response.slice(0, 500), notable: false, signals: [] };
  }
}

/**
 * Run quick scans in parallel on a batch of items.
 * Returns items with their scan results.
 */
export async function quickScanBatch(
  items: PendingItem[],
  concurrency: number = 3
): Promise<Map<number, QuickScanResult>> {
  const results = new Map<number, QuickScanResult>();

  // Process in chunks to limit concurrency
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        const result = await quickScan(item);
        return { id: item.id, result };
      })
    );
    for (const { id, result } of chunkResults) {
      results.set(id, result);
    }
  }

  return results;
}
