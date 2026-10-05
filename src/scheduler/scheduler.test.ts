import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { Scheduler } from "./index.ts";
import type { JobExecutor } from "./executor.ts";
import {
  missedFireCount,
  overdueBaseline,
  parseDbTime,
  shouldMarkFailed,
  isDeliberatelyPaused,
  ABANDONED_RUN_ERROR,
} from "./watchdog.ts";

/**
 * Scheduler self-check: an enabled cron job must not silently stop firing.
 * Jobs 31/62/66 went "failed" after one errored run and were dropped at the
 * next reload; when re-enabled straight in the DB nothing re-registered them.
 */

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM job_runs; DELETE FROM jobs;");
});

function fakeExecutor(): JobExecutor {
  return { onJobRecovered: null, execute: async () => {} } as unknown as JobExecutor;
}

function addJob(fields: { name?: string; schedule?: string; status?: string; created_at?: string; last_run_at?: string | null; paused_until?: string | null; skip_runs?: number; type?: string }): number {
  const row = db
    .prepare(
      `INSERT INTO jobs (name, prompt, type, schedule, status, created_at, last_run_at, paused_until, skip_runs)
       VALUES (?, 'p', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      fields.name ?? "job",
      fields.type ?? "cron",
      fields.schedule ?? "0 6 * * *",
      fields.status ?? "enabled",
      fields.created_at ?? "2026-01-01 00:00:00",
      fields.last_run_at ?? null,
      fields.paused_until ?? null,
      fields.skip_runs ?? 0,
    ) as { id: number };
  return row.id;
}

function addRun(jobId: number, status: string, startedAt: string, error: string | null = null): number {
  const row = db
    .prepare(`INSERT INTO job_runs (job_id, status, started_at, error) VALUES (?, ?, ?, ?) RETURNING id`)
    .get(jobId, status, startedAt, error) as { id: number };
  return row.id;
}

const iso = (d: Date) => d.toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

describe("Scheduler.selfCheck", () => {
  let scheduler: Scheduler;
  beforeEach(() => {
    scheduler = new Scheduler(fakeExecutor());
  });
  afterEach(() => scheduler.stop());

  it("registers an enabled cron job that was enabled without a reload", () => {
    scheduler.reload();
    const id = addJob({ last_run_at: iso(hoursAgo(1)) });
    const report = scheduler.selfCheck();
    expect(report.registered).toEqual([id]);
    // Now live: a second pass leaves it alone.
    expect(scheduler.selfCheck().registered).toEqual([]);
  });

  it("stops the timer of a job whose status changed outside reload()", () => {
    const id = addJob({ last_run_at: iso(hoursAgo(1)) });
    scheduler.reload();
    db.prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(id);
    expect(scheduler.selfCheck().stopped).toEqual([id]);
  });

  it("re-registers a job that missed two fire times, once per baseline", () => {
    const id = addJob({ schedule: "0 * * * *" });
    addRun(id, "success", "2026-01-01 00:00:00");
    scheduler.reload();
    const first = scheduler.selfCheck();
    expect(first.overdue).toEqual([id]);
    expect(first.registered).toEqual([id]);
    // The re-registration restarts the clock, so the next tick is quiet.
    expect(scheduler.selfCheck().overdue).toEqual([]);
  });

  it("leaves a healthy job alone", () => {
    const id = addJob({ schedule: "0 * * * *" });
    addRun(id, "success", iso(hoursAgo(0.5)));
    scheduler.reload();
    expect(scheduler.selfCheck()).toMatchObject({ overdue: [], registered: [], stopped: [] });
  });

  it("does not flag a deliberately paused job", () => {
    addJob({ schedule: "0 * * * *", skip_runs: 3 });
    addJob({ schedule: "0 * * * *", paused_until: iso(new Date(Date.now() + 86400_000)) });
    scheduler.reload();
    expect(scheduler.selfCheck().overdue).toEqual([]);
  });

  it("ignores one-off jobs (re-running one mid-execution would double-fire it)", () => {
    addJob({ type: "once", schedule: null as never });
    expect(scheduler.selfCheck().registered).toEqual([]);
  });

  it("closes out runs stuck in 'running' for over 6h, and only those", () => {
    const id = addJob({ last_run_at: iso(hoursAgo(1)) });
    const old = addRun(id, "running", "2026-03-25 18:18:39Z");
    const recent = addRun(id, "running", iso(hoursAgo(1)).replace("T", " ").slice(0, 19));
    scheduler.reload();
    expect(scheduler.selfCheck().abandonedRuns).toBe(1);
    const rows = db.prepare(`SELECT id, status, error, completed_at FROM job_runs ORDER BY id`).all() as Array<{ id: number; status: string; error: string | null; completed_at: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old)?.status).toBe("error");
    expect(byId.get(old)?.error?.startsWith(ABANDONED_RUN_ERROR)).toBe(true);
    expect(byId.get(old)?.completed_at).toBeTruthy();
    expect(byId.get(recent)?.status).toBe("running");
  });
});

describe("watchdog helpers", () => {
  it("parses every timestamp shape the tables hold as UTC", () => {
    const want = "2026-09-26T03:00:00.000Z";
    expect(parseDbTime("2026-09-26 03:00:00")?.toISOString()).toBe(want);
    expect(parseDbTime("2026-09-26 03:00:00Z")?.toISOString()).toBe(want);
    expect(parseDbTime("2026-09-26T03:00:00.000Z")?.toISOString()).toBe(want);
    expect(parseDbTime(null)).toBeNull();
    expect(parseDbTime("garbage")).toBeNull();
  });

  it("counts missed fire times with a grace period", () => {
    const since = new Date(2026, 8, 20, 12, 0); // local noon
    expect(missedFireCount("0 13 * * *", since, new Date(2026, 8, 20, 13, 5))).toBe(0); // inside grace
    expect(missedFireCount("0 13 * * *", since, new Date(2026, 8, 20, 13, 30))).toBe(1);
    expect(missedFireCount("0 13 * * *", since, new Date(2026, 8, 21, 14, 0))).toBe(2);
  });

  it("does not call a weekday job overdue over a weekend", () => {
    // Last ran Friday 10:00; Monday 09:00 only Monday 10:00 is still ahead.
    const friday = new Date(2026, 8, 25, 10, 0);
    const mondayMorning = new Date(2026, 8, 28, 9, 0);
    expect(missedFireCount("0 10 * * 1-5", friday, mondayMorning)).toBe(0);
  });

  it("uses the latest of last run, creation, pause end and last heal as the baseline", () => {
    const b = overdueBaseline(
      { created_at: "2026-01-01 00:00:00", last_run_at: "2026-09-17T12:06:30.232Z", paused_until: null },
      "2026-09-17 12:06:30Z",
      new Date("2026-09-20T00:00:00Z"),
    );
    expect(b.toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("knows when a job is paused on purpose", () => {
    const now = new Date("2026-09-26T00:00:00Z");
    expect(isDeliberatelyPaused({ skip_runs: 1, paused_until: null }, now)).toBe(true);
    expect(isDeliberatelyPaused({ skip_runs: 0, paused_until: "2026-09-27 00:00:00" }, now)).toBe(true);
    expect(isDeliberatelyPaused({ skip_runs: 0, paused_until: "2026-09-25 00:00:00" }, now)).toBe(false);
  });
});

describe("shouldMarkFailed", () => {
  const err = { status: "error" as const, error: "boom" };
  const ok = { status: "success" as const, error: null };
  const abandoned = { status: "error" as const, error: `${ABANDONED_RUN_ERROR} — still "running" after 6h` };

  it("fails one-off jobs at once", () => {
    expect(shouldMarkFailed("once", [err])).toBe(true);
  });

  it("needs three real errors in a row for a cron job", () => {
    expect(shouldMarkFailed("cron", [err, err])).toBe(false);
    expect(shouldMarkFailed("cron", [err, err, ok])).toBe(false);
    expect(shouldMarkFailed("cron", [err, err, err])).toBe(true);
  });

  it("skips runs abandoned by a daemon restart", () => {
    expect(shouldMarkFailed("cron", [err, abandoned, err, ok])).toBe(false);
    expect(shouldMarkFailed("cron", [err, abandoned, err, err])).toBe(true);
  });
});
