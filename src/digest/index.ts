/**
 * DigestRunner — schedules and delivers the Weekly Digest.
 *
 * Mirrors HeartbeatRunner's shape (getBot + digest chat/topic closures, group
 * send with DM fallback). Fires Friday 17:00 America/New_York (after market
 * close); on fire it composes the digest and posts the Telegram-HTML chunks
 * to the digest chat/topic. Telegram-only delivery — no email.
 *
 * No markdown archive is written: knowledge/digests/ was pruned 2026-10-02
 * (superseded by knowledge/weekly/; research/psibot-knowledge-value-2026-10.md
 * in the vivaldi-home repo). The delivered chunks are the record, receipted
 * in sent_messages.
 */

import { Cron } from "croner";
import type { Bot, InlineKeyboard } from "grammy";
import { createLogger } from "../shared/logger.ts";
import { recordSentMessage } from "../db/queries.ts";
import { composeWeeklyDigest, TELEGRAM_TOP_ITEMS_N, type WeeklyDigest } from "./compose.ts";
import { digestKeyboard } from "./buttons.ts";

const log = createLogger("digest");


/** Friday 17:00 (after market close). Timezone applied via Cron options. */
const DIGEST_CRON = "0 17 * * 5";
const DIGEST_TZ = "America/New_York";

interface DigestRunnerDeps {
  getBot: () => Bot | null;
  /** DM fallback targets when the group topic send fails / isn't configured. */
  defaultChatIds: number[];
  /** Group chat id for the digest topic (same pattern as HeartbeatRunner). */
  digestChatId?: string;
  /** Topic thread id within the digest chat. */
  digestTopicId?: number;
}

export class DigestRunner {
  private cron: Cron | null = null;
  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private digestChatId?: string;
  private digestTopicId?: number;
  private running = false;

  constructor(deps: DigestRunnerDeps) {
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.digestChatId = deps.digestChatId;
    this.digestTopicId = deps.digestTopicId;
  }

  start(): void {
    log.info("Starting weekly digest runner", { pattern: DIGEST_CRON, timezone: DIGEST_TZ });
    this.cron = new Cron(DIGEST_CRON, { timezone: DIGEST_TZ }, () => {
      this.runNow().catch((err) => {
        log.error("Weekly digest run failed", { error: String(err) });
      });
    });
  }

  stop(): void {
    if (this.cron) {
      this.cron.stop();
      this.cron = null;
      log.info("Weekly digest runner stopped");
    }
  }

  /**
   * Compose, archive, and deliver the digest. Exported for manual triggering
   * (e.g. a dashboard/route or CLI) — returns the composed digest so callers
   * can inspect it.
   */
  async runNow(): Promise<WeeklyDigest> {
    if (this.running) {
      log.info("Weekly digest skipped (already running)");
      throw new Error("Digest run already in progress");
    }
    this.running = true;
    try {
      const digest = composeWeeklyDigest();
      log.info("Composed weekly digest", {
        week: digest.week,
        captured: digest.numbers.capturedTotal,
        topItems: digest.topItems.length,
        research: digest.research.length,
        youtube: digest.youtube.totalCount,
        chunks: digest.telegramChunks.length,
      });

      await this.deliver(digest);

      return digest;
    } finally {
      this.running = false;
    }
  }


  /**
   * Send the Telegram-HTML chunks to the digest chat/topic, falling back to DM
   * chat ids when the group send fails (same fallback pattern as the
   * heartbeat). Delivery receipts (sent_messages, source 'weekly-digest') and
   * the action keyboard are handled by deliverWeeklyDigest below.
   */
  private async deliver(digest: WeeklyDigest): Promise<void> {
    const bot = this.getBot();
    if (!bot) {
      log.warn("Weekly digest not delivered (no bot)");
      return;
    }
    const delivered = await deliverWeeklyDigest(
      {
        send: (chatId, text, opts) =>
          bot.api.sendMessage(chatId, text, { parse_mode: "HTML", ...opts }),
        defaultChatIds: this.defaultChatIds,
        digestChatId: this.digestChatId,
        digestTopicId: this.digestTopicId,
      },
      digest,
    );
    if (!delivered) {
      log.error("Weekly digest delivery failed on every target", { week: digest.week });
    }
  }
}

// ─── Delivery with receipts (2026-10-02 value audit F4) ─────────────────────

/**
 * Minimal structural send seam — the grammy Bot satisfies it, tests fake it
 * without casts.
 */
export interface DigestSendDeps {
  send: (
    chatId: string | number,
    text: string,
    opts: { message_thread_id?: number; reply_markup?: InlineKeyboard },
  ) => Promise<{ message_id: number }>;
  /** DM fallback targets when the group topic send fails / isn't configured. */
  defaultChatIds: number[];
  /** Group chat id for the digest topic (same pattern as HeartbeatRunner). */
  digestChatId?: string;
  /** Topic thread id within the digest chat. */
  digestTopicId?: number;
}

/** Send every chunk to one target, recording one sent_messages row per chunk. */
async function sendChunks(
  deps: DigestSendDeps,
  chatId: string | number,
  topicId: number | null,
  digest: WeeklyDigest,
  kb: InlineKeyboard | undefined,
): Promise<boolean> {
  let ok = true;
  const chunks = digest.telegramChunks;
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    try {
      const res = await deps.send(chatId, chunks[i], {
        ...(topicId != null ? { message_thread_id: topicId } : {}),
        ...(last && kb ? { reply_markup: kb } : {}),
      });
      // Delivery receipt (F4): without this row the digest cannot prove it
      // was ever sent — the archive file's mtime was the only evidence.
      recordSentMessage(chatId, res.message_id, topicId, {
        source: "weekly-digest",
        preview: `Weekly digest ${digest.week} (${i + 1}/${chunks.length})`,
      });
    } catch (err) {
      ok = false;
      log.error("Failed to send digest chunk", { chatId, chunk: i + 1, error: String(err) });
      break;
    }
  }
  return ok;
}

/**
 * Deliver the digest: group topic first (when configured), DM fallback — the
 * runner's exact path, extracted so receipts are testable without a live bot.
 * One-tap Watch/Archive/Snooze buttons (src/digest/buttons.ts) ride the LAST
 * chunk, never per-item cards. True when any chat got every chunk.
 */
export async function deliverWeeklyDigest(deps: DigestSendDeps, digest: WeeklyDigest): Promise<boolean> {
  if (digest.telegramChunks.length === 0) return false;
  const items = digest.topItems.slice(0, TELEGRAM_TOP_ITEMS_N);
  const kb = items.length > 0 ? digestKeyboard(items, digest.week) : undefined;
  const topicId = deps.digestChatId && deps.digestTopicId ? deps.digestTopicId : null;

  if (deps.digestChatId) {
    if (await sendChunks(deps, deps.digestChatId, topicId, digest, kb)) return true;
    log.info("Falling back to DM delivery for weekly digest");
  }

  let any = false;
  for (const chatId of deps.defaultChatIds) {
    if (await sendChunks(deps, chatId, null, digest, kb)) any = true;
  }
  return any;
}
