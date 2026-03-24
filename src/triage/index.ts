import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getConfig } from "../config.ts";
import {
  getPendingItems,
  updatePendingItem,
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("triage");

// --- Types ---

interface ExtractedMetadata {
  title: string | null;
  description: string | null;
  platform: string | null;
  ogImage: string | null;
}

interface TriageResult {
  value_type: "technique" | "tool" | "actionable" | "no_value";
  extracted_value: string;
  priority: number;
  summary: string;
  relevance_signal: string;
  tags: string[];
}

interface TriagedItemSummary {
  title: string;
  url: string;
  value_type: TriageResult["value_type"];
  priority: number;
  extracted_value: string;
}

interface TriageAllResult {
  totalProcessed: number;
  dropped: number;
  items: TriagedItemSummary[];
}

interface DeepAnalysisResult {
  recommendation: "read_now" | "research_deeper" | "skip" | "archive";
  detailedSummary: string;
  relatedNotes: string[];
}

// NotePlan notes are NOT created at triage time.
// Only the research pipeline creates notes after actual research is done.

// --- Tier 0: Metadata Extraction ---

function extractMetaContent(html: string, nameOrProperty: string): string | null {
  // Match <meta name="..." content="..."> or <meta property="..." content="...">
  // Handle both orderings: name/property before or after content
  const patterns = [
    new RegExp(
      `<meta\\s+(?:name|property)=["']${nameOrProperty}["']\\s+content=["']([^"']*)["']`,
      "i"
    ),
    new RegExp(
      `<meta\\s+content=["']([^"']*)["']\\s+(?:name|property)=["']${nameOrProperty}["']`,
      "i"
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1]?.trim() ?? null;
}

function detectPlatform(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.replace("www.", "");
    const platformMap: Record<string, string> = {
      "github.com": "github",
      "reddit.com": "reddit",
      "old.reddit.com": "reddit",
      "x.com": "x",
      "twitter.com": "x",
      "youtube.com": "youtube",
      "youtu.be": "youtube",
      "news.ycombinator.com": "hackernews",
      "arxiv.org": "arxiv",
      "medium.com": "medium",
      "dev.to": "devto",
      "stackoverflow.com": "stackoverflow",
      "npmjs.com": "npm",
    };
    return platformMap[hostname] ?? hostname;
  } catch {
    return null;
  }
}

export async function extractMetadata(url: string): Promise<ExtractedMetadata> {
  const result: ExtractedMetadata = {
    title: null,
    description: null,
    platform: detectPlatform(url),
    ogImage: null,
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; PsiBot/1.0; +https://github.com/psibot)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn("Metadata fetch failed", { url, status: response.status });
      return result;
    }

    // Read first 64KB — enough for <head> section
    const reader = response.body?.getReader();
    if (!reader) return result;

    let html = "";
    const decoder = new TextDecoder();
    const MAX_BYTES = 65_536;
    let bytesRead = 0;

    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }

    reader.cancel().catch(() => {});

    // Extract metadata from HTML
    result.title =
      extractMetaContent(html, "og:title") ??
      extractMetaContent(html, "twitter:title") ??
      extractTitle(html);

    result.description =
      extractMetaContent(html, "og:description") ??
      extractMetaContent(html, "description") ??
      extractMetaContent(html, "twitter:description");

    result.ogImage =
      extractMetaContent(html, "og:image") ??
      extractMetaContent(html, "twitter:image");

    log.info("Metadata extracted", { url, title: result.title?.slice(0, 60) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Metadata extraction error", { url, error: message });
  }

  return result;
}

// --- Rich Content Extraction (Tier 0.5 — at triage time) ---

interface RichContent {
  bodyText: string;
  topComments: string[];
  subreddit: string | null;
  linkedUrl: string | null;
  linkedContent: string | null;
}

/** Strip HTML tags and decode entities, returning clean text */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fetch Reddit post content via JSON API */
async function fetchRedditContent(url: string): Promise<RichContent> {
  const result: RichContent = {
    bodyText: "",
    topComments: [],
    subreddit: null,
    linkedUrl: null,
    linkedContent: null,
  };

  try {
    // Convert any reddit URL to a .json endpoint
    let jsonUrl = url.replace(/\/$/, "");
    // Handle gallery URLs: /gallery/ID → /comments/ID
    if (jsonUrl.includes("/gallery/")) {
      const galleryId = jsonUrl.split("/gallery/").pop();
      jsonUrl = `https://www.reddit.com/comments/${galleryId}`;
    }
    if (!jsonUrl.endsWith(".json")) jsonUrl += ".json";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(jsonUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": `PsiBot:v2.0 (by /u/${process.env.REDDIT_USERNAME ?? "bot"})`,
        Accept: "application/json",
      },
      redirect: "follow",
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      log.warn("Reddit JSON fetch failed", { url, status: res.status });
      return result;
    }

    const json = await res.json() as Array<{ data: { children: Array<{ data: Record<string, unknown> }> } }>;

    // First listing = post
    const post = json[0]?.data?.children?.[0]?.data;
    if (post) {
      result.subreddit = (post.subreddit as string) ?? null;
      result.bodyText = (post.selftext as string) ?? "";

      // Check if this is a link post pointing to external content
      const postUrl = post.url as string | undefined;
      const permalink = post.permalink as string | undefined;
      if (postUrl && permalink && !postUrl.includes("reddit.com") && !postUrl.includes("redd.it")) {
        result.linkedUrl = postUrl;
      }
    }

    // Second listing = comments — grab top 5 by score
    const comments = json[1]?.data?.children ?? [];
    const topComments = comments
      .filter((c: { data: Record<string, unknown> }) => c.data.body && typeof c.data.body === "string")
      .slice(0, 5)
      .map((c: { data: Record<string, unknown> }) => {
        const body = (c.data.body as string).slice(0, 300);
        const author = c.data.author as string ?? "anon";
        const score = c.data.score as number ?? 0;
        return `u/${author} (${score}pts): ${body}`;
      });
    result.topComments = topComments;

    // If there's a linked URL, try to fetch its content
    if (result.linkedUrl) {
      try {
        result.linkedContent = await fetchPageText(result.linkedUrl);
      } catch {
        log.warn("Failed to fetch linked content", { linkedUrl: result.linkedUrl });
      }
    }
  } catch (err) {
    log.warn("Reddit content fetch failed", { url, error: String(err) });
  }

  return result;
}

/** Fetch page body text for non-Reddit URLs */
async function fetchPageText(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; PsiBot/1.0)",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(timeoutId);

    if (!res.ok) return "";

    const reader = res.body?.getReader();
    if (!reader) return "";

    let html = "";
    const decoder = new TextDecoder();
    const MAX_BYTES = 100_000;
    let bytesRead = 0;

    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    reader.cancel().catch(() => {});

    const text = stripHtml(html);
    return text.slice(0, 3000);
  } catch {
    return "";
  }
}

/** Fetch rich content for any pending item */
async function fetchRichContent(item: PendingItem): Promise<RichContent> {
  const isReddit = item.platform === "reddit" || item.url.includes("reddit.com");

  if (isReddit) {
    return fetchRedditContent(item.url);
  }

  // For non-Reddit URLs, just fetch page text
  const bodyText = await fetchPageText(item.url);
  return {
    bodyText,
    topComments: [],
    subreddit: null,
    linkedUrl: null,
    linkedContent: null,
  };
}

// --- Interests Loader ---

function loadInterests(): string {
  // import.meta.path = .../src/triage/index.ts
  // Go up 3 levels: index.ts -> triage/ -> src/ -> project root
  const projectRoot = dirname(dirname(dirname(import.meta.path)));
  const interestsPath = join(projectRoot, "knowledge/INTERESTS.md");
  try {
    return readFileSync(interestsPath, "utf-8");
  } catch {
    log.warn("Could not load INTERESTS.md", { path: interestsPath });
    return "No interest profile available.";
  }
}

// --- Workflow Manifest Loader ---

function loadWorkflowManifest(): string {
  const projectRoot = dirname(dirname(dirname(import.meta.path)));
  const manifestPath = join(projectRoot, "knowledge/WORKFLOW.md");
  try {
    return readFileSync(manifestPath, "utf-8");
  } catch {
    log.warn("Could not load WORKFLOW.md", { path: manifestPath });
    return "No workflow manifest available.";
  }
}

// --- GLM query helper ---

async function queryGlm(prompt: string): Promise<string> {
  const config = getConfig();

  if (!config.GLM_AUTH_TOKEN) {
    throw new Error("GLM_AUTH_TOKEN not configured — cannot run GLM triage");
  }

  const envOverride: Record<string, string> = {
    ...process.env as Record<string, string>,
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.GLM_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.GLM_OPUS_MODEL,
  };

  let response = "";
  for await (const msg of query({
    prompt,
    options: {
      model: "haiku",
      maxTurns: 1,
      permissionMode: "bypassPermissions",
      env: envOverride,
    },
  })) {
    if (msg.type === "assistant" && msg.message) {
      response += msg.message.content
        .map((block: { type: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : ""
        )
        .join("");
    } else if (msg.type === "result") {
      log.info("GLM query complete", {
        turns: msg.num_turns,
        durationMs: msg.duration_ms,
        cost: msg.total_cost_usd?.toFixed(6),
      });
    }
  }

  return response;
}

// --- Claude query helper ---

async function queryClaude(prompt: string): Promise<string> {
  let response = "";
  for await (const msg of query({
    prompt,
    options: {
      model: "claude-sonnet-4-5-20250929",
      maxTurns: 1,
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
      log.info("Claude query complete", {
        turns: msg.num_turns,
        durationMs: msg.duration_ms,
        cost: msg.total_cost_usd?.toFixed(6),
      });
    }
  }

  return response;
}

// --- JSON extraction helper ---

function extractJson<T>(text: string): T | null {
  // Try markdown code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {
      // fall through
    }
  }

  // Try raw JSON (find first { and match to closing })
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

// --- Tier 1: GLM Triage (with rich content extraction) ---

export async function triageItem(item: PendingItem): Promise<TriageResult> {
  const interests = loadInterests();

  // Fetch actual content before triaging
  log.info("Fetching rich content", { id: item.id, url: item.url });
  const content = await fetchRichContent(item);

  // Build content section for the prompt
  const contentParts: string[] = [];
  if (content.bodyText) {
    contentParts.push(`### Post/Page Content\n${content.bodyText.slice(0, 2000)}`);
  }
  if (content.topComments.length > 0) {
    contentParts.push(`### Top Comments\n${content.topComments.join("\n\n")}`);
  }
  if (content.linkedContent) {
    contentParts.push(`### Linked Article Content\n${content.linkedContent.slice(0, 1500)}`);
  }
  if (content.linkedUrl) {
    contentParts.push(`### Linked URL: ${content.linkedUrl}`);
  }
  const contentText = contentParts.length > 0
    ? contentParts.join("\n\n")
    : "No content could be extracted.";

  const workflowManifest = loadWorkflowManifest();

  const prompt = `You are a value-extraction triage agent. Your job is NOT to categorize content — it is to extract the transferable value from this item.

The default assumption is: "there's something useful here, since the user saved it." Only mark as no_value if there is genuinely nothing transferable (pure joke, meme with no technique, spam).

## Item
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Description: ${item.description ?? "none"}
- Platform: ${item.platform ?? "unknown"}
- Source: ${item.source}
${item.profile ? `- Profile/Subreddit: ${item.profile}` : ""}

## Content
${contentText}

## User Workflow Manifest
${workflowManifest}

## User Interest Profile
${interests}

## Instructions

Analyze the ACTUAL CONTENT (not just the title) and extract the transferable value — the technique, method, tool, pattern, or insight that exists regardless of how the content is framed.

Return a JSON object:
- "value_type": one of "technique" (prompting pattern, CLI workflow, config trick, image/video method), "tool" (framework, library, CLI tool, service to evaluate), "actionable" (needs response, time-sensitive, decision needed), "no_value" (genuinely nothing transferable)
- "extracted_value": 1-2 sentences describing the specific transferable nugget. NOT a summary of the content — the actual technique, tool, or actionable item. Example: "JSON prompting technique for structured image generation using nested scene descriptions" NOT "Reddit post about AI image generation"
- "priority": 1-5 based on relevance to active projects and workflow gaps in the manifest (1 = directly addresses a listed gap, 2 = relevant to active project, 3 = matches interests, 4 = tangentially useful, 5 = no value)
- "summary": 2-3 sentence summary with specific details from the content
- "relevance_signal": 1 sentence explaining the connection to the user's workflow, projects, or interests. If no connection, say "No direct connection to current workflow"
- "tags": array of relevant tags (include subreddit if Reddit, platform, topic keywords)

If content could not be extracted or is empty/inaccessible, set value_type to "no_value".

Return ONLY the JSON object.

\`\`\`json
{
  "value_type": "...",
  "extracted_value": "...",
  "priority": ...,
  "summary": "...",
  "relevance_signal": "...",
  "tags": ["..."]
}
\`\`\``;

  const response = await queryGlm(prompt);
  const parsed = extractJson<TriageResult>(response);

  if (!parsed) {
    log.error("Failed to parse triage response", {
      itemId: item.id,
      response: response.slice(0, 300),
    });
    return {
      value_type: "tool",
      extracted_value: "Triage parsing failed - needs manual review.",
      priority: 3,
      summary: "Triage parsing failed.",
      relevance_signal: "Unknown",
      tags: [],
    };
  }

  const validValueTypes = ["technique", "tool", "actionable", "no_value"] as const;
  const value_type = validValueTypes.includes(parsed.value_type as typeof validValueTypes[number])
    ? parsed.value_type
    : "tool";

  const priority = Number.isFinite(parsed.priority)
    ? Math.max(1, Math.min(5, Math.round(parsed.priority)))
    : 3;

  return {
    value_type,
    extracted_value: parsed.extracted_value ?? "No value extracted.",
    priority,
    summary: parsed.summary ?? "No summary available.",
    relevance_signal: parsed.relevance_signal ?? "Unknown",
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}

// --- Batch triage ---

const NOTEPLAN_INBOX = join(homedir(), "Documents/NotePlan-Notes/Notes/00 - Inbox");

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function createInboxNote(
  item: PendingItem,
  result: TriageResult
): string | null {
  try {
    if (!existsSync(NOTEPLAN_INBOX)) {
      mkdirSync(NOTEPLAN_INBOX, { recursive: true });
    }

    const title = item.title ?? new URL(item.url).hostname;
    const safeTitle = sanitizeFilename(title);
    const filePath = join(NOTEPLAN_INBOX, `${safeTitle}.md`);

    // Don't overwrite existing notes
    if (existsSync(filePath)) {
      return filePath;
    }

    const valueLabel = result.value_type === "technique" ? "Technique"
      : result.value_type === "tool" ? "Tool"
      : result.value_type === "actionable" ? "Action"
      : "Item";

    const tags = result.tags.length > 0
      ? result.tags.map((t) => `  - ${t}`).join("\n")
      : "  - inbox";

    const lines = [
      "---",
      `title: "${safeTitle}"`,
      `created: ${new Date().toISOString().slice(0, 10)}`,
      `type: ${valueLabel.toLowerCase()}`,
      `priority: ${result.priority}`,
      `source: ${item.source}`,
      `platform: ${item.platform ?? "unknown"}`,
      "tags:",
      tags,
      "  - psibot-triage",
      "---",
      "",
      `# ${title}`,
      "",
      `**${valueLabel}** (P${result.priority}) | [Source](${item.url})`,
      "",
      result.extracted_value,
      "",
      `> ${result.summary}`,
      "",
      result.relevance_signal !== "Unknown"
        ? `**Relevance:** ${result.relevance_signal}`
        : "",
    ].filter((l) => l !== "").join("\n");

    writeFileSync(filePath, lines + "\n", "utf-8");
    log.info("Inbox note created", { path: filePath });
    return filePath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to create inbox note", { itemId: item.id, error: message });
    return null;
  }
}

export async function triageBatch(items: PendingItem[]): Promise<TriagedItemSummary[]> {
  log.info("Starting batch triage", { count: items.length });
  const summaries: TriagedItemSummary[] = [];

  for (const item of items) {
    try {
      log.info("Triaging item", { id: item.id, url: item.url });
      const result = await triageItem(item);

      const isDropped = result.value_type === "no_value";

      // Create inbox note for non-dropped items
      let noteplanPath: string | null = null;
      if (!isDropped) {
        noteplanPath = createInboxNote(item, result);
      }

      // Update the database record
      updatePendingItem(item.id, {
        status: isDropped ? "deleted" : "triaged",
        priority: result.priority,
        category: result.value_type,
        triage_summary: result.summary,
        value_type: result.value_type,
        extracted_value: result.extracted_value,
        noteplan_path: noteplanPath,
      });

      summaries.push({
        title: item.title ?? new URL(item.url).hostname,
        url: item.url,
        value_type: result.value_type,
        priority: result.priority,
        extracted_value: result.extracted_value,
      });

      log.info("Item triaged", {
        id: item.id,
        priority: result.priority,
        value_type: result.value_type,
        tags: result.tags.join(", "),
        noteplanPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Triage failed for item", { id: item.id, error: message });
    }
  }

  log.info("Batch triage complete", { count: items.length });
  return summaries;
}

// --- Tier 2: Deep Analysis ---

export async function deepAnalyze(item: PendingItem): Promise<DeepAnalysisResult> {
  const interests = loadInterests();

  const prompt = `You are a deep content analyst. Perform a thorough analysis of this item for the user's morning brief.

## Item
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Description: ${item.description ?? "none"}
- Platform: ${item.platform ?? "unknown"}
- Source: ${item.source}
- Triage Summary: ${item.triage_summary ?? "none"}
- Category: ${item.category ?? "unknown"}
- Priority: ${item.priority ?? "unset"}

## User Interest Profile
${interests}

## Instructions
Provide a deep analysis. Return a JSON object with:
- "recommendation": one of "read_now" (drop everything), "research_deeper" (queue for focused research session), "skip" (not worth the time), "archive" (save for later reference)
- "detailedSummary": 3-5 sentence detailed summary explaining the content, its significance, and how it relates to the user's interests
- "relatedNotes": array of NotePlan wikilinks to potentially related notes (e.g., ["[[AI Agents]]", "[[Claude Code]]"]) — suggest based on the content themes and user interests

Return ONLY the JSON object.

\`\`\`json
{
  "recommendation": "...",
  "detailedSummary": "...",
  "relatedNotes": ["[[...]]"]
}
\`\`\``;

  const response = await queryClaude(prompt);
  const parsed = extractJson<DeepAnalysisResult>(response);

  if (!parsed) {
    log.error("Failed to parse deep analysis response", {
      itemId: item.id,
      response: response.slice(0, 300),
    });
    return {
      recommendation: "archive",
      detailedSummary: "Deep analysis parsing failed — manual review needed.",
      relatedNotes: [],
    };
  }

  // Validate recommendation
  const validRecommendations = [
    "read_now",
    "research_deeper",
    "skip",
    "archive",
  ] as const;
  const recommendation = validRecommendations.includes(
    parsed.recommendation as (typeof validRecommendations)[number]
  )
    ? (parsed.recommendation as (typeof validRecommendations)[number])
    : ("archive" as const);

  return {
    recommendation,
    detailedSummary: parsed.detailedSummary ?? "No detailed summary available.",
    relatedNotes: Array.isArray(parsed.relatedNotes) ? parsed.relatedNotes : [],
  };
}

// NotePlan note creation removed — notes are only created by the research pipeline after actual research.

// --- Convenience: triage all pending items ---

export async function triageAllPending(limit?: number): Promise<TriageAllResult> {
  const batchSize = 10;
  const maxItems = limit ?? 50;
  const allItems: TriagedItemSummary[] = [];

  while (allItems.length < maxItems) {
    const remaining = maxItems - allItems.length;
    const pending = getPendingItems("pending", Math.min(batchSize, remaining));
    if (pending.length === 0) {
      if (allItems.length === 0) log.info("No pending items to triage");
      break;
    }

    const batchSummaries = await triageBatch(pending);
    allItems.push(...batchSummaries);
    log.info("Triage batch complete", { batchProcessed: pending.length, totalProcessed: allItems.length });
  }

  const dropped = allItems.filter((i) => i.value_type === "no_value").length;
  return { totalProcessed: allItems.length, dropped, items: allItems };
}

// --- Convenience: deep analyze high-priority items ---

export async function deepAnalyzeHighPriority(): Promise<number> {
  const triaged = getPendingItems("triaged", 50);
  const highPriority = triaged.filter(
    (item) => item.priority !== null && item.priority <= 2
  );

  if (highPriority.length === 0) {
    log.info("No high-priority items for deep analysis");
    return 0;
  }

  log.info("Starting deep analysis", { count: highPriority.length });

  for (const item of highPriority) {
    try {
      const analysis = await deepAnalyze(item);
      log.info("Deep analysis complete", {
        id: item.id,
        recommendation: analysis.recommendation,
        relatedNotes: analysis.relatedNotes.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("Deep analysis failed", { id: item.id, error: message });
    }
  }

  return highPriority.length;
}

export type { ExtractedMetadata, TriageResult, DeepAnalysisResult };
