import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfig } from "../config.ts";
import { getPendingItems, updatePendingItem } from "../db/queries.ts";
import { getGlmMcpServers } from "../agent/glm-mcp.ts";
import { createLogger } from "../shared/logger.ts";
import type { PendingItem } from "../shared/types.ts";
import { linkToExistingResearch } from "./knowledge-linker.ts";

const log = createLogger("research");
const NOTEPLAN_BASE = join(
  process.env.HOME ?? "/tmp",
  "Documents/NotePlan-Notes/Notes"
);

// --- Types ---

interface ResearchResult {
  title: string;
  summary: string;
  keyFindings: string[];
  relevance: string;
  suggestedActions: string[];
  sources: string[];
  notePlanContent: string;
}

// --- Interests Loader ---

function loadInterests(): string {
  const projectRoot = dirname(dirname(dirname(import.meta.path)));
  const interestsPath = join(projectRoot, "knowledge/INTERESTS.md");
  try {
    return readFileSync(interestsPath, "utf-8");
  } catch {
    log.warn("Could not load INTERESTS.md", { path: interestsPath });
    return "No interest profile available.";
  }
}

// --- JSON extraction helper ---

function extractJson<T>(text: string): T | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {
      // fall through
    }
  }

  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          try {
            return JSON.parse(text.slice(firstBrace, i + 1)) as T;
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}

// --- Filename sanitizer ---

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

// --- GLM query helper with MCP servers ---

async function queryGlmWithTools(prompt: string, maxTurns: number): Promise<string> {
  const config = getConfig();

  if (!config.GLM_AUTH_TOKEN) {
    throw new Error("GLM_AUTH_TOKEN not configured -- cannot run GLM research");
  }

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
  for await (const msg of query({
    prompt,
    options: {
      model: "sonnet",
      maxTurns,
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
    } else if (msg.type === "result") {
      log.info("GLM research query complete", {
        turns: msg.num_turns,
        durationMs: msg.duration_ms,
        cost: msg.total_cost_usd?.toFixed(6),
      });
    }
  }

  return response;
}

// --- Claude query helper ---

async function queryClaude(prompt: string, maxTurns: number): Promise<string> {
  let response = "";
  for await (const msg of query({
    prompt,
    options: {
      model: "claude-sonnet-4-5-20250929",
      maxTurns,
      permissionMode: "bypassPermissions",
    },
  })) {
    if (msg.type === "assistant" && msg.message) {
      response += msg.message.content
        .map((block: { type: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : ""
        )
        .join("");
    } else if (msg.type === "result") {
      log.info("Claude research query complete", {
        turns: msg.num_turns,
        durationMs: msg.duration_ms,
        cost: msg.total_cost_usd?.toFixed(6),
      });
    }
  }

  return response;
}

// --- Build NotePlan content ---

function buildNotePlanContent(
  item: PendingItem,
  research: ResearchResult
): string {
  const today = new Date().toISOString().split("T")[0];
  const title = research.title || item.title || "Untitled Research";

  const tags = ["research"];
  if (item.platform) {
    tags.push(item.platform);
  }
  const tagsYaml = tags.map((t) => `  - ${t}`).join("\n");

  const keyFindings = research.keyFindings
    .map((f) => `- ${f}`)
    .join("\n");

  const suggestedActions = research.suggestedActions
    .map((a) => `- ${a}`)
    .join("\n");

  const sources = research.sources
    .map((s) => `- ${s}`)
    .join("\n");

  return `---
title: ${title.replace(/:/g, " -")}
url: ${item.url}
source: ${item.source}
researched: ${today}
priority: ${item.priority ?? 3}
tags:
${tagsYaml}
---

# ${title}

## Summary
${research.summary}

## Key Findings
${keyFindings}

## Relevance
${research.relevance}

## Suggested Actions
${suggestedActions}

## Sources
${sources}

---
*Research generated by PsiBot on ${today}*
`;
}

// --- Parse research response into structured result ---

function parseResearchResponse(
  raw: string,
  item: PendingItem,
  fallbackTitle: string
): ResearchResult {
  const parsed = extractJson<{
    title?: string;
    summary?: string;
    keyFindings?: string[];
    key_findings?: string[];
    relevance?: string;
    suggestedActions?: string[];
    suggested_actions?: string[];
    sources?: string[];
  }>(raw);

  const title = parsed?.title ?? fallbackTitle;
  const summary = parsed?.summary ?? raw.slice(0, 500);
  const keyFindings = parsed?.keyFindings ?? parsed?.key_findings ?? [];
  const relevance = parsed?.relevance ?? "Relevance could not be determined.";
  const suggestedActions = parsed?.suggestedActions ?? parsed?.suggested_actions ?? [];
  const sources = parsed?.sources ?? (item.url ? [item.url] : []);

  const result: ResearchResult = {
    title,
    summary,
    keyFindings,
    relevance,
    suggestedActions,
    sources,
    notePlanContent: "",
  };

  result.notePlanContent = buildNotePlanContent(item, result);
  return result;
}

// --- Public API ---

/** Preliminary research using GLM (cheap) with web search MCP tools */
export async function preliminaryResearch(item: PendingItem): Promise<ResearchResult> {
  const interests = loadInterests();
  const fallbackTitle = item.title ?? new URL(item.url).pathname.split("/").pop() ?? "Untitled";

  const prompt = `You are a research assistant. Research the following topic using web search tools.

## Item to Research
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Description: ${item.description ?? "none"}
- Platform: ${item.platform ?? "unknown"}
- Triage Summary: ${item.triage_summary ?? "none"}

## User Interest Profile
${interests}

## Instructions
1. Use webSearchPrime to search for recent information about this topic
2. Use webReader to read the most relevant pages (2-3 pages max)
3. Synthesize your findings into a structured research summary

Return a JSON object with these fields:
- "title": A clear, descriptive title for this research
- "summary": 3-5 sentence overview of the topic and findings
- "keyFindings": Array of 3-7 bullet point strings with key facts/insights
- "relevance": 1-2 sentences on why this matters to the user based on their interests
- "suggestedActions": Array of 1-3 concrete actions the user could take
- "sources": Array of URLs you referenced

Return ONLY the JSON object after completing your research.

\`\`\`json
{
  "title": "...",
  "summary": "...",
  "keyFindings": ["...", "..."],
  "relevance": "...",
  "suggestedActions": ["...", "..."],
  "sources": ["...", "..."]
}
\`\`\``;

  log.info("Starting preliminary research", { itemId: item.id, url: item.url });

  // Try GLM first, fallback to Claude on failure
  let response: string;
  try {
    response = await queryGlmWithTools(prompt, 10);
  } catch (err) {
    log.warn("GLM research failed, falling back to Claude", {
      itemId: item.id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      response = await queryClaude(prompt, 10);
    } catch (err2) {
      log.error("Claude research fallback also failed", {
        itemId: item.id,
        error: err2 instanceof Error ? err2.message : String(err2),
      });
      throw err2;
    }
  }

  const result = parseResearchResponse(response, item, fallbackTitle);

  log.info("Preliminary research complete", {
    itemId: item.id,
    title: result.title,
    findingsCount: result.keyFindings.length,
    sourcesCount: result.sources.length,
  });

  return result;
}

/** Full deep research using Claude (expensive, after user approval) */
export async function deepResearch(item: PendingItem): Promise<ResearchResult> {
  const interests = loadInterests();
  const fallbackTitle = item.title ?? new URL(item.url).pathname.split("/").pop() ?? "Untitled";

  const prompt = `You are an expert research analyst. Perform a comprehensive analysis of the following topic.

## Item to Research
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Description: ${item.description ?? "none"}
- Platform: ${item.platform ?? "unknown"}
- Triage Summary: ${item.triage_summary ?? "none"}
- Category: ${item.category ?? "unknown"}
- Priority: ${item.priority ?? "unset"}

## User Interest Profile
${interests}

## Instructions
Provide a thorough, detailed research analysis. Consider:
- What is this about and why is it significant?
- How does it connect to the user's interests and ongoing work?
- What are the key technical details or insights?
- What are the implications or potential applications?
- Are there related topics or resources worth exploring?

Return a JSON object with these fields:
- "title": A clear, descriptive title for this research
- "summary": 3-5 sentence comprehensive overview
- "keyFindings": Array of 5-10 detailed bullet point strings
- "relevance": 2-3 sentences on specific connections to user interests
- "suggestedActions": Array of 2-5 concrete, actionable next steps
- "sources": Array of relevant URLs (include the original URL)

Return ONLY the JSON object.

\`\`\`json
{
  "title": "...",
  "summary": "...",
  "keyFindings": ["...", "..."],
  "relevance": "...",
  "suggestedActions": ["...", "..."],
  "sources": ["...", "..."]
}
\`\`\``;

  log.info("Starting deep research", { itemId: item.id, url: item.url });

  // Try Claude first, fallback to GLM on failure
  let response: string;
  try {
    response = await queryClaude(prompt, 15);
  } catch (err) {
    log.warn("Claude deep research failed, falling back to GLM", {
      itemId: item.id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      response = await queryGlmWithTools(prompt, 15);
    } catch (err2) {
      log.error("GLM deep research fallback also failed", {
        itemId: item.id,
        error: err2 instanceof Error ? err2.message : String(err2),
      });
      throw err2;
    }
  }

  const result = parseResearchResponse(response, item, fallbackTitle);

  log.info("Deep research complete", {
    itemId: item.id,
    title: result.title,
    findingsCount: result.keyFindings.length,
    sourcesCount: result.sources.length,
  });

  return result;
}

/** Get triaged items that are queued for research (category=research, priority<=2) */
export function queueResearchItems(): PendingItem[] {
  const triaged = getPendingItems("triaged", 50);
  const researchItems = triaged.filter(
    (item) =>
      item.category === "research" &&
      item.priority !== null &&
      item.priority <= 2
  );

  log.info("Queued research items", {
    totalTriaged: triaged.length,
    researchCount: researchItems.length,
  });

  return researchItems.sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5));
}

/** Create a NotePlan research note from research results. Returns the file path. */
export function createResearchNote(
  item: PendingItem,
  research: ResearchResult
): string | null {
  const title = research.title || item.title || "Untitled Research";
  const sanitizedTitle = sanitizeFilename(title);
  const folderPath = join(NOTEPLAN_BASE, "70 - Research/completed");
  const filePath = join(folderPath, `${sanitizedTitle}.md`);

  const content = research.notePlanContent || buildNotePlanContent(item, research);

  // Retry up to 3 times with increasing delay
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!existsSync(folderPath)) {
        mkdirSync(folderPath, { recursive: true });
      }
      writeFileSync(filePath, content, "utf-8");

      // Verify the file was written
      if (!existsSync(filePath)) {
        throw new Error("File was not created after writeFileSync");
      }

      // Link to existing research notes (non-critical, don't fail on this)
      try {
        const keywords = research.keyFindings
          .flatMap((f) => f.split(/\s+/).filter((w) => w.length > 5))
          .slice(0, 10);

        const links = linkToExistingResearch(title, filePath, keywords);
        if (links.wikilinks.length > 0) {
          const relatedSection = `\n\n## Related\n${links.wikilinks.map((l) => `- ${l}`).join("\n")}\n`;
          appendFileSync(filePath, relatedSection, "utf-8");
          log.info("Knowledge links added", {
            note: title,
            linkedTo: links.linkedNotes.length,
          });
        }
      } catch (linkErr) {
        log.warn("Knowledge linking failed (note still created)", {
          itemId: item.id,
          error: linkErr instanceof Error ? linkErr.message : String(linkErr),
        });
      }

      log.info("Research note created", { path: filePath, title, itemId: item.id });

      // Update the pending item with the noteplan path
      updatePendingItem(item.id, { noteplan_path: filePath });

      return filePath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Failed to create research note", {
        path: filePath,
        error: message,
        itemId: item.id,
        attempt,
      });
      if (attempt < 3) {
        // Brief pause before retry
        Bun.sleepSync(500 * attempt);
      }
    }
  }

  log.error("Research note creation failed after 3 attempts", {
    itemId: item.id,
    title,
    url: item.url,
  });
  return null;
}

export type { ResearchResult };
