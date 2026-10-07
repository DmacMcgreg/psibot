/**
 * PublishedDateSweepRunner — gives newly archived tabs (and any saved link the
 * capture path missed) a publish date shortly after they arrive.
 *
 * tab-archive captures tabs in its own daemon and does not fetch pages, so
 * PsiBot sweeps its database (read-only) every 20 minutes and resolves up to
 * 150 new URLs per run with `sweepPublishedDates` — the same code the backfill
 * script runs. Already-checked URLs are never fetched again. Failures only log.
 */
import { Cron } from "croner";
import { getDb } from "../db/index.ts";
import { getConfig } from "../config.ts";
import { sweepPublishedDates } from "../capture/published-date-sweep.ts";
import { redditAppTokenFromEnv } from "../capture/published-date-resolver.ts";
import { getVideoStats } from "../youtube/api.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("published-date-sweep");

const SWEEP_CRON = "*/20 * * * *";
const PER_RUN_LIMIT = 150;

export class PublishedDateSweepRunner {
  private cron: Cron | null = null;
  private running = false;
  /** No-op unless the daemon's env has REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET. */
  private redditToken = redditAppTokenFromEnv();

  start(): void {
    this.cron = new Cron(SWEEP_CRON, { protect: true }, () => {
      this.runNow().catch((err) => log.error("Publish-date sweep failed", { error: String(err) }));
    });
    log.info("Publish-date sweep runner started", { pattern: SWEEP_CRON, limit: PER_RUN_LIMIT });
  }

  stop(): void {
    this.cron?.stop();
    this.cron = null;
  }

  async runNow(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const report = await sweepPublishedDates({
        db: getDb(),
        limit: PER_RUN_LIMIT,
        githubToken: getConfig().GITHUB_TOKEN || undefined,
        redditToken: this.redditToken,
        youtubeStats: getVideoStats,
      });
      if (report.candidates.selected > 0 || report.itemsUpdated > 0) {
        log.info("Publish-date sweep", {
          resolved: report.candidates.selected,
          byStatus: report.byStatus,
          itemsUpdated: report.itemsUpdated,
          ms: report.durationMs,
        });
      }
    } catch (err) {
      log.error("Publish-date sweep error", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.running = false;
    }
  }
}
