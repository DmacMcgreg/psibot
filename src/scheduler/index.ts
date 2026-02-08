import { Cron } from "croner";
import { getEnabledJobs, updateJob } from "../db/queries.ts";
import { JobExecutor } from "./executor.ts";
import { createLogger } from "../shared/logger.ts";
import type { Job } from "../shared/types.ts";

const log = createLogger("scheduler");

export class Scheduler {
  private executor: JobExecutor;
  private cronJobs = new Map<number, Cron>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(executor: JobExecutor) {
    this.executor = executor;
  }

  start(): void {
    this.reload();
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
    this.executor.execute(jobId).catch((err) => {
      log.error("Manual trigger failed", { jobId, error: String(err) });
    });
  }

  stop(): void {
    this.stopAll();
    log.info("Scheduler stopped");
  }

  private scheduleJob(job: Job): void {
    if (job.type === "cron" && job.schedule) {
      try {
        const cron = new Cron(job.schedule, () => {
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
        log.info("Scheduled cron job", {
          jobId: job.id,
          name: job.name,
          schedule: job.schedule,
          nextRun: nextRun?.toISOString(),
        });
      } catch (err) {
        log.error("Invalid cron expression", {
          jobId: job.id,
          schedule: job.schedule,
          error: String(err),
        });
      }
    } else if (job.type === "once" && job.run_at) {
      // Ensure run_at is parsed as UTC (append Z if missing)
      const runAtStr = job.run_at.endsWith("Z") ? job.run_at : job.run_at + "Z";
      const runAt = new Date(runAtStr);
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
  }
}
