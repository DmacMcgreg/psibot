import { Cron } from "croner";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { createLogger } from "../shared/logger.ts";
import { getConfig } from "../config.ts";
import { processAndStoreVideo } from "../youtube/process.ts";
import {
  startRun,
  completeRun,
  getState,
  setState,
  listChannels,
  seedChannelsFromHistory,
  getTopScoredCandidates,
  getCandidatesByStatus,
  setCandidateStatus,
  updateCandidate,
  type DiscoveryCandidate,
} from "./db.ts";
import { buildInterestProfile, loadCentroid } from "./profile.ts";
import { pollRssFeeds, backfillChannelUploads } from "./channels.ts";
import { fanOutSearch, gatherRelated, pickRelatedSeeds } from "./candidates.ts";
import { scoreCandidates, mmrRerank, epsilonGreedy, type ScoredCandidate } from "./scoring.ts";
import { mineNews, type NewsItem } from "./news.ts";

const log = createLogger("discovery");

export interface DiscoveryRunnerDeps {
  getBot: () => Bot | null;
  defaultChatIds: number[];
  /** Group chat to create/send the discoveries topic in. */
  groupChatId?: string;
  /** Topic id override; otherwise lazily created + persisted. */
  topicId?: number;
  /** Config overrides for tests. */
  intervalHours?: number;
  quietStart?: number;
  quietEnd?: number;
  maxProcessPerRun?: number;
  maxSearchCallsPerRun?: number;
  cronPattern?: string;
}

interface RunStats {
  channelsPolled: number;
  searchesRun: number;
  quotaUnitsUsed: number;
  candidatesFound: number;
  processed: number;
  surfaced: number;
  error: string | null;
}

interface ProcessedPick {
  candidate: ScoredCandidate;
  result: { title: string; channelTitle: string; markdownSummary: string };
}

/**
 * Proactive YouTube discovery runner. Mirrors SynthesisRunner: a croner-driven
 * orchestrator with a reentrancy guard and quiet hours. Each run:
 *   1. Builds the interest profile + centroid
 *   2. Polls channel RSS feeds (free)
 *   3. Cheap backfill of a couple of high-affinity channels
 *   4. Budgeted fan-out search + graph fan-out
 *   5. Scores + MMR + ε-greedy picks
 *   6. Fully processes the top picks (existing transcript pipeline)
 *   7. Mines news from the last 48h of videos
 *   8. Surfaces a digest to the dedicated Telegram topic
 */
export class DiscoveryRunner {
  private cron: Cron | null = null;
  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private groupChatId?: string;
  private topicId?: number;

  private intervalHours: number;
  private quietStart: number;
  private quietEnd: number;
  private maxProcessPerRun: number;
  private maxSearchCallsPerRun: number;
  private cronPattern?: string;

  private running = false;

  constructor(deps: DiscoveryRunnerDeps) {
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.groupChatId = deps.groupChatId;
    this.topicId = deps.topicId;
    this.intervalHours = deps.intervalHours ?? getConfig().DISCOVERY_INTERVAL_HOURS;
    this.quietStart = deps.quietStart ?? getConfig().DISCOVERY_QUIET_START;
    this.quietEnd = deps.quietEnd ?? getConfig().DISCOVERY_QUIET_END;
    this.maxProcessPerRun = deps.maxProcessPerRun ?? getConfig().DISCOVERY_MAX_PROCESS_PER_RUN;
    this.maxSearchCallsPerRun = deps.maxSearchCallsPerRun ?? getConfig().DISCOVERY_MAX_SEARCH_CALLS_PER_RUN;
    this.cronPattern = deps.cronPattern;
  }

  start(): void {
    const pattern = this.cronPattern ?? `0 */${this.intervalHours} * * *`;
    log.info("Starting discovery runner", { pattern, intervalHours: this.intervalHours });
    this.cron = new Cron(pattern, () => {
      this.runOnce().catch((err) => log.error("Discovery run crashed", { error: String(err) }));
    });

    // Kick off a run shortly after boot so discovery is active immediately,
    // rather than waiting for the first cron tick (up to `intervalHours` away).
    // The 90s delay lets the Telegram bot connect and the agent service settle.
    setTimeout(() => {
      this.runOnce().catch((err) => log.error("Discovery startup run crashed", { error: String(err) }));
    }, 90_000);
  }

  stop(): void {
    this.cron?.stop();
    this.cron = null;
    log.info("Discovery runner stopped");
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    if (this.quietStart === this.quietEnd) return false;
    if (this.quietStart > this.quietEnd) return hour >= this.quietStart || hour < this.quietEnd;
    return hour >= this.quietStart && hour < this.quietEnd;
  }

  /** Run one full discovery cycle. Safe to call manually (agent tool / job). */
  async runOnce(): Promise<RunStats> {
    if (this.running) {
      log.info("Discovery run skipped (already running)");
      return emptyStats();
    }
    this.running = true;
    const runId = startRun();
    const stats: RunStats = { ...emptyStats() };

    try {
      // --- Bootstrap: seed channels from history on first ever run ---
      const channelCount = listChannels().length;
      if (channelCount === 0) {
        log.info("First run — seeding channels from watch history");
        await seedChannelsFromHistory();
      }

      // --- Step 1: interest profile ---
      await buildInterestProfile();
      if (!loadCentroid()) {
        log.warn("No centroid — topic embeddings may need backfill. Continuing with reduced scoring.");
      }

      // --- Step 2: RSS poll ---
      const rss = await pollRssFeeds();
      stats.channelsPolled = rss.channelsPolled;
      stats.candidatesFound += rss.newCandidates;

      // --- Step 3: cheap backfill of top 3 affinity channels ---
      try {
        const topChannels = listChannels().slice(0, 3);
        for (const ch of topChannels) {
          const n = await backfillChannelUploads(ch, 15);
          stats.candidatesFound += n;
          stats.quotaUnitsUsed += 2; // channels.list + playlistItems.list worst case
        }
      } catch (err) {
        log.warn("Backfill phase failed (non-fatal)", { error: String(err) });
      }

      // --- Step 4: fan-out search + graph fan-out ---
      const fan = await fanOutSearch(this.maxSearchCallsPerRun);
      stats.searchesRun = fan.searchesRun;
      stats.quotaUnitsUsed += fan.quotaUnitsUsed;
      stats.candidatesFound += fan.candidatesFound;

      try {
        const seeds = pickRelatedSeeds(3);
        const related = gatherRelated(seeds, 5);
        stats.candidatesFound += related;
      } catch (err) {
        log.warn("Graph fan-out failed (non-fatal)", { error: String(err) });
      }

      if (fan.reauthRequired) {
        stats.error = "Google reauth required — fan-out aborted, RSS/graph paths continued";
        // Notify once so the user can re-auth.
        await this.notifyReauthRequired();
      }

      // --- Step 5: score + rank ---
      const unscored = getCandidatesByStatus("candidate", 200);
      const scored = await scoreCandidates(unscored);
      if (scored.length === 0) {
        log.info("No scoreable candidates this run");
        completeRun(runId, stats);
        return stats;
      }

      // MMR-diverse top-N, with ε-greedy exploration.
      const vectors = await this.resolveVectors(scored);
      const picks = this.selectPicks(scored, vectors);

      // --- Step 6: fully process the top picks ---
      const processed: ProcessedPick[] = [];
      for (const pick of picks) {
        setCandidateStatus(pick.video_id, "processing");
        try {
          const result = await processAndStoreVideo(pick.video_id);
          setCandidateStatus(pick.video_id, "processed", { processedAt: true });
          updateCandidate(pick.id, {
            title: result.title || pick.title,
          });
          processed.push({ candidate: pick, result: {
            title: result.title,
            channelTitle: result.channelTitle,
            markdownSummary: result.markdownSummary,
          }});
          stats.processed++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error("Candidate processing failed", { videoId: pick.video_id, error: msg });
          setCandidateStatus(pick.video_id, "rejected", { reason: `processing_failed: ${msg.slice(0, 100)}` });
        }
      }

      // --- Step 7: news mining (over last 48h, incl. freshly processed) ---
      let news: NewsItem[] = [];
      try {
        const mined = await mineNews();
        news = mined.items;
      } catch (err) {
        log.warn("News mining failed (non-fatal)", { error: String(err) });
      }

      // --- Step 8: surface digest ---
      if (processed.length > 0 || news.length > 0) {
        const surfaced = await this.surfaceDigest(processed, news);
        stats.surfaced = surfaced;
      }

      completeRun(runId, stats);
      log.info("Discovery run complete", { ...stats, runId });
      return stats;
    } catch (err) {
      stats.error = err instanceof Error ? err.message : String(err);
      log.error("Discovery run failed", { error: stats.error, runId });
      completeRun(runId, stats);
      return stats;
    } finally {
      this.running = false;
    }
  }

  /** Pick the top-N to process: MMR diversity + ε-greedy exploration. */
  private selectPicks(scored: ScoredCandidate[], vectors: (Float32Array | null)[]): ScoredCandidate[] {
    const slots = Math.min(this.maxProcessPerRun, scored.length);
    if (slots === 0) return [];
    const diverse = mmrRerank(scored, vectors, Math.min(slots * 3, scored.length), 0.7);
    return epsilonGreedy(diverse, scored, slots, 0.15);
  }

  /**
   * Resolve diversity vectors for scored candidates (used by MMR re-ranking).
   *
   * Returns null for each candidate. We intentionally avoid reading the
   * youtube_vec table here: on a long-lived bun:sqlite connection, interleaving
   * vec0 virtual-table reads with other queries corrupts Bun's column-count
   * metadata. With all-null vectors, mmrRerank degrades gracefully to pure
   * relevance ordering (it treats null vectors as maximally diverse, so no
   * candidate is penalized). Diversity is still provided by ε-greedy
   * exploration and the varied search seeds.
   */
  private async resolveVectors(scored: ScoredCandidate[]): Promise<(Float32Array | null)[]> {
    return scored.map(() => null);
  }

  // --- Surfacing ---

  /** Lazily create the discoveries topic if needed, then send the digest. */
  private async surfaceDigest(processed: ProcessedPick[], news: NewsItem[]): Promise<number> {
    const bot = this.getBot();
    if (!bot) return 0;

    const { chatId, topicId } = await this.resolveTarget(bot);
    if (!chatId) return 0;

    let surfaced = 0;

    // Header
    try {
      const parts: string[] = [`<b>YouTube Discovery Digest</b>`];
      parts.push(`${processed.length} new video${processed.length === 1 ? "" : "s"} processed · ${news.length} news item${news.length === 1 ? "" : "s"}`);
      await this.send(bot, chatId, topicId, parts.join("\n"));
    } catch (err) {
      log.error("Digest header failed", { error: String(err) });
    }

    // Top picks (newly processed)
    for (const { candidate, result } of processed) {
      try {
        const title = escapeHtml(result.title);
        const channel = escapeHtml(result.channelTitle);
        const summary = escapeHtml(truncate(stripMarkdown(result.markdownSummary), 280));
        const scoreLine = candidate.breakdown
          ? ` · match ${(candidate.breakdown.similarity * 100).toFixed(0)}%`
          : "";
        const sourceLine = candidate.source_detail ? ` · via ${escapeHtml(candidate.source_detail)}` : "";

        const msg = [
          `🎬 <b>${title}</b> — ${channel}${scoreLine}${sourceLine}`,
          summary,
        ].join("\n");

        const kb = new InlineKeyboard()
          .url("Watch", `https://youtube.com/watch?v=${candidate.video_id}`)
          .text("Drop", `dv:drop:${candidate.id}`);

        await this.send(bot, chatId, topicId, msg, kb);
        setCandidateStatus(candidate.video_id, "surfaced", { surfacedAt: true });
        surfaced++;
      } catch (err) {
        log.error("Failed to surface pick", { videoId: candidate.video_id, error: String(err) });
      }
    }

    // News items
    if (news.length > 0) {
      try {
        await this.send(bot, chatId, topicId, `<b>📡 News from your videos</b>`);
      } catch { /* header is best-effort */ }
    }
    for (const item of news) {
      try {
        const noveltyTag = item.novelty > 0.4 ? " 🆕" : item.videoCount > 2 ? " 📈" : "";
        const sources = item.sourceVideos
          .map((s, i) => `<a href="https://youtube.com/watch?v=${s.videoId}">${escapeHtml(s.title)}</a>`)
          .join(" · ");
        const msg = [
          `▪️ <b>${escapeHtml(item.headline)}</b>${noveltyTag}`,
          escapeHtml(item.what),
          item.whyItMatters ? `<i>Why it matters:</i> ${escapeHtml(item.whyItMatters)}` : "",
          sources,
        ].filter(Boolean).join("\n");

        await this.send(bot, chatId, topicId, msg);
      } catch (err) {
        log.error("Failed to surface news item", { error: String(err) });
      }
    }

    return surfaced;
  }

  private async resolveTarget(bot: Bot): Promise<{ chatId: string | null; topicId: number | undefined }> {
    // Explicit configured topic wins.
    const configured = getConfig().DISCOVERY_NEWS_TOPIC_ID;
    if (configured && this.groupChatId) {
      return { chatId: this.groupChatId, topicId: configured };
    }
    // Persisted topic from a prior lazy create.
    const persisted = getState("topic_id");
    if (persisted && this.groupChatId) {
      return { chatId: this.groupChatId, topicId: Number(persisted) };
    }
    // Lazy-create the topic in the group.
    if (this.groupChatId) {
      try {
        const forum = await bot.api.createForumTopic(this.groupChatId, "YouTube Discoveries");
        setState("topic_id", String(forum.message_thread_id));
        log.info("Created discoveries topic", { topicId: forum.message_thread_id });
        return { chatId: this.groupChatId, topicId: forum.message_thread_id };
      } catch (err) {
        log.warn("Could not create discoveries topic — falling back to DM", { error: String(err) });
      }
    }
    // Fallback: DM the user.
    return { chatId: null, topicId: undefined };
  }

  private async send(
    bot: Bot,
    chatId: string | number,
    topicId: number | undefined,
    text: string,
    kb?: InlineKeyboard,
  ): Promise<void> {
    // If no group chat id resolved, fall back to DMs.
    const targets: (string | number)[] = chatId ? [chatId] : this.defaultChatIds;
    for (const target of targets) {
      try {
        await bot.api.sendMessage(target, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(topicId ? { message_thread_id: topicId } : {}),
          ...(kb ? { reply_markup: kb } : {}),
        });
      } catch (err) {
        log.error("Discovery send failed", { target, error: String(err) });
      }
    }
  }

  private async notifyReauthRequired(): Promise<void> {
    const bot = this.getBot();
    if (!bot) return;
    for (const chatId of this.defaultChatIds) {
      try {
        await bot.api.sendMessage(
          chatId,
          "⚠️ YouTube discovery needs re-auth. Google OAuth has expired — visit your OAuth vault to reconnect.",
        );
      } catch { /* best-effort */ }
    }
  }
}

// --- helpers ---

function emptyStats(): RunStats {
  return {
    channelsPolled: 0,
    searchesRun: 0,
    quotaUnitsUsed: 0,
    candidatesFound: 0,
    processed: 0,
    surfaced: 0,
    error: null,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + "…";
}

function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
