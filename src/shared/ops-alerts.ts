/**
 * Ops alerts: short operational notices to David's Telegram DM (the default
 * notify path, ALLOWED_TELEGRAM_USER_IDS) — a job missed its runs or went
 * "failed", a log file is growing like a runaway loop.
 *
 * Each alert has a key (e.g. `job:35`, `log-growth:psibot.out.log`). One key
 * sends at most once per OPS_ALERT_WINDOW_MS; the last-sent time lives in the
 * `ops_state` table, so the de-dupe survives daemon restarts (which happen
 * several times a day).
 *
 * The scheduler's first self-check runs before the Telegram bot exists, so
 * alerts raised before `setOpsAlertSender` are held and sent once it's set.
 * Never throws.
 */

import type { Bot } from "grammy";
import { getOpsState, setOpsState, deleteOpsState, recordSentMessage } from "../db/queries.ts";
import { createLogger } from "./logger.ts";
import type { SentMessageSource } from "./types.ts";

const log = createLogger("ops-alerts");

/** One alert per key per window. */
export const OPS_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Delivers one alert. Resolves true when at least one recipient got it. */
export type OpsAlertSender = (text: string) => Promise<boolean>;

export type OpsAlertResult = "sent" | "deduped" | "queued" | "failed";

let sender: OpsAlertSender | null = null;
const held: Array<{ key: string; text: string }> = [];

const stateKey = (key: string) => `alert:${key}`;

/** The slice of grammy's Bot a DM needs (a real Bot satisfies it). */
export interface DmBot {
  api: {
    sendMessage(
      chatId: number,
      text: string,
      other?: { parse_mode?: "HTML"; link_preview_options?: { is_disabled?: boolean } },
    ): Promise<{ message_id: number }>;
  };
}

/** How one DM goes out: parse mode and the `sent_messages` provenance tag. */
export interface DmOptions {
  /** "HTML" for pre-escaped markup (the fleet digest); omitted = plain text. */
  parseMode?: "HTML";
  source?: SentMessageSource;
}

/**
 * DM `text` to each user id. Resolves the first delivered message id, or null
 * when nobody got it. Never throws.
 */
export async function sendTelegramDm(
  bot: DmBot,
  userIds: number[],
  text: string,
  opts: DmOptions = {},
): Promise<number | null> {
  let firstId: number | null = null;
  for (const userId of userIds) {
    try {
      const sent = await bot.api.sendMessage(userId, text, {
        link_preview_options: { is_disabled: true },
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      });
      recordSentMessage(userId, sent.message_id, null, { source: opts.source ?? "ops-alert", preview: text });
      firstId ??= sent.message_id;
    } catch (err) {
      log.error("Failed to send Telegram DM", { userId, source: opts.source ?? "ops-alert", error: String(err) });
    }
  }
  return firstId;
}

/** Plain-text DM to each user id. No parse_mode, so job names and errors need no escaping. */
export function telegramDmSender(bot: Bot, userIds: number[]): OpsAlertSender {
  return async (text) => (await sendTelegramDm(bot, userIds, text)) !== null;
}

/** Wire the delivery path (index.ts, once the bot exists) and flush held alerts. */
export function setOpsAlertSender(fn: OpsAlertSender | null): void {
  sender = fn;
  if (!fn || held.length === 0) return;
  const pending = held.splice(0);
  void (async () => {
    for (const a of pending) await sendOpsAlert(a.key, a.text);
  })();
}

/** True when `key` already alerted within the window before `now`. */
export function recentlyAlerted(key: string, now: Date = new Date()): boolean {
  const last = getOpsState(stateKey(key));
  if (!last) return false;
  const t = Date.parse(last);
  return Number.isFinite(t) && now.getTime() - t < OPS_ALERT_WINDOW_MS;
}

/**
 * Send `text` unless `key` alerted in the last 24 h. The slot is claimed
 * before the send (so two callers can't both send) and released if delivery
 * fails, so the next occurrence can try again.
 */
export async function sendOpsAlert(key: string, text: string, now: Date = new Date()): Promise<OpsAlertResult> {
  try {
    if (recentlyAlerted(key, now)) {
      log.info("Ops alert de-duplicated (sent within 24h)", { key });
      return "deduped";
    }
    if (!sender) {
      if (!held.some((a) => a.key === key)) held.push({ key, text });
      return "queued";
    }
    const previous = getOpsState(stateKey(key));
    setOpsState(stateKey(key), now.toISOString());
    const ok = await sender(text);
    if (!ok) {
      if (previous) setOpsState(stateKey(key), previous);
      else deleteOpsState(stateKey(key));
      return "failed";
    }
    log.info("Ops alert sent", { key });
    return "sent";
  } catch (err) {
    log.error("Ops alert failed", { key, error: String(err) });
    return "failed";
  }
}

/** First line of an error, trimmed to fit one Telegram line. */
export function oneLine(text: string | null | undefined, max = 200): string {
  const first = (text ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** Test-only: drop the sender and any held alerts. */
export function resetOpsAlertsForTesting(): void {
  sender = null;
  held.length = 0;
}
