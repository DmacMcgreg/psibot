import { Cron } from "croner";
import {
  getEnabledJobs,
  getAllJobs,
  getJob,
  updateJob,
  getJobRuns,
  abandonStaleJobRuns,
  reapRestartOrphanedJobRuns,
  getOpsState,
  setOpsState,
  getLastEnabledAt,
} from "../db/queries.ts";
import { JobExecutor } from "./executor.ts";
import { providerWindowResetUntil, staggeredWindowWait } from "./provider-window.ts";
import {
  SELF_CHECK_INTERVAL_MS,
  ORPHAN_RUN_MAX_AGE_HOURS,
  ABANDONED_RUN_ERROR,
  missedFireCount,
  isDeliberatelyPaused,
  overdueBaseline,
  failedRetryDue,
  localDayAndHour,
  parseDbTime,
} from "./watchdog.ts";
import { sendOpsAlert } from "../shared/ops-alerts.ts";
import { jobAlertKey, jobMissedAlertText } from "./job-alerts.ts";
import { createLogger } from "../shared/logger.ts";
import type { Job } from "../shared/types.ts";

const log = createLogger("scheduler");

/** ops_state key: local day (YYYY-MM-DD) of the last daily failed-job retry. */
const FAILED_RETRY_STATE_KEY = "scheduler:failed-retry-day";
/** ops_state key prefix: when the self-check last re-registered job <id>. */
const HEALED_STATE_PREFIX = "scheduler:healed:";

/** The slice of JobExecutor the Scheduler drives — structural so tests
 *  inject a recording executor without the class's private state. */
type SchedulerExecutor = Pick<JobExecutor, "execute" | "onJobRecovered" | "onProviderRetry">;

export class Scheduler {
  private executor: SchedulerExecutor;
  private cronJobs = new Map<number, Cron>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** One-shot provider-window retries, with the slot each was staggered into. */
  private providerRetries = new Map<number, { timer: Timer; slot: number }>();
  private selfCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** When the self-check last re-registered each job (restarts its overdue clock). */
  private healedAt = new Map<number, Date>();
  /** Cron expressions that failed to parse, so the self-check logs them once, not every tick. */
  private invalidSchedules = new Map<number, string>();

  constructor(executor: JobExecutor | SchedulerExecutor, bootAt: Date = new Date()) {
    this.executor = executor;
    this.wireExecutorHooks();
    this.bootAt = bootAt;
  }

  /**
   * Executor → scheduler hooks. Public for tests; idempotent, and wired in
   * the constructor, so an explicit call is always safe.
   */
  wireExecutorHooks(): void {
    this.executor.onJobRecovered = () => this.reload();
    this.executor.onProviderRetry = (jobId, at) => this.scheduleProviderRetry(jobId, at);
  }

  /**
   * Fire a job exactly once after the provider window resets. Simultaneous
   * retries (the 04:00Z trio all parse the same deadline) are staggered by
   * WINDOW_RUN_STAGGER_MS per slot so they don't re-collide at the opening;
   * the enabled check happens at fire time, so a job disabled (or taken off
   * the schedule by the streak counter) before the window opens never fires.
   */
  private scheduleProviderRetry(jobId: number, at: Date): void {
    if (this.providerRetries.has(jobId)) return; // one pending retry per job
    const slot = this.providerRetries.size;
    const wait = staggeredWindowWait(at, slot);
    log.info("Scheduling provider-window retry", { jobId, slot, waitMs: wait, at: at.toISOString() });
    const timer: Timer = setTimeout(() => {
      this.providerRetries.delete(jobId);
      const job = getJob(jobId);
      if (!job || job.status !== "enabled") {
        log.info("Provider-window retry skipped (job no longer enabled)", { jobId, status: job?.status ?? "missing" });
        return;
      }
      this.executor.execute(jobId, { providerRetry: true }).catch((err) => {
        log.error("Provider-window retry failed", { jobId, error: String(err) });
      });
    }, wait);
    timer.unref?.();
    this.providerRetries.set(jobId, { timer, slot });
  }

  /**
   * When this process booted (Scheduler construction — before any job can
   * run). A `job_runs` row still "running" from before this moment belongs
   * to a process that no longer exists; the self-check reaps it.
   */
  private readonly bootAt: Date;

  start(): void {
    this.reload();
    this.selfCheck();
    if (!this.selfCheckTimer) {
      this.selfCheckTimer = setInterval(() => this.selfCheck(), SELF_CHECK_INTERVAL_MS);
      this.selfCheckTimer.unref?.();
    }
    log.info("Scheduler started");
  }

  reload(): void {
    // Stop all existing
    this.stopAll();

    const jobs = getEnabledJobs();
    for (const job of jobs) {
      this.scheduleJob(job);
    }

    log.info("Scheduler reloaded", { jobCount: jobs.length });
  }

  trigger(jobId: number): void {
    log.info("Manually triggering job", { jobId });
    this.executor.execute(jobId, { manualTrigger: true }).catch((err) => {
      log.error("Manual trigger failed", { jobId, error: String(err) });
    });
  }

  stop(): void {
    if (this.selfCheckTimer) clearInterval(this.selfCheckTimer);
    this.selfCheckTimer = null;
    this.stopAll();
    log.info("Scheduler stopped");
  }

  /**
   * Make the live timers match the jobs table, so an enabled cron job can't
   * silently stop firing. Runs at start and every SELF_CHECK_INTERVAL_MS:
   *
   * - Stops timers for jobs that are no longer enabled (e.g. set "failed" or
   *   disabled by a path that didn't call reload()).
   * - Registers enabled cron jobs that have no live timer or whose schedule
   *   changed (e.g. re-enabled straight in the DB).
   * - Re-registers any enabled cron job with two or more scheduled fire times
   *   since its last run (last run older than ~2× its interval), and logs it.
   *   Sends one Telegram ops alert per job (24 h de-dupe).
   * - Closes out job_runs rows stuck in "running" for ORPHAN_RUN_MAX_AGE_HOURS.
   * - Once a day (from FAILED_RETRY_HOUR local), re-enables "failed" cron jobs
   *   (retryFailedCronJobs); the loop below then registers their timers.
   *
   * Never throws: a self-check failure is logged and retried next tick.
   */
  selfCheck(now: Date = new Date()): { stopped: number[]; registered: number[]; overdue: number[]; abandonedRuns: number; retried: number[] } {
    const report = { stopped: [] as number[], registered: [] as number[], overdue: [] as number[], abandonedRuns: 0, retried: [] as number[] };
    try {
      // Boot arm first, so a row matching both gets the precise "orphaned by
      // restart" message; the age arm only sees what's left (same-process hangs).
      const restartOrphans = reapRestartOrphanedJobRuns(this.bootAt, ABANDONED_RUN_ERROR);
      if (restartOrphans > 0) {
        log.warn("Reaped job runs orphaned by a restart", { count: restartOrphans, daemonBoot: this.bootAt.toISOString() });
      }
      report.abandonedRuns = restartOrphans + abandonStaleJobRuns(ORPHAN_RUN_MAX_AGE_HOURS, ABANDONED_RUN_ERROR);
      if (report.abandonedRuns > restartOrphans) {
        log.warn("Closed out stale job runs", { count: report.abandonedRuns - restartOrphans, olderThanHours: ORPHAN_RUN_MAX_AGE_HOURS });
      }

      if (failedRetryDue(now, getOpsState(FAILED_RETRY_STATE_KEY))) {
        report.retried = this.retryFailedCronJobs(now);
      }

      const cronJobs = getEnabledJobs().filter((j) => j.type === "cron" && j.schedule);
      const enabledIds = new Set(cronJobs.map((j) => j.id));

      for (const [jobId, cron] of this.cronJobs) {
        if (enabledIds.has(jobId)) continue;
        cron.stop();
        this.cronJobs.delete(jobId);
        report.stopped.push(jobId);
        log.warn("Self-check stopped timer for a job that is no longer enabled", { jobId });
      }

      for (const job of cronJobs) {
        const schedule = job.schedule!;
        if (this.invalidSchedules.get(job.id) === schedule) continue;

        const cron = this.cronJobs.get(job.id);
        let reason: string | null = null;
        let detail: Record<string, unknown> = {};
        let missed: { since: Date; lastError: string | null } | null = null;
        if (!cron) reason = "no timer registered";
        else if (cron.isStopped() || cron.nextRun() === null) reason = "timer stopped";
        else if (cron.getPattern() !== schedule) reason = "schedule changed";
        else if (!isDeliberatelyPaused(job, now)) {
          const lastRunRow = getJobRuns(job.id, 1)[0];
          const lastRun = lastRunRow?.started_at ?? null;
          const since = overdueBaseline(job, lastRun, this.overdueResetAt(job.id));
          if (missedFireCount(schedule, since, now) >= 2) {
            reason = "overdue";
            detail = { lastRun, since: since.toISOString() };
            report.overdue.push(job.id);
            missed = { since, lastError: lastRunRow?.status === "error" ? lastRunRow.error : null };
          }
        }
        if (!reason) continue;

        cron?.stop();
        this.cronJobs.delete(job.id);
        this.scheduleJob(job);
        this.healedAt.set(job.id, now);
        setOpsState(`${HEALED_STATE_PREFIX}${job.id}`, now.toISOString());
        report.registered.push(job.id);
        log.warn("Self-check re-registered cron job", {
          jobId: job.id,
          name: job.name,
          schedule,
          reason,
          ...detail,
          nextRun: this.cronJobs.get(job.id)?.nextRun()?.toISOString() ?? null,
        });
        if (missed) {
          void sendOpsAlert(
            jobAlertKey(job.id),
            jobMissedAlertText(job, missed.since, this.cronJobs.get(job.id)?.nextRun() ?? null, missed.lastError),
            now,
          );
        }
      }
    } catch (err) {
      log.error("Scheduler self-check failed", { error: String(err) });
    }
    return report;
  }

  /**
   * Latest moment that restarts a job's overdue clock: the self-check last
   * re-registered it (kept in ops_state too, so a daemon restart doesn't
   * re-flag — and re-alert — the same stale job) or it was last enabled.
   */
  private overdueResetAt(jobId: number): Date | undefined {
    const times = [
      this.healedAt.get(jobId) ?? null,
      parseDbTime(getOpsState(`${HEALED_STATE_PREFIX}${jobId}`)),
      parseDbTime(getLastEnabledAt(jobId)),
    ].filter((d): d is Date => d !== null);
    return times.length > 0 ? new Date(Math.max(...times.map((d) => d.getTime()))) : undefined;
  }

  /**
   * Daily retry: set every "failed" cron job back to "enabled" (audited in
   * job_config_history), so its next scheduled run tries again. The executor
   * counts its failure streak from this re-enable, so three more errors in a
   * row put it back to "failed" (and alert again). One-off jobs are never
   * retried. Records the local day so it runs once per day across restarts.
   */
  retryFailedCronJobs(now: Date = new Date()): number[] {
    const { day } = localDayAndHour(now);
    setOpsState(FAILED_RETRY_STATE_KEY, day);
    const failed = getAllJobs().filter((j) => j.type === "cron" && j.status === "failed" && j.schedule);
    for (const job of failed) {
      updateJob(job.id, { status: "enabled" }, {
        by: "system",
        reason: `daily retry of failed cron job (${day}); back to failed after 3 more errors in a row`,
      });
      log.warn("Daily retry re-enabled failed cron job", { jobId: job.id, name: job.name, schedule: job.schedule });
    }
    if (failed.length === 0) log.info("Daily failed-job retry: nothing to retry", { day });
    return failed.map((j) => j.id);
  }

  private scheduleJob(job: Job): void {
    if (job.type === "cron" && job.schedule) {
      try {
        const cron = new Cron(job.schedule, () => {
          // A fire that lands inside a known-exhausted provider window would
          // burn a run straight into the same [1308] the window state was
          // minted from (the 04:00Z trio collision). Defer to the next fire
          // after the deadline; the executor's retry arm already scheduled
          // the job that hit the envelope back in once the window opens.
          const exhaustedUntil = providerWindowResetUntil();
          if (exhaustedUntil) {
            log.info("Provider window exhausted — deferring cron fire", {
              jobId: job.id,
              name: job.name,
              until: exhaustedUntil.toISOString(),
            });
            return;
          }
          this.executor.execute(job.id).catch((err) => {
            log.error("Cron job execution failed", {
              jobId: job.id,
              error: String(err),
            });
          });
        });

        const nextRun = cron.nextRun();
        if (nextRun) {
          updateJob(job.id, { next_run_at: nextRun.toISOString() });
        }

        this.cronJobs.set(job.id, cron);
        this.invalidSchedules.delete(job.id);
        log.info("Scheduled cron job", {
          jobId: job.id,
          name: job.name,
          schedule: job.schedule,
          nextRun: nextRun?.toISOString(),
        });
      } catch (err) {
        this.invalidSchedules.set(job.id, job.schedule);
        log.error("Invalid cron expression", {
          jobId: job.id,
          schedule: job.schedule,
          error: String(err),
        });
      }
    } else if (job.type === "once" && job.run_at) {
      try {
        // Only bare timestamps (no timezone marker) need a Z appended to be
        // parsed as UTC. Values that already carry an offset (+/-HH:MM) or a
        // trailing Z must be left as-is, or appending 'Z' produces an invalid
        // string like "...-04:00Z" that throws on toISOString().
        const hasTzMarker = /(Z|[+-]\d{2}:\d{2})$/.test(job.run_at);
        const runAtStr = hasTzMarker ? job.run_at : job.run_at + "Z";
        const runAt = new Date(runAtStr);

        if (Number.isNaN(runAt.getTime())) {
          log.error("Invalid run_at for one-off job, marking failed", {
            jobId: job.id,
            runAt: job.run_at,
          });
          updateJob(job.id, { status: "failed" });
          return;
        }

        const delay = runAt.getTime() - Date.now();

        if (delay <= 0) {
          // Already past due, execute immediately
          log.info("One-off job past due, executing now", { jobId: job.id });
          this.executor.execute(job.id).catch((err) => {
            log.error("One-off execution failed", {
              jobId: job.id,
              error: String(err),
            });
          });
        } else {
          const timer = setTimeout(() => {
            this.timers.delete(job.id);
            this.executor.execute(job.id).catch((err) => {
              log.error("One-off execution failed", {
                jobId: job.id,
                error: String(err),
              });
            });
          }, delay);

          this.timers.set(job.id, timer);
          updateJob(job.id, { next_run_at: runAt.toISOString() });
          log.info("Scheduled one-off job", {
            jobId: job.id,
            name: job.name,
            runAt: runAt.toISOString(),
            delayMs: delay,
          });
        }
      } catch (err) {
        log.error("Failed to schedule one-off job", {
          jobId: job.id,
          runAt: job.run_at,
          error: String(err),
        });
        updateJob(job.id, { status: "failed" });
      }
    }
  }

  private stopAll(): void {
    for (const cron of this.cronJobs.values()) {
      cron.stop();
    }
    this.cronJobs.clear();

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();

    for (const { timer } of this.providerRetries.values()) {
      clearTimeout(timer);
    }
    this.providerRetries.clear();
  }
}
