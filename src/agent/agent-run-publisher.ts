import { createLogger } from "../shared/logger.ts";
import { getConfig } from "../config.ts";

const log = createLogger("agent-run-publisher");

/**
 * Extract the LAST fenced ```json block from text.
 *
 * Robust against agents that include `{` characters in their prose. Returns
 * the parsed JSON or null if no valid fenced block is found.
 *
 * The envelope spec requires the JSON to be the last thing in the message.
 */
export function extractFencedJson(text: string): unknown | null {
  // Match all ```json … ``` blocks; capture body
  const fenceRe = /```json\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fenceRe.exec(text)) !== null) {
    last = match[1];
  }
  if (last === null) return null;

  try {
    return JSON.parse(last);
  } catch (err) {
    log.warn("Last fenced JSON block failed to parse", { error: String(err) });
    return null;
  }
}

/**
 * Fallback: find the last balanced top-level JSON object in the text.
 * Used when the agent emits JSON without a fence.
 */
export function extractTrailingJson(text: string): unknown | null {
  const lastClose = text.lastIndexOf("}");
  if (lastClose === -1) return null;

  let depth = 0;
  let start = -1;
  for (let i = lastClose; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) {
        start = i;
        break;
      }
    }
  }
  if (start === -1) return null;

  try {
    return JSON.parse(text.slice(start, lastClose + 1));
  } catch {
    return null;
  }
}

export interface EnvelopeMeta {
  jobId: number;
  runId: number;
  startedAt: string;
  completedAt: string;
  costUsd: number | null;
  durationMs: number | null;
}

/**
 * Publish an agent-run envelope to the trading-bot ingestion endpoint.
 *
 * Non-blocking semantics: failures are logged and swallowed so that the
 * upstream job is never failed by a downstream dashboard issue.
 *
 * Returns true on a 2xx response, false otherwise.
 */
export async function publishEnvelope(
  envelope: Record<string, unknown>,
  meta: EnvelopeMeta,
): Promise<boolean> {
  const baseUrl = getConfig().TRADING_BOT_URL;
  if (!baseUrl) {
    log.debug("TRADING_BOT_URL empty; skipping envelope publish");
    return false;
  }

  // Augment envelope with ingestion-side metadata so the dashboard can
  // backlink to the upstream job and dedupe re-runs.
  const enriched: Record<string, unknown> = {
    ...envelope,
    source_job_id: meta.jobId,
    source_run_id: meta.runId,
    started_at: envelope.started_at ?? meta.startedAt,
    completed_at: envelope.completed_at ?? meta.completedAt,
    cost_usd: envelope.cost_usd ?? meta.costUsd ?? undefined,
    duration_ms: envelope.duration_ms ?? meta.durationMs ?? undefined,
  };

  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/agent-runs`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(enriched),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn("Envelope publish non-2xx", {
        url,
        status: res.status,
        body: body.slice(0, 300),
      });
      return false;
    }
    log.info("Envelope published", {
      jobId: meta.jobId,
      runId: meta.runId,
      agentId: String(enriched.agent_id ?? ""),
    });
    return true;
  } catch (err) {
    log.warn("Envelope publish failed", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Convenience: extract envelope from agent text, validate minimum fields, and publish.
 * Returns true if an envelope was found and successfully sent.
 */
export async function tryPublishFromText(
  resultText: string,
  meta: EnvelopeMeta,
): Promise<boolean> {
  const parsed = extractFencedJson(resultText) ?? extractTrailingJson(resultText);
  if (parsed === null || typeof parsed !== "object") {
    log.debug("No envelope found in agent output", { jobId: meta.jobId });
    return false;
  }
  const envelope = parsed as Record<string, unknown>;
  if (!envelope.agent_id || !envelope.agent_name) {
    log.debug("Parsed JSON missing required envelope fields", {
      jobId: meta.jobId,
      keys: Object.keys(envelope).slice(0, 8),
    });
    return false;
  }
  return await publishEnvelope(envelope, meta);
}
