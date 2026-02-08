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
