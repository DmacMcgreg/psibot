/**
 * DigestRunner — schedules and delivers the Weekly Digest.
 *
 * Mirrors HeartbeatRunner's shape (getBot + digest chat/topic closures, group
 * send with DM fallback). Fires Friday 17:00 America/New_York (after market
 * close); on fire it composes the digest, archives the markdown to
 * knowledge/digests/YYYY-Www.md, and posts the Telegram-HTML chunks to the
 * digest chat/topic. Telegram-only delivery — no email.
 */

import { Cron } from "croner";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Bot } from "grammy";
import { createLogger } from "../shared/logger.ts";
import { composeWeeklyDigest, type WeeklyDigest } from "./compose.ts";

const log = createLogger("digest");

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");
const DIGESTS_DIR = join(KNOWLEDGE_DIR, "digests");

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
        youtube: digest.youtube.length,
        chunks: digest.telegramChunks.length,
      });

      this.archive(digest);
      await this.deliver(digest);

      return digest;
    } finally {
      this.running = false;
    }
  }

  /** Write the markdown archive to knowledge/digests/YYYY-Www.md. */
  private archive(digest: WeeklyDigest): void {
    try {
      mkdirSync(DIGESTS_DIR, { recursive: true });
      const path = join(DIGESTS_DIR, `${digest.week}.md`);
      writeFileSync(path, digest.markdown);
      log.info("Archived weekly digest", { path });
    } catch (err) {
      log.error("Failed to archive weekly digest", { week: digest.week, error: String(err) });
    }
  }

  /**
   * Send the Telegram-HTML chunks to the digest chat/topic, falling back to DM
   * chat ids when the group send fails (same fallback pattern as the heartbeat).
   */
  private async deliver(digest: WeeklyDigest): Promise<void> {
    const bot = this.getBot();
    if (!bot) {
      log.warn("Weekly digest not delivered (no bot)");
      return;
    }
    if (digest.telegramChunks.length === 0) return;

    const topicOpts =
      this.digestChatId && this.digestTopicId
        ? { message_thread_id: this.digestTopicId }
        : {};

    // Preferred target: the group topic if configured, else DM.
    if (this.digestChatId) {
      let ok = true;
      for (const chunk of digest.telegramChunks) {
        try {
          await bot.api.sendMessage(this.digestChatId, chunk, {
            parse_mode: "HTML",
            ...topicOpts,
          });
        } catch (err) {
          ok = false;
          log.error("Failed to send digest chunk to group", {
            chatId: this.digestChatId,
            error: String(err),
          });
          break;
        }
      }
      if (ok) return;
      log.info("Falling back to DM delivery for weekly digest");
    }

    // Fallback (or default): DM every allowed user.
    for (const chatId of this.defaultChatIds) {
      for (const chunk of digest.telegramChunks) {
        try {
          await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
        } catch (err) {
          log.error("Failed to send digest chunk to DM", { chatId, error: String(err) });
        }
      }
    }
  }
}
