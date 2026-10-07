/**
 * AssetFeedRunner: runs each asset feed (src/assets/feeds) on its own croner
 * schedule, one feed at a time so model calls never pile up.
 *
 * On start it also queues, after a short delay, any feed whose last run is
 * older than its interval (the daemon was down when it was due). Feed runs
 * never throw; each writes its counts to ops_state (`assets:feeds`).
 *
 * Health: after every *scheduled* run (cron or catch-up — not a manual
 * runOnce()), a feed that came back with no data at all (the source returned
 * nothing, e.g. renamed CSV headers) or with zero candidates on two
 * consecutive scheduled runs gets one Telegram ops alert, via the same
 * `sendOpsAlert` path other runners use (see maintenance/log-rotation.ts) so
 * it's naturally throttled to once per feed per 24h and queued/flushed the
 * same way if the bot isn't wired up yet. The consecutive-empty count is
 * small per-feed state in ops_state (feeds/common.ts's getFeedMemo/setFeedMemo),
 * not a new table.
 */

import { Cron } from "croner";
import { FEEDS, type FeedDef } from "./feeds/index.ts";
import { readFeedState, newStats, saveStats, getFeedMemo, setFeedMemo, type FeedStats } from "./feeds/common.ts";
import { sendOpsAlert, oneLine } from "../shared/ops-alerts.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("asset-feeds");
const TZ = "America/Toronto";
const CATCH_UP_DELAY_MS = 3 * 60_000;
/** 0 candidates for this many scheduled runs in a row before it's worth alerting on. */
const EMPTY_RUNS_BEFORE_ALERT = 2;

interface FeedHealthState {
  consecutiveEmptyCandidates: number;
}

/**
 * Checked only for scheduled runs. `seen === 0` (with no error already
 * explaining it) covers both "the source returned nothing" and "the expected
 * CSV headers are missing" — a header rename means every row fails to key on
 * the reference column, so the feed collects zero rows without ever
 * throwing. `errors.length` covers feeds that throw instead (e.g. Ontario's
 * "no programs parsed" guard).
 */
export function checkFeedHealth(f: Pick<FeedDef, "name">, stats: FeedStats): void {
  try {
    const noData = stats.seen === 0 || stats.errors.length > 0;
    const state = getFeedMemo<FeedHealthState>(f.name, "health") ?? { consecutiveEmptyCandidates: 0 };
    const emptyCandidates = stats.seen > 0 && stats.candidates === 0;
    state.consecutiveEmptyCandidates = emptyCandidates ? state.consecutiveEmptyCandidates + 1 : 0;
    setFeedMemo(f.name, "health", state);

    if (noData) {
      const reason = stats.errors.length ? oneLine(stats.errors[0]) : "the source returned 0 items (its expected format may have changed)";
      log.error("asset feed unhealthy: no data", { feed: f.name, seen: stats.seen, reason });
      void sendOpsAlert(`asset-feed-health:${f.name}`, `Asset feed "${f.name}" found nothing this run: ${reason}. It may need a look before its data on /assets goes stale.`);
    } else if (state.consecutiveEmptyCandidates >= EMPTY_RUNS_BEFORE_ALERT) {
      log.error("asset feed unhealthy: 0 candidates on consecutive scheduled runs", { feed: f.name, seen: stats.seen, runs: state.consecutiveEmptyCandidates });
      void sendOpsAlert(`asset-feed-health:${f.name}`, `Asset feed "${f.name}" saw ${stats.seen} items but kept 0 candidates on its last ${state.consecutiveEmptyCandidates} scheduled runs. Its rules may need a look.`);
    }
  } catch (e) {
    // Never let a health check itself take down a feed run.
    log.error("asset feed health check failed", { feed: f.name, error: String(e) });
  }
}

export class AssetFeedRunner {
  private crons: Cron[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private feeds: FeedDef[] = FEEDS) {}

  start(): void {
    if (this.crons.length) return;
    for (const f of this.feeds) {
      this.crons.push(new Cron(f.schedule, { timezone: TZ, protect: true }, () => {
        this.enqueue(f, { scheduled: true }).catch(() => {});
      }));
    }
    this.catchUpTimer = setTimeout(() => {
      for (const f of this.feeds) {
        const at = readFeedState(f.name)?.last?.finished_at;
        const age = at ? (Date.now() - Date.parse(at)) / 3_600_000 : Infinity;
        if (age >= f.everyHours) this.enqueue(f, { scheduled: true }).catch(() => {});
      }
    }, CATCH_UP_DELAY_MS);
    log.info("Asset feed runner started", { feeds: this.feeds.map((f) => `${f.name}@${f.schedule}`) });
  }

  stop(): void {
    for (const c of this.crons) c.stop();
    this.crons = [];
    if (this.catchUpTimer) clearTimeout(this.catchUpTimer);
    this.catchUpTimer = null;
  }

  /**
   * Run one feed by name, or every feed in order. Resolves with each feed's
   * stats. A manual run like this never counts towards the "2 consecutive
   * scheduled runs" health check, and never raises a health alert on its own.
   */
  async runOnce(feed?: string): Promise<Record<string, FeedStats>> {
    const targets = feed ? this.feeds.filter((f) => f.name === feed) : this.feeds;
    if (feed && targets.length === 0) throw new Error(`unknown feed: ${feed} (known: ${this.feeds.map((f) => f.name).join(", ")})`);
    const out: Record<string, FeedStats> = {};
    for (const f of targets) {
      const s = await this.enqueue(f, { force: true });
      if (s) out[f.name] = s;
    }
    return out;
  }

  feedNames(): string[] {
    return this.feeds.map((f) => f.name);
  }

  /** Serialize runs; a feed already waiting in the queue is not queued twice (unless forced). */
  private enqueue(f: FeedDef, opts: { force?: boolean; scheduled?: boolean } = {}): Promise<FeedStats | null> {
    const { force = false, scheduled = false } = opts;
    if (this.pending.has(f.name) && !force) return Promise.resolve(null);
    this.pending.add(f.name);
    const job = this.queue.then(async () => {
      try {
        let stats: FeedStats;
        try {
          stats = await f.run();
        } catch (e) {
          // Feeds catch their own errors; this is a last line of defence.
          stats = newStats(f.name);
          stats.errors.push(e instanceof Error ? e.message : String(e));
          stats.finished_at = new Date().toISOString();
          saveStats(stats);
          log.error("feed crashed", { feed: f.name, error: String(e) });
        }
        if (scheduled) checkFeedHealth(f, stats);
        return stats;
      } finally {
        this.pending.delete(f.name);
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
