import { Cron } from "croner";
import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { createLogger } from "../shared/logger.ts";
import { notifyReauthEpisode } from "./reauth-latch.ts";
import { getConfig } from "../config.ts";
import { processAndStoreVideo } from "../youtube/process.ts";
import { getVideo } from "../youtube/db.ts";
import { recordSentMessage } from "../db/queries.ts";
import {
  startRun,
  completeRun,
  getState,
  setState,
  listChannels,
  seedChannelsFromHistory,
  getTopScoredCandidates,
  getScoringQueue,
  setCandidateStatus,
  updateCandidate,
  insertNewsItem,
  expireStaleCandidates,
  pruneExpiredCandidates,
  rejectCandidatesAlreadyInLibrary,
  ALREADY_IN_LIBRARY_REASON,
  type DiscoveryCandidate,
} from "./db.ts";
import { buildInterestProfile, loadCentroid } from "./profile.ts";
import { pollRssFeeds, backfillChannelUploads } from "./channels.ts";
import { fanOutSearch, gatherRelated, pickRelatedSeeds } from "./candidates.ts";
import {
  scoreCandidates,
  mmrRerank,
  epsilonGreedy,
  passesRelevanceGate,
  MIN_RELEVANCE_SIMILARITY,
  type ScoredCandidate,
} from "./scoring.ts";
import { mineNews, type NewsItem } from "./news.ts";
import { getDb } from "../db/index.ts";
import { getVideoStats, type VideoStat } from "../youtube/api.ts";
import {
  DEFAULT_PREFILTER_CONFIG,
  loadJunkChannels,
  loadKnownChannels,
  prefilterCandidate,
  prefilterReason,
  type PrefilterConfig,
} from "./prefilter.ts";
import {
  buildGoalSeedPool,
  buildSeedPool,
  DEFAULT_SEED_PICK_OPTIONS,
  loadLeafWeights,
  parseSeedState,
  pickGoalSeeds,
  pickSeeds,
  recordSeedUse,
  type Seed,
} from "./seeds.ts";
import { loadGoals } from "../assets/goals.ts";
import {
  buildGateContext,
  recordGateSpend,
  resolveJevAsker,
  runJevGate,
  spentToday,
  type GateCandidate,
  type GateResult,
  type JevAsker,
} from "./jev-gate.ts";
import { DEFAULT_THRESHOLDS } from "../relevance/discover-triage.ts";

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
  /** Per-stage counts for this run (not stored in discovery_runs; logged and kept in discovery_state run_quality_log). */
  quality?: RunQuality;
  /** Dry runs only: what would have been processed. */
  wouldProcess?: Array<{ id: number; videoId: string; title: string | null; reason: string }>;
}

export interface RunQuality {
  seeds: string[];
  searchPrefiltered: number;
  queue: number;
  queuePrefiltered: number;
  scored: number;
  belowGate: number;
  gateThreshold: number;
  pool: number;
  poolPrefiltered: number;
  jevMode: "in-process" | "vault" | "unavailable" | "off" | "daily-cap";
  jevAsked: number;
  jevHide: number;
  jevUnsure: number;
  jevPick: number;
  jevErrors: number;
  jevCost: number;
  picks: number;
}

export interface RunOnceOptions {
  /**
   * Stop after choosing picks: no transcript, summary, surfacing, news or
   * Discover indexing. Candidate scores and rejections are still written, so
   * point the DB at a copy (setDbForTesting) for a side-effect-free run.
   */
  dryRun?: boolean;
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
  async runOnce(opts: RunOnceOptions = {}): Promise<RunStats> {
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
      const cfg = getConfig();
      const runStartIso = new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const prefilter = cfg.DISCOVERY_PREFILTER_ENABLED ? buildPrefilterConfig() : null;
      const knownChannels = loadKnownChannels(getDb());
      const quality: RunQuality = {
        seeds: [], searchPrefiltered: 0, queue: 0, queuePrefiltered: 0, scored: 0, belowGate: 0,
        gateThreshold: MIN_RELEVANCE_SIMILARITY, pool: 0, poolPrefiltered: 0, jevMode: "off",
        jevAsked: 0, jevHide: 0, jevUnsure: 0, jevPick: 0, jevErrors: 0, jevCost: 0, picks: 0,
      };
      stats.quality = quality;
      const seeds = cfg.DISCOVERY_SEED_MODE === "mixed" ? this.chooseSeeds() : undefined;
      // Goal seeds ride on top of the interest seeds (DISCOVERY_GOAL_SEEDS_PER_RUN extra calls).
      const goalSeedCount = seeds?.filter((s) => s.origin === "goal").length ?? 0;
      const fan = await fanOutSearch(this.maxSearchCallsPerRun + goalSeedCount, {
        seeds,
        relevanceLanguage: cfg.DISCOVERY_SEARCH_LANGUAGE || undefined,
        prefilter: prefilter ? { config: prefilter, knownChannels } : undefined,
      });
      quality.seeds = fan.seedsUsed.map((s) => s.query);
      quality.searchPrefiltered = fan.prefiltered;
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
      }
      // Reauth episode latch (reauth-latch.ts): one reauth message per expiry
      // episode — repeats stay silent, the first healthy run after a
      // reconnect sends exactly one recovery ping.
      await notifyReauthEpisode({
        reauthRequired: fan.reauthRequired,
        getBot: this.getBot,
        defaultChatIds: this.defaultChatIds,
      });

      // --- Step 5: pre-filter → score → relevance gate → enrich → Jev gate ---
      const inLibrary = rejectCandidatesAlreadyInLibrary();
      if (inLibrary > 0) log.info("Rejected candidates already in library", { count: inLibrary });
      const rawQueue = getScoringQueue(200);
      quality.queue = rawQueue.length;
      // Stage A: title/channel/duration rules on what we already know, before
      // spending an embedding call on the title.
      const channelTitles = new Map(listChannels().map((c) => [c.channel_id, c.channel_title]));
      const queue = prefilter
        ? rawQueue.filter((c) => {
            const channelTitle = queueChannelTitle(c, channelTitles);
            const v = prefilterCandidate({
              title: c.title,
              channelTitle,
              durationSeconds: c.duration_seconds,
              knownChannel: !!channelTitle && (knownChannels.get(channelTitle.toLowerCase()) ?? 0) > 0,
            }, prefilter);
            if (!v.reject) return true;
            updateCandidate(c.id, { status: "rejected", reason: prefilterReason(v) });
            quality.queuePrefiltered++;
            return false;
          })
        : rawQueue;
      const scored = await scoreCandidates(queue);
      quality.scored = scored.length;
      if (scored.length === 0) {
        log.info("No scoreable candidates this run");
        this.finishSeeds(fan.seedsUsed, runStartIso);
        completeRun(runId, stats);
        return stats;
      }

      // Decide how Jev will be reached before gating: without Jev the
      // embedding gate is the last line of defence, so it gets stricter.
      const jev = await this.resolveJev(quality);
      const gateThreshold = jev || cfg.DISCOVERY_JEV_GATE === "off"
        ? MIN_RELEVANCE_SIMILARITY
        : Math.max(MIN_RELEVANCE_SIMILARITY, cfg.DISCOVERY_FALLBACK_MIN_SIMILARITY);
      quality.gateThreshold = gateThreshold;

      // Relevance gate: only candidates that actually match an interest topic
      // may be processed (summarised into youtube_videos) and surfaced. The
      // rest are rejected so they neither cost a transcript run nor re-enter
      // the profile. Exploration below also draws only from the gated pool.
      const relevant = scored.filter((c) => passesRelevanceGate(c.breakdown, gateThreshold));
      for (const c of scored) {
        if (passesRelevanceGate(c.breakdown, gateThreshold)) continue;
        // By row id, not video_id: another source's row for the same video
        // may already be processed/surfaced and must keep its status.
        updateCandidate(c.id, {
          status: "rejected",
          reason: `below_relevance_gate: sim=${c.breakdown.similarityRaw.toFixed(3)} < ${gateThreshold}`,
        });
        quality.belowGate++;
      }
      log.info("Relevance gate", { scored: scored.length, passed: relevant.length, threshold: gateThreshold });
      if (relevant.length === 0) {
        this.finishSeeds(fan.seedsUsed, runStartIso);
        completeRun(runId, stats);
        return stats;
      }

      // Stage B: the top of the gated pool gets full metadata (1 quota unit
      // per 50) so duration, category and language rules apply to RSS
      // candidates too, and Jev sees the description.
      const vectors = await this.resolveVectors(relevant);
      const ranked = diversify(relevant, vectors, cfg.DISCOVERY_JEV_POOL + 10);
      const poolSize = jev ? cfg.DISCOVERY_JEV_POOL : Math.min(relevant.length, this.maxProcessPerRun * 3);
      const meta = await enrich(ranked.slice(0, poolSize + 10), stats);
      const pool: ScoredCandidate[] = [];
      for (const c of ranked) {
        if (pool.length >= poolSize) break;
        const m = meta.get(c.video_id);
        if (m && m.durationSeconds && !c.duration_seconds) updateCandidate(c.id, { duration_seconds: m.durationSeconds, view_count: m.viewCount });
        const channelTitle = m?.channelTitle || queueChannelTitle(c, channelTitles);
        if (prefilter) {
          const v = prefilterCandidate({
            title: c.title,
            channelTitle,
            durationSeconds: m ? m.durationSeconds : c.duration_seconds,
            categoryId: m?.categoryId,
            audioLanguage: m?.audioLanguage,
            textLanguage: m?.textLanguage,
            knownChannel: !!channelTitle && (knownChannels.get(channelTitle.toLowerCase()) ?? 0) > 0,
          }, prefilter);
          if (v.reject) {
            updateCandidate(c.id, { status: "rejected", reason: prefilterReason(v) });
            quality.poolPrefiltered++;
            continue;
          }
        }
        pool.push(c);
      }
      quality.pool = pool.length;

      let picks: ScoredCandidate[];
      if (jev) {
        picks = await this.jevGatePicks(jev, pool, meta, channelTitles, quality, runId);
      } else if (cfg.DISCOVERY_JEV_GATE === "required") {
        log.warn("Jev gate required but unavailable — nothing processed this run", { mode: quality.jevMode });
        stats.error = `jev gate unavailable (${quality.jevMode}); nothing processed`;
        picks = [];
      } else {
        picks = this.selectPicks(pool, pool.map((c) => c.vector ?? null));
      }
      quality.picks = picks.length;
      this.finishSeeds(fan.seedsUsed, runStartIso);
      this.logQuality(runId, quality);

      if (opts.dryRun) {
        stats.wouldProcess = picks.map((p) => ({ id: p.id, videoId: p.video_id, title: p.title, reason: p.reason ?? "" }));
        completeRun(runId, stats);
        log.info("Discovery dry run complete", { ...stats, runId });
        return stats;
      }

      // --- Step 6: fully process the top picks ---
      const processed: ProcessedPick[] = [];
      for (const pick of picks) {
        // Scoring awaits embeddings, so David may have sent this video since
        // the pre-scoring rejection; processing would re-surface his own pick.
        if (getVideo(pick.video_id)) {
          updateCandidate(pick.id, { status: "rejected", reason: ALREADY_IN_LIBRARY_REASON });
          continue;
        }
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
      // Off by default since 2026-09-26 (DISCOVERY_NEWS_ENABLED): 499 items a
      // month, mostly drama and sport, and none of them assets.
      let news: NewsItem[] = [];
      if (cfg.DISCOVERY_NEWS_ENABLED) {
        try {
          const mined = await mineNews();
          news = mined.items;
          // Persist so the weekly digest can pull this week's news highlights
          // instead of losing them once the Telegram surface message scrolls by.
          for (const item of news) {
            try {
              insertNewsItem(item);
            } catch (err) {
              log.warn("Failed to persist news item", { error: String(err) });
            }
          }
        } catch (err) {
          log.warn("News mining failed (non-fatal)", { error: String(err) });
        }
      }

      // --- Step 8: surface digest ---
      if (processed.length > 0 || news.length > 0) {
        const surfaced = await this.surfaceDigest(processed, news);
        stats.surfaced = surfaced;
      }

      // --- Step 8.5: index into Discover (topic-cluster all four sources) ---
      // Assigns any newly-eligible atlas items (YouTube discovery + watch-laters,
      // GitHub stars, Reddit saved) to topic-cluster digests for the Mini App.
      try {
        const { runDiscoverIndexer } = await import("../discover/indexer.ts");
        await runDiscoverIndexer();
      } catch (err) {
        log.warn("Discover indexing failed (non-fatal)", { error: String(err) });
      }

      // --- Step 9: prune stale/expired candidates (bounds unbounded growth) ---
      try {
        const expired = expireStaleCandidates();
        const pruned = pruneExpiredCandidates();
        if (expired > 0 || pruned > 0) {
          log.info("Pruned discovery candidates", { expired, pruned });
        }
      } catch (err) {
        log.warn("Candidate pruning failed (non-fatal)", { error: String(err) });
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

  /** Choose this run's search seeds (DISCOVERY_SEED_MODE=mixed). */
  private chooseSeeds(): Seed[] {
    try {
      const db = getDb();
      const profile = db
        .prepare<{ name: string; weight: number }, []>(
          `SELECT t.display_name AS name, w.weight FROM discovery_interest_weights w
             JOIN youtube_topics t ON t.id = w.topic_id WHERE w.weight > 0`,
        )
        .all();
      const pool = buildSeedPool(loadLeafWeights(db), profile);
      const state = parseSeedState(getState("seed_state"));
      const opts = { ...DEFAULT_SEED_PICK_OPTIONS, cooldownHours: getConfig().DISCOVERY_SEED_COOLDOWN_HOURS };
      const now = new Date();
      const seeds = pickSeeds(pool, this.maxSearchCallsPerRun, state, now, opts);
      // GOALS.md track seeds (marketing, TikTok growth, AI/drone video editing,
      // ffmpeg, …) are added after David's interest seeds, never instead of them.
      let goalSeeds: Seed[] = [];
      const nGoal = getConfig().DISCOVERY_GOAL_SEEDS_PER_RUN;
      if (nGoal > 0) {
        try {
          const taken = new Set(seeds.map((s) => s.query.toLowerCase()));
          const goalPool = buildGoalSeedPool(loadGoals().tracks).filter((s) => !taken.has(s.query.toLowerCase()));
          goalSeeds = pickGoalSeeds(goalPool, nGoal, state, now, opts);
        } catch (err) {
          log.warn("Goal seed selection failed (non-fatal)", { error: String(err) });
        }
      }
      log.info("Search seeds", {
        pool: pool.length,
        picked: seeds.map((s) => s.query),
        goal: goalSeeds.map((s) => `${s.track}: ${s.query}`),
      });
      return [...seeds, ...goalSeeds];
    } catch (err) {
      log.warn("Seed selection failed — falling back to profile topics", { error: String(err) });
      return [];
    }
  }

  /** Record each searched seed's yield: the share of its new candidates still alive after the gates. */
  private finishSeeds(used: Array<{ key: string; query: string }>, sinceIso: string): void {
    if (used.length === 0) return;
    try {
      const db = getDb();
      const q = db.prepare<{ found: number; alive: number }, [string, string]>(
        `SELECT COUNT(*) AS found, COALESCE(SUM(status != 'rejected'), 0) AS alive
           FROM discovery_candidates WHERE source = 'search' AND source_detail = ? AND discovered_at >= ?`,
      );
      let state = parseSeedState(getState("seed_state"));
      const now = new Date();
      for (const s of used) {
        const r = q.get(s.query, sinceIso) ?? { found: 0, alive: 0 };
        state = recordSeedUse(state, s.key, r.found, r.alive, now);
      }
      setState("seed_state", JSON.stringify(state));
    } catch (err) {
      log.warn("Seed yield bookkeeping failed (non-fatal)", { error: String(err) });
    }
  }

  /** How to reach Jev this run, honouring DISCOVERY_JEV_GATE and the daily cap. */
  private async resolveJev(quality: RunQuality): Promise<JevAsker | null> {
    const cfg = getConfig();
    if (cfg.DISCOVERY_JEV_GATE === "off") {
      quality.jevMode = "off";
      return null;
    }
    if (spentToday() >= cfg.DISCOVERY_JEV_DAILY_BUDGET_USD) {
      quality.jevMode = "daily-cap";
      return null;
    }
    const asker = await resolveJevAsker({ item: cfg.DISCOVERY_JEV_VAULT_ITEM, budgetUsd: cfg.DISCOVERY_JEV_BUDGET_USD });
    quality.jevMode = asker?.kind ?? "unavailable";
    return asker;
  }

  /**
   * Ask Jev about the pool. Hides are rejected; unsure are rejected or kept
   * (DISCOVERY_JEV_UNSURE); picks are ranked by P(interested). Candidates
   * Jev could not answer stay `candidate` for the next run.
   */
  private async jevGatePicks(
    jev: JevAsker,
    pool: ScoredCandidate[],
    meta: Map<string, VideoStat>,
    channelTitles: Map<string, string>,
    quality: RunQuality,
    runId: number,
  ): Promise<ScoredCandidate[]> {
    const cfg = getConfig();
    if (pool.length === 0) return [];
    let results: GateResult[] = [];
    try {
      const ctx = buildGateContext(getDb());
      const items: GateCandidate[] = pool.map((c) => {
        const m = meta.get(c.video_id);
        return {
          id: c.id,
          videoId: c.video_id,
          title: c.title ?? "",
          channelTitle: m?.channelTitle || queueChannelTitle(c, channelTitles),
          durationSeconds: m?.durationSeconds ?? c.duration_seconds,
          description: m?.description ?? null,
          tags: m?.tags ?? [],
        };
      });
      const run = await runJevGate(ctx, items, jev, { ...DEFAULT_THRESHOLDS, pick: cfg.DISCOVERY_JEV_PICK_THRESHOLD });
      results = run.results;
      quality.jevAsked = items.length;
      quality.jevErrors = run.errors.length + (run.budgetHit ? items.length - run.results.length - run.errors.length : 0);
      quality.jevCost = run.cost;
      recordGateSpend({ runId, items: items.length, liveCalls: run.liveCalls, cost: run.cost, kind: jev.kind });
    } catch (err) {
      log.warn("Jev gate failed — nothing processed this run", { error: String(err) });
      quality.jevErrors = pool.length;
      return [];
    }
    const byId = new Map(pool.map((c) => [c.id, c]));
    const picks: Array<{ c: ScoredCandidate; p: number }> = [];
    const order = new Map(pool.map((c, i) => [c.id, i]));
    results = [...results].sort((a, b) => (order.get(a.candidateId) ?? 0) - (order.get(b.candidateId) ?? 0));
    for (const r of results) {
      const c = byId.get(r.candidateId);
      if (!c) continue;
      const breakdown = JSON.stringify({
        ...c.breakdown,
        jev: { decision: r.decision, pNot: r.probs.pNot, pInterest: r.probs.pInterest, pProtected: r.probs.pProtected },
      });
      if (r.decision === "hide") {
        quality.jevHide++;
        updateCandidate(c.id, { status: "rejected", reason: `jev_gate:hide: ${r.reason}`.slice(0, 300), score_breakdown_json: breakdown });
      } else if (r.decision === "unsure") {
        quality.jevUnsure++;
        updateCandidate(c.id, cfg.DISCOVERY_JEV_UNSURE === "reject"
          ? { status: "rejected", reason: `jev_gate:unsure: ${r.reason}`.slice(0, 300), score_breakdown_json: breakdown }
          : { score_breakdown_json: breakdown });
      } else {
        quality.jevPick++;
        updateCandidate(c.id, { reason: `jev_gate:pick: ${r.reason}`.slice(0, 300), score_breakdown_json: breakdown });
        picks.push({ c: { ...c, reason: `jev_gate:pick: ${r.reason}` }, p: r.probs.pInterest });
      }
    }
    // Keep the pool's MMR order: every pick already cleared the P(interested)
    // bar, and re-sorting by P would undo the diversity re-rank.
    const ranked = picks.map((x) => x.c);
    // Exploration stays inside Jev's picks: never pull a hide or unsure back in.
    return epsilonGreedy(ranked.slice(0, this.maxProcessPerRun), ranked, Math.min(this.maxProcessPerRun, ranked.length), 0.15);
  }

  /** Keep the last 50 runs' stage counts where they can be inspected without log digging. */
  private logQuality(runId: number, quality: RunQuality): void {
    log.info("Discovery quality", { runId, ...quality });
    try {
      const prev = JSON.parse(getState("run_quality_log") ?? "[]") as unknown[];
      const next = [...(Array.isArray(prev) ? prev : []), { runId, at: new Date().toISOString(), ...quality }].slice(-50);
      setState("run_quality_log", JSON.stringify(next));
    } catch (err) {
      log.warn("Could not store run quality", { error: String(err) });
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
   * Diversity vectors for MMR: the title embeddings scoring already computed.
   *
   * We still never read the youtube_vec table here: on a long-lived
   * bun:sqlite connection, interleaving vec0 virtual-table reads with other
   * queries corrupts Bun's column-count metadata. Before 2026-09-26 this
   * returned all nulls, so MMR degraded to pure score order and a run could
   * pick three near-identical titles (a dry run's top 9 held six "don't buy
   * a Mac Studio for local AI" videos).
   */
  private async resolveVectors(scored: ScoredCandidate[]): Promise<(Float32Array | null)[]> {
    return scored.map((c) => c.vector ?? null);
  }

  // --- Surfacing ---

  /** Lazily create the discoveries topic if needed, then send the digest. */
  private async surfaceDigest(processed: ProcessedPick[], news: NewsItem[]): Promise<number> {
    // Mark picks surfaced regardless of delivery channel so the Mini App
    // (/tma/discover) always has fresh, browseable items.
    for (const { candidate } of processed) {
      try {
        setCandidateStatus(candidate.video_id, "surfaced", { surfacedAt: true });
      } catch (err) {
        log.error("Failed to mark candidate surfaced", { videoId: candidate.video_id, error: String(err) });
      }
    }

    // Telegram surfacing is opt-in (default off). The user browses digests in
    // the Mini App; the channel stays silent for content processing.
    if (!getConfig().DISCOVERY_SURFACE_TELEGRAM) {
      log.info("Discovery surfaced silently (Telegram delivery disabled)", {
        processed: processed.length,
        news: news.length,
      });
      return processed.length;
    }

    const bot = this.getBot();
    if (!bot) return processed.length;

    const { chatId, topicId } = await this.resolveTarget(bot);
    // resolveTarget() returns a null chatId when the group isn't configured or
    // createForumTopic failed (e.g. bot lacks "Manage Topics" rights). Don't
    // dead-end here — fall through to send(), which already falls back to
    // this.defaultChatIds (DM) exactly like this method should.
    if (!chatId && this.defaultChatIds.length === 0) return 0;

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
    chatId: string | number | null,
    topicId: number | undefined,
    text: string,
    kb?: InlineKeyboard,
  ): Promise<void> {
    // If no group chat id resolved, fall back to DMs.
    const targets: (string | number)[] = chatId ? [chatId] : this.defaultChatIds;
    for (const target of targets) {
      try {
        const sent = await bot.api.sendMessage(target, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(topicId ? { message_thread_id: topicId } : {}),
          ...(kb ? { reply_markup: kb } : {}),
        });
        recordSentMessage(target, sent.message_id, topicId ?? null, {
          source: "discovery",
          preview: text.slice(0, 200),
        });
      } catch (err) {
        log.error("Discovery send failed", { target, error: String(err) });
      }
    }
  }

}


// --- helpers ---

/**
 * MMR-order the first `k` candidates (relevance vs similarity to what is
 * already chosen), then append the rest in score order. mmrRerank returns its
 * input unchanged when k ≥ length, so cap k below the length.
 */
function diversify(cs: ScoredCandidate[], vectors: (Float32Array | null)[], k: number): ScoredCandidate[] {
  if (cs.length <= 1) return cs;
  const top = mmrRerank(cs, vectors, Math.min(k, cs.length - 1), 0.7);
  const seen = new Set(top.map((c) => c.id));
  return [...top, ...cs.filter((c) => !seen.has(c.id))];
}

/** Pre-filter settings from config, plus channels David's ratings keep rejecting. */
function buildPrefilterConfig(): PrefilterConfig {
  const cfg = getConfig();
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const blocked = new Set(list(cfg.DISCOVERY_BLOCKED_CHANNELS).map((c) => c.toLowerCase()));
  if (cfg.DISCOVERY_AUTO_BLOCK_CHANNELS) {
    try {
      for (const c of loadJunkChannels(getDb())) blocked.add(c);
    } catch (err) {
      log.warn("Could not derive junk channels (non-fatal)", { error: String(err) });
    }
  }
  return {
    ...DEFAULT_PREFILTER_CONFIG,
    minDurationSec: cfg.DISCOVERY_MIN_DURATION_SEC,
    maxDurationMinUnknownChannel: cfg.DISCOVERY_MAX_DURATION_MIN_UNKNOWN_CHANNEL,
    blockedCategoryIds: list(cfg.DISCOVERY_BLOCKED_CATEGORIES),
    allowedLanguages: list(cfg.DISCOVERY_ALLOWED_LANGUAGES).map((l) => l.toLowerCase()),
    blockedChannels: blocked,
  };
}

/** Channel title for a queued candidate: RSS/channel rows store it in source_detail; else the channel table. */
function queueChannelTitle(c: DiscoveryCandidate, channelTitles: Map<string, string>): string | null {
  if ((c.source === "rss" || c.source === "channel") && c.source_detail) return c.source_detail;
  return c.channel_id ? channelTitles.get(c.channel_id) ?? null : null;
}

/** videos.list metadata for the pool (1 quota unit per 50). Empty on failure. */
async function enrich(cands: DiscoveryCandidate[], stats: RunStats): Promise<Map<string, VideoStat>> {
  const out = new Map<string, VideoStat>();
  const ids = [...new Set(cands.map((c) => c.video_id))];
  for (let i = 0; i < ids.length; i += 50) {
    try {
      for (const s of await getVideoStats(ids.slice(i, i + 50))) out.set(s.videoId, s);
      stats.quotaUnitsUsed += 1;
    } catch (err) {
      log.warn("Pool enrichment failed (non-fatal)", { error: String(err) });
      break;
    }
  }
  return out;
}

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
