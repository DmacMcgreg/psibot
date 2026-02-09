const MAX_MESSAGE_LENGTH = 4096;

export function formatForTelegram(text: string): string {
  // Escape markdown v2 special characters for plain text portions
  return text
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
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

export function formatRunMeta(result: { costUsd: number; durationMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; contextWindow: number; numTurns: number }, verbose: boolean): string {
  const base = `${formatCost(result.costUsd)} / ${formatDuration(result.durationMs)}`;
  if (!verbose) return base;
  const totalIn = result.inputTokens + result.cacheReadTokens;
  return `${base} | ${formatTokenCount(totalIn)} in / ${formatTokenCount(result.outputTokens)} out | ${result.numTurns} turns`;
}

export function formatToolLine(toolName: string, input?: Record<string, unknown>): string {
  // Strip MCP server prefix (e.g. "mcp__agent-tools__memory_read" -> "memory_read")
  const short = toolName.replace(/^mcp__[^_]+__/, "");

  // Extract detail based on tool type
  const detail = extractToolDetail(short, input);
  if (detail) return `\u{1F539} ${short} ${detail}`;
  return `\u{1F539} ${short}`;
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
