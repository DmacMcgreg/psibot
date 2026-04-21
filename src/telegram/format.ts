import telegramifyMarkdown from "telegramify-markdown";

const MAX_MESSAGE_LENGTH = 4096;

/**
 * Escape all MarkdownV2 special characters so text renders as-is in Telegram.
 * Use for static bot strings (commands, notifications, status messages).
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert Markdown tables to monospace code blocks since Telegram has no table support.
 * Detects table blocks (header row + separator + data rows) and wraps them in ```.
 */
function convertTablesToCodeBlocks(text: string): string {
  // Match table blocks: header | sep | rows, possibly with leading/trailing blank lines
  const tablePattern = /(?:^|\n)((?:\|[^\n]+\|\s*\n)(?:\|[-| :]+\|\s*\n)((?:\|[^\n]+\|\s*\n?)*))/g;
  return text.replace(tablePattern, (match, table: string) => {
    // Strip the leading newline from the match, wrap table in code block
    const trimmed = table.trimEnd();
    return `\n\`\`\`\n${trimmed}\n\`\`\`\n`;
  });
}

/**
 * Convert inline HTML tags (from agent output) to standard Markdown equivalents.
 * Agents sometimes output HTML formatting instead of Markdown; this ensures
 * it gets properly rendered when sent through the MarkdownV2 pipeline.
 */
function convertHtmlToMarkdown(text: string): string {
  return text
    .replace(/<b>(.*?)<\/b>/gs, "**$1**")
    .replace(/<strong>(.*?)<\/strong>/gs, "**$1**")
    .replace(/<i>(.*?)<\/i>/gs, "*$1*")
    .replace(/<em>(.*?)<\/em>/gs, "*$1*")
    .replace(/<code>(.*?)<\/code>/gs, "`$1`")
    .replace(/<pre>(.*?)<\/pre>/gs, "```\n$1\n```")
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gs, "[$2]($1)")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?p>/gi, "\n");
}

/**
 * Convert standard Markdown (from Claude agent output) to Telegram MarkdownV2.
 * Preserves formatting: bold, italic, code blocks, lists, links, headers.
 * Converts tables to monospace code blocks (Telegram has no native table support).
 * Pre-processes HTML tags to Markdown equivalents before conversion.
 * Use for agent responses that contain intentional Markdown formatting.
 */
export function markdownToTelegramV2(text: string): string {
  const withMarkdown = convertHtmlToMarkdown(text);
  const withCodeTables = convertTablesToCodeBlocks(withMarkdown);
  return telegramifyMarkdown(withCodeTables, "escape");
}

export function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 2) {
      // Try to split at a space
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt === -1 || splitAt < MAX_MESSAGE_LENGTH / 2) {
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export function formatCost(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Format "current prompt tokens / context window (N%)" for display.
 * Returns empty string if we don't have both numbers.
 *
 * `promptTokens` is the LAST-turn prompt size (see AgentRunResult.promptTokens) —
 * the true current context state. Do NOT use cumulative `inputTokens + cacheReadTokens`
 * here: on multi-turn runs it over-counts and can exceed 100%.
 */
export function formatContextUsage(promptTokens: number, contextWindow: number): string {
  if (!promptTokens || !contextWindow) return "";
  const pct = Math.round((100 * promptTokens) / contextWindow);
  return `${formatTokenCount(promptTokens)}/${formatTokenCount(contextWindow)} ctx (${pct}%)`;
}

export function formatRunMeta(result: { sessionId: string; costUsd: number; durationMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; contextWindow: number; promptTokens?: number; numTurns: number; stopReason?: string }, verbose: boolean): string {
  const base = `${formatCost(result.costUsd)} / ${formatDuration(result.durationMs)}`;
  const shortSession = result.sessionId.slice(0, 8);

  const stopLabels: Record<string, string> = {
    max_turns: "hit turn limit",
    budget_exceeded: "hit budget limit",
    stale_timeout: "timed out",
    message_limit: "hit message limit",
    interrupted: "interrupted",
  };
  const stopTag = result.stopReason && stopLabels[result.stopReason]
    ? ` [${stopLabels[result.stopReason]}]`
    : "";

  const ctx = formatContextUsage(result.promptTokens ?? 0, result.contextWindow);
  const ctxPart = ctx ? ` | ${ctx}` : "";

  if (!verbose) return `${base}${ctxPart} | ${shortSession}${stopTag}`;
  const totalIn = result.inputTokens + result.cacheReadTokens;
  return `${base}${ctxPart} | ${formatTokenCount(totalIn)} in / ${formatTokenCount(result.outputTokens)} out | ${result.numTurns} turns | ${shortSession}${stopTag}`;
}

export function formatToolLine(toolName: string, input?: Record<string, unknown>, subagent?: boolean): string {
  // Strip MCP server prefix (e.g. "mcp__agent-tools__memory_read" -> "memory_read")
  const short = toolName.replace(/^mcp__[^_]+__/, "");

  // Color by agent: main agent = blue diamond, subagent = purple diamond
  const icon = subagent ? "\u{1F538}" : "\u{1F539}";
  const indent = subagent ? "  " : "";

  // Extract detail based on tool type
  const detail = extractToolDetail(short, input);
  if (detail) return `${indent}${icon} ${short} ${detail}`;
  return `${indent}${icon} ${short}`;
}

function extractToolDetail(toolName: string, input?: Record<string, unknown>): string | null {
  if (!input) return null;

  // File operations: show basename
  const filePath = input.file_path ?? input.path ?? input.file ?? input.filename;
  if (typeof filePath === "string") {
    const name = filePath.split("/").pop() ?? filePath;
    return `(${name})`;
  }

  // Bash: show truncated command
  const command = input.command;
  if (typeof command === "string") {
    const trimmed = command.split("\n")[0].slice(0, 60);
    return `(${trimmed}${command.length > 60 ? "..." : ""})`;
  }

  // Task: show description
  const description = input.description;
  if (typeof description === "string") {
    return `(${description.slice(0, 40)}${description.length > 40 ? "..." : ""})`;
  }

  // Search/grep: show pattern or query
  const pattern = input.pattern ?? input.query;
  if (typeof pattern === "string") {
    return `(${pattern.slice(0, 40)})`;
  }

  return null;
}

export function formatToolsSummary(toolLines: string[]): string {
  if (toolLines.length === 0) return "";
  return toolLines.join("\n");
}

export function formatJobSummary(job: {
  name: string;
  type: string;
  schedule?: string | null;
  status: string;
}): string {
  const schedule =
    job.type === "cron" && job.schedule ? ` (${job.schedule})` : "";
  return `${job.name}${schedule} [${job.status}]`;
}
