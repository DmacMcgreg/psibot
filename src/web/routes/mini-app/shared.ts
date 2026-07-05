import type { Context } from "hono";
import { AgentService } from "../../../agent/index.ts";
import { MemorySystem } from "../../../memory/index.ts";
import type { TelegramAuthContext } from "../../middleware/telegram-auth.ts";
import { createLogger } from "../../../shared/logger.ts";
import { escapeHtml } from "../../views/mini-app/components.ts";

export const log = createLogger("web:mini-app");

/** Group chat id used when routing job/agent notifications to a topic. */
export const GROUP_CHAT_ID = "-1003762174787";

export interface MiniAppEnv {
  Variables: {
    agent: AgentService;
    memory: MemorySystem;
    triggerJob: (jobId: number) => void;
    reloadScheduler: () => void;
    telegramUser: TelegramAuthContext["telegramUser"];
  };
}

/**
 * Escape untrusted text for safe interpolation into HTML text nodes.
 *
 * Re-exported from the single canonical `components.ts` implementation so route
 * files that import `escapeHtml` from `shared.ts` share one contract with the
 * view layer. For attribute interpolation use `escapeAttr` from components.ts.
 */
export { escapeHtml };

/**
 * Parse a required integer path/param. Returns the number, or null when the
 * value is missing or not a finite integer. Callers respond 400 on null.
 */
export function requireIntParam(c: Context, name: string): number | null {
  const raw = c.req.param(name);
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return n;
}

// --- Per-user chat session store (replaces the old single global) ---

const activeSessionByUser = new Map<string, string>();

export function getActiveSession(userId: string): string | undefined {
  return activeSessionByUser.get(userId);
}

export function setActiveSession(userId: string, sessionId: string): void {
  activeSessionByUser.set(userId, sessionId);
}

export function clearActiveSession(userId: string): void {
  activeSessionByUser.delete(userId);
}

// --- SSE stream registry ---

export interface SseStream {
  controller: ReadableStreamDefaultController<string> | null;
  done: boolean;
  createdAt: number;
}

export const streams = new Map<string, SseStream>();

export function sseEncode(event: string, data: string): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STREAM_IDLE_MS = 30 * 60 * 1000; // 30 minutes

let sweepStarted = false;

/**
 * Periodically evict SSE streams older than the idle timeout so orphaned
 * controllers (client vanished mid-stream) don't accumulate in the registry.
 * Idempotent — safe to call once at router construction.
 */
export function startStreamSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, stream] of streams) {
      if (now - stream.createdAt < STREAM_IDLE_MS) continue;
      try {
        if (stream.controller && !stream.done) {
          stream.done = true;
          stream.controller.close();
        }
      } catch (err) {
        log.error("SSE sweep close failed", { streamId: id, error: String(err) });
      }
      streams.delete(id);
      log.info("SSE stream evicted (idle timeout)", { streamId: id });
    }
  }, 5 * 60 * 1000); // sweep every 5 minutes
  // Don't keep the event loop alive solely for the sweep.
  if (typeof timer.unref === "function") timer.unref();
}
