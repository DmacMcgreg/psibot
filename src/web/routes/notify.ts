import { Hono } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { getOpsState, setOpsState } from "../../db/queries.ts";
import { escapeHtml } from "../../shared/html.ts";
import { createLogger } from "../../shared/logger.ts";
import { clientIp, isLoopback } from "../client-ip.ts";

/**
 * POST /api/notify — command-center's read-only phone digest (fleet `telegramNotify`).
 *
 * One HTML DM to David per call. Loopback callers only, bearer token from a
 * 0600 file, every link on the one tailnet Studio origin, at most six sends per
 * Ottawa day. Same-user processes can read the token, so the origin allowlist
 * and the daily cap bound what a forged digest can do. No reply verbs: this
 * endpoint only sends (reply verbs wait for the authority gate's phase 3).
 *
 *   403 peer not loopback · 401 bad token · 400 bad body · 422 link off origin
 *   429 seventh send today · 502 Telegram refused · 200 { ok, messageId }
 *
 * To shut it off, delete the token file: every call then gets 401 until the
 * next boot writes a new one.
 */

const log = createLogger("notify");

/** The only origin a digest link may point at: Studio on the tailnet. */
export const NOTIFY_LINK_ORIGIN = "http://100.110.54.112:4890";
export const NOTIFY_DAILY_CAP = 6;
export const NOTIFY_TZ = "America/Toronto";

const STATE_KEY = "notify:daily";

/** Sends the rendered HTML; resolves the Telegram message id, or null when it failed. */
export type NotifySend = (html: string) => Promise<number | null>;

export interface NotifyDeps {
  tokenPath: string;
  send: NotifySend;
  now?: () => Date;
}

// Title + text + 8 labels stay under Telegram's 4,096-char limit after parsing.
const bodySchema = z.object({
  title: z.string().trim().min(1).max(80),
  text: z.string().max(3500),
  links: z
    .array(z.object({ label: z.string().trim().min(1).max(60), url: z.string().min(1).max(2000) }))
    .max(8)
    .default([]),
});

export type NotifyBody = z.infer<typeof bodySchema>;

/** Write a random 32-byte token (hex) 0600 when the file is absent. Called once at boot. */
export function ensureNotifyToken(path: string): void {
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600); // the mode above is masked by umask
  log.info("Wrote notify token", { path });
}

/** Read per request, so deleting the file revokes access without a restart. */
function tokenMatches(path: string, header: string | undefined): boolean {
  const presented = /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1];
  if (!presented) return false;
  let expected: string;
  try {
    expected = readFileSync(path, "utf8").trim();
  } catch {
    return false;
  }
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Requests that came through a proxy (tailscale serve) are never local callers. */
function isDirectLoopback(c: Parameters<typeof clientIp>[0]): boolean {
  const ip = clientIp(c);
  if (!ip || !isLoopback(ip)) return false;
  return !c.req.header("x-forwarded-for") && !c.req.header("forwarded") && !c.req.header("tailscale-user-login");
}

function linkAllowed(url: string): boolean {
  try {
    return new URL(url).origin === NOTIFY_LINK_ORIGIN;
  } catch {
    return false;
  }
}

/** "2026-10-06" in Ottawa. */
export function ottawaDay(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: NOTIFY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function sentToday(day: string): number {
  try {
    const state = JSON.parse(getOpsState(STATE_KEY) ?? "null") as { day?: string; count?: number } | null;
    return state?.day === day && typeof state.count === "number" ? state.count : 0;
  } catch {
    return 0;
  }
}

/** Bold title, escaped text, then one `<a href>` per line. */
export function renderNotifyHtml(body: NotifyBody): string {
  const parts = [`<b>${escapeHtml(body.title)}</b>`];
  if (body.text.trim()) parts.push(escapeHtml(body.text));
  if (body.links.length) {
    parts.push(body.links.map((l) => `<a href="${escapeHtml(new URL(l.url).href)}">${escapeHtml(l.label)}</a>`).join("\n"));
  }
  return parts.join("\n\n");
}

export function createNotifyRoutes(deps: NotifyDeps) {
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  app.post("/api/notify", async (c) => {
    if (!isDirectLoopback(c)) {
      log.warn("Notify refused: peer not loopback", { ip: clientIp(c) ?? "unknown" });
      return c.json({ ok: false, error: "peer not loopback" }, 403);
    }
    if (!tokenMatches(deps.tokenPath, c.req.header("authorization"))) {
      log.warn("Notify refused: bad token");
      return c.json({ ok: false, error: "bad token" }, 401);
    }

    let parsed: NotifyBody;
    try {
      const result = bodySchema.safeParse(await c.req.json());
      if (!result.success) return c.json({ ok: false, error: result.error.issues[0]?.message ?? "bad body" }, 400);
      parsed = result.data;
    } catch {
      return c.json({ ok: false, error: "body is not JSON" }, 400);
    }

    const offOrigin = parsed.links.find((l) => !linkAllowed(l.url));
    if (offOrigin) {
      log.warn("Notify refused: link off origin", { url: offOrigin.url });
      return c.json({ ok: false, error: `link must be on ${NOTIFY_LINK_ORIGIN}` }, 422);
    }

    // Claim the slot before the send (no await between read and write), release it on failure.
    const day = ottawaDay(now());
    const count = sentToday(day);
    if (count >= NOTIFY_DAILY_CAP) {
      log.warn("Notify refused: daily cap", { day, count });
      return c.json({ ok: false, error: `more than ${NOTIFY_DAILY_CAP} sends today` }, 429);
    }
    setOpsState(STATE_KEY, JSON.stringify({ day, count: count + 1 }));

    const messageId = await deps.send(renderNotifyHtml(parsed));
    if (messageId === null) {
      const current = sentToday(day);
      setOpsState(STATE_KEY, JSON.stringify({ day, count: Math.max(0, current - 1) }));
      return c.json({ ok: false, error: "telegram send failed" }, 502);
    }
    log.info("Notify sent", { messageId, day, count: count + 1 });
    return c.json({ ok: true, messageId });
  });

  return app;
}
