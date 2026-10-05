import { oneLine } from "../shared/ops-alerts.ts";
import { CRON_FAILURE_STREAK, FAILED_RETRY_HOUR } from "./watchdog.ts";
import type { Job } from "../shared/types.ts";

/**
 * Text for the ops alerts (src/shared/ops-alerts.ts) the scheduler sends to
 * David's DM. Plain text, three short lines: which job, what happened, the
 * last error. Keyed `job:<id>`, so one job alerts at most once per 24 h.
 */

type JobRef = Pick<Job, "id" | "name" | "type">;

const fmt = (d: Date | null) =>
  d
    ? d.toLocaleString("en-US", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "unknown";

export function jobAlertKey(jobId: number): string {
  return `job:${jobId}`;
}

export function jobFailedAlertText(job: JobRef, error: string | null): string {
  const what = job.type === "cron"
    ? `Went "failed" after ${CRON_FAILURE_STREAK} errors in a row and is off the schedule. PsiBot re-enables it once a day (from ${FAILED_RETRY_HOUR}:00).`
    : `One-off job went "failed"; it won't be retried.`;
  return [
    `PsiBot job failed: ${job.name} (#${job.id})`,
    what,
    `Last error: ${oneLine(error) || "none recorded"}`,
  ].join("\n");
}

export function jobMissedAlertText(
  job: JobRef,
  lastActivity: Date,
  nextRun: Date | null,
  lastError: string | null,
): string {
  return [
    `PsiBot job missed runs: ${job.name} (#${job.id})`,
    `No run since ${fmt(lastActivity)} despite 2+ scheduled times. Timer re-registered; next run ${fmt(nextRun)}.`,
    `Last error: ${oneLine(lastError) || "none"}`,
  ].join("\n");
}
