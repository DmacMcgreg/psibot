import { Cron } from "croner";
import type { Job, JobRun } from "../shared/types.ts";

/**
 * Pure helpers for the scheduler's self-check (Scheduler.selfCheck). Kept free
 * of DB and timer state so they can be tested directly.
 */

/** How often the scheduler runs its self-check. */
export const SELF_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** A `job_runs` row still "running" after this long belongs to a dead process. */
export const ORPHAN_RUN_MAX_AGE_HOURS = 6;

/** Slack after a scheduled fire time before it counts as missed. */
const FIRE_GRACE_MS = 10 * 60 * 1000;

/**
 * Parse a DB timestamp as UTC. The tables mix `YYYY-MM-DD HH:MM:SS` (SQLite
 * `datetime('now')`, no zone marker), the same with a trailing `Z`, and full
 * ISO strings; all of them are UTC.
 */
export function parseDbTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = value.trim().replace(" ", "T");
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Count the scheduled fire times (capped at `cap`) that fell after `since`
 * and more than the grace period before `now`. Two or more means the job's
 * last activity is older than two of its intervals: its timer is not firing.
 *
 * Counting real fire times (rather than comparing against 2× a fixed interval)
 * keeps irregular schedules honest — a weekday-only job is not overdue on a
 * Monday morning just because the weekend gap is longer than one day.
 */
export function missedFireCount(schedule: string, since: Date, now: Date, cap = 2): number {
  const pattern = new Cron(schedule); // no callback: evaluates the pattern, starts no timer
  const cutoff = now.getTime() - FIRE_GRACE_MS;
  return pattern.nextRuns(cap, since).filter((d) => d.getTime() <= cutoff).length;
}

/** True while `skip_runs` or a future `paused_until` makes the executor skip fires on purpose. */
export function isDeliberatelyPaused(job: Pick<Job, "paused_until" | "skip_runs">, now: Date): boolean {
  if ((job.skip_runs ?? 0) > 0) return true;
  const until = parseDbTime(job.paused_until);
  return until !== null && until > now;
}

/**
 * The moment from which the job's timer is expected to have fired: the latest
 * of its last run, creation, the end of a pause, and the last time the
 * self-check re-registered it.
 */
export function overdueBaseline(
  job: Pick<Job, "created_at" | "last_run_at" | "paused_until">,
  lastRunStartedAt: string | null | undefined,
  lastHealedAt?: Date,
): Date {
  const candidates = [
    parseDbTime(lastRunStartedAt),
    parseDbTime(job.last_run_at),
    parseDbTime(job.created_at),
    parseDbTime(job.paused_until),
    lastHealedAt ?? null,
  ].filter((d): d is Date => d !== null);
  return new Date(Math.max(0, ...candidates.map((d) => d.getTime())));
}

/** Prefix on `job_runs.error` for runs closed out by the orphan sweep. */
export const ABANDONED_RUN_ERROR = "abandoned";

export function isAbandonedRun(run: Pick<JobRun, "status" | "error">): boolean {
  return run.status === "error" && (run.error ?? "").startsWith(ABANDONED_RUN_ERROR);
}

/**
 * A cron job rides out transient failures; only this many errored runs in a
 * row take it off the schedule (status "failed"). Runs closed out by the
 * orphan sweep (the daemon restarted mid-run) don't count as errors here.
 */
export const CRON_FAILURE_STREAK = 3;

/**
 * `recentRuns` is newest first and includes the run that just errored.
 * `countSince` (the job's last failed → enabled change) drops older runs, so a
 * re-enabled job gets a fresh CRON_FAILURE_STREAK tries instead of going back
 * to "failed" on its first new error.
 */
export function shouldMarkFailed(
  jobType: Job["type"],
  recentRuns: Array<Pick<JobRun, "status" | "error"> & { started_at?: string | null }>,
  countSince?: Date | null,
): boolean {
  if (jobType !== "cron") return true;
  const counted = recentRuns
    .filter((r) => !isAbandonedRun(r))
    .filter((r) => {
      if (!countSince) return true;
      const started = parseDbTime(r.started_at);
      return started === null || started.getTime() >= countSince.getTime();
    })
    .slice(0, CRON_FAILURE_STREAK);
  return counted.length >= CRON_FAILURE_STREAK && counted.every((r) => r.status === "error");
}

/** Local zone for the daily failed-job retry (the daemon's home zone). */
export const RETRY_TIMEZONE = "America/Toronto";

/** Local hour from which the day's failed-job retry may run — after quiet hours, so its notices land in the day. */
export const FAILED_RETRY_HOUR = 9;

/** `YYYY-MM-DD` and hour of `now` in `timeZone`. */
export function localDayAndHour(now: Date, timeZone: string = RETRY_TIMEZONE): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** The daily retry is due once per local day, at or after FAILED_RETRY_HOUR. */
export function failedRetryDue(now: Date, lastRetryDay: string | null): boolean {
  const { day, hour } = localDayAndHour(now);
  return hour >= FAILED_RETRY_HOUR && lastRetryDay !== day;
}
