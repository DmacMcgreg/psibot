import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { Scheduler } from "./index.ts";
import { JobExecutor } from "./executor.ts";
import { failedRetryDue, localDayAndHour } from "./watchdog.ts";
import { jobFailedAlertText, jobMissedAlertText } from "./job-alerts.ts";
import {
  sendOpsAlert,
  setOpsAlertSender,
  resetOpsAlertsForTesting,
  OPS_ALERT_WINDOW_MS,
  oneLine,
} from "../shared/ops-alerts.ts";
import type { AgentService } from "../agent/index.ts";

/**
 * Missed/failed job notices (one Telegram DM per job per 24 h) and the daily
 * retry of failed cron jobs.
 */

// Throwaway env fixture: the gitignored developer .env normally supplies
// these, a clean checkout has neither, and loadConfig() below refuses to run
// without them. Literal dummies — never a real token or chat id.
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";

let db: Database;
let sent: string[];

beforeAll(() => {
  loadConfig(); // the executor's failure path builds an "Open in app" link from config
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM job_runs; DELETE FROM jobs; DELETE FROM job_config_history; DELETE FROM ops_state;");
  resetOpsAlertsForTesting();
  sent = [];
  setOpsAlertSender(async (text) => {
    sent.push(text);
    return true;
  });
});

afterEach(() => resetOpsAlertsForTesting());

function addJob(fields: { name?: string; type?: string; schedule?: string | null; status?: string; last_run_at?: string | null; created_at?: string }): number {
  const row = db
    .prepare(
      `INSERT INTO jobs (name, prompt, type, schedule, run_at, status, created_at, last_run_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      fields.name ?? "job",
      fields.type ?? "cron",
      fields.type === "once" ? null : (fields.schedule ?? "0 6 * * *"),
      fields.type === "once" ? "2026-01-01T00:00:00Z" : null,
      fields.status ?? "enabled",
      fields.created_at ?? "2026-01-01 00:00:00",
      fields.last_run_at ?? null,
    ) as { id: number };
  return row.id;
}

function addRun(jobId: number, status: string, startedAt: string, error: string | null = null): void {
  db.prepare(`INSERT INTO job_runs (job_id, status, started_at, error) VALUES (?, ?, ?, ?)`).run(jobId, status, startedAt, error);
}

const status = (id: number) => (db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(id) as { status: string }).status;
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const flush = () => new Promise((r) => setTimeout(r, 10));

function failingExecutor(): JobExecutor {
  const agent = {
    run: async () => {
      throw new Error("Claude Code process exited with code 1\n    at stack line");
    },
    consumeRestart: () => false,
  } as unknown as AgentService;
  return new JobExecutor(agent);
}

describe("sendOpsAlert", () => {
  it("sends once per key per 24 h", async () => {
    const t0 = new Date("2026-09-26T12:00:00Z");
    expect(await sendOpsAlert("job:1", "first", t0)).toBe("sent");
    expect(await sendOpsAlert("job:1", "again", new Date(t0.getTime() + 60_000))).toBe("deduped");
    expect(await sendOpsAlert("job:2", "other job", t0)).toBe("sent");
    expect(await sendOpsAlert("job:1", "next day", new Date(t0.getTime() + OPS_ALERT_WINDOW_MS + 1))).toBe("sent");
    expect(sent).toEqual(["first", "other job", "next day"]);
  });

  it("holds alerts raised before the bot exists, then sends them", async () => {
    resetOpsAlertsForTesting();
    expect(await sendOpsAlert("job:1", "early")).toBe("queued");
    expect(await sendOpsAlert("job:1", "early dup")).toBe("queued");
    setOpsAlertSender(async (text) => {
      sent.push(text);
      return true;
    });
    await flush();
    expect(sent).toEqual(["early"]);
  });

  it("releases the slot when delivery fails, so the next event can try again", async () => {
    setOpsAlertSender(async () => false);
    expect(await sendOpsAlert("job:1", "lost")).toBe("failed");
    setOpsAlertSender(async (text) => {
      sent.push(text);
      return true;
    });
    expect(await sendOpsAlert("job:1", "retry")).toBe("sent");
    expect(sent).toEqual(["retry"]);
  });

  it("keeps the last error to one line", () => {
    expect(oneLine("boom\n  at x.ts:1")).toBe("boom");
    expect(oneLine("x".repeat(300)).length).toBe(200);
    expect(oneLine(null)).toBe("");
  });
});

describe("alert text", () => {
  it("names the job, what happened and the last error", () => {
    const failed = jobFailedAlertText({ id: 31, name: "Morning Brief", type: "cron" }, "exited with code 1\nstack");
    expect(failed.split("\n")).toHaveLength(3);
    expect(failed).toContain("Morning Brief (#31)");
    expect(failed).toContain("Last error: exited with code 1");
    expect(jobFailedAlertText({ id: 84, name: "FOMC", type: "once" }, null)).toContain("won't be retried");

    const missed = jobMissedAlertText({ id: 66, name: "Weekly Maintenance", type: "cron" }, new Date("2026-07-27T08:29:00Z"), null, null);
    expect(missed).toContain("missed runs: Weekly Maintenance (#66)");
    expect(missed).toContain("Last error: none");
  });
});

describe("failed job notice", () => {
  it("alerts once when a cron job hits the failure streak", async () => {
    const id = addJob({ name: "Nightly Brief" });
    addRun(id, "error", "2026-09-20T03:00:00Z", "boom");
    addRun(id, "error", "2026-09-21T03:00:00Z", "boom");
    const exec = failingExecutor();

    await exec.execute(id);
    expect(status(id)).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("PsiBot job failed: Nightly Brief");
    expect(sent[0]).toContain("Last error: Claude Code process exited with code 1");

    // A manual trigger of the failed job errors again: no second notice.
    await exec.execute(id, { manualTrigger: true });
    expect(sent).toHaveLength(1);
  });

  it("does not alert for an error that stays under the streak", async () => {
    const id = addJob({});
    await failingExecutor().execute(id);
    expect(status(id)).toBe("enabled");
    expect(sent).toHaveLength(0);
  });

  it("alerts when a one-off job fails", async () => {
    const id = addJob({ type: "once", name: "FOMC" });
    await failingExecutor().execute(id);
    expect(status(id)).toBe("failed");
    expect(sent[0]).toContain("won't be retried");
  });
});

describe("daily retry of failed cron jobs", () => {
  let scheduler: Scheduler;
  beforeEach(() => {
    scheduler = new Scheduler({ onJobRecovered: null, execute: async () => {} } as unknown as JobExecutor);
  });
  afterEach(() => scheduler.stop());

  it("is due once per local day, from 09:00 Toronto", () => {
    const before = new Date("2026-09-26T12:30:00Z"); // 08:30 EDT
    const after = new Date("2026-09-26T13:05:00Z"); // 09:05 EDT
    expect(failedRetryDue(before, null)).toBe(false);
    expect(failedRetryDue(after, null)).toBe(true);
    expect(failedRetryDue(after, "2026-09-26")).toBe(false);
    expect(failedRetryDue(new Date("2026-09-27T13:05:00Z"), "2026-09-26")).toBe(true);
    expect(localDayAndHour(new Date("2026-09-27T02:00:00Z"))).toEqual({ day: "2026-09-26", hour: 22 });
  });

  it("re-enables failed cron jobs with a history reason, skips one-off jobs, and registers timers", () => {
    const cronId = addJob({ status: "failed", schedule: "0 */4 * * *", last_run_at: hoursAgo(30).toISOString() });
    const onceId = addJob({ type: "once", status: "failed" });
    scheduler.reload();

    const report = scheduler.selfCheck(new Date("2026-09-26T13:05:00Z"));
    expect(report.retried).toEqual([cronId]);
    expect(report.registered).toContain(cronId);
    expect(status(cronId)).toBe("enabled");
    expect(status(onceId)).toBe("failed");

    const history = db
      .prepare(`SELECT changed_by, changes, reason FROM job_config_history WHERE job_id = ?`)
      .all(cronId) as { changed_by: string; changes: string; reason: string }[];
    expect(history).toHaveLength(1);
    expect(history[0].changed_by).toBe("system");
    expect(JSON.parse(history[0].changes)).toEqual({ status: { from: "failed", to: "enabled" } });
    expect(history[0].reason).toContain("daily retry");

    // Same day: no second sweep.
    db.exec(`UPDATE jobs SET status = 'failed' WHERE id = ${cronId}`);
    expect(scheduler.selfCheck(new Date("2026-09-26T18:00:00Z")).retried).toEqual([]);
    // Next day: retried again.
    expect(scheduler.selfCheck(new Date("2026-09-27T13:05:00Z")).retried).toEqual([cronId]);
  });

  it("gives a retried job three fresh tries, then fails and alerts again", async () => {
    const id = addJob({ status: "failed", name: "Weekly Maintenance" });
    addRun(id, "error", "2026-09-20T08:00:00Z", "old");
    addRun(id, "error", "2026-09-21T08:00:00Z", "old");
    addRun(id, "error", "2026-09-22T08:00:00Z", "old");
    scheduler.retryFailedCronJobs(new Date("2026-09-26T13:05:00Z"));
    expect(status(id)).toBe("enabled");

    const exec = failingExecutor();
    await exec.execute(id);
    expect(status(id)).toBe("enabled"); // the old errors no longer count
    await exec.execute(id);
    expect(status(id)).toBe("enabled");
    await exec.execute(id);
    expect(status(id)).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Weekly Maintenance");
  });
});

describe("missed run notice", () => {
  const noRetryToday = () =>
    db.prepare(`INSERT OR REPLACE INTO ops_state (key, value) VALUES ('scheduler:failed-retry-day', ?)`).run(localDayAndHour(new Date()).day);

  it("does not flag a job that was enabled after a long disable", () => {
    noRetryToday();
    const id = addJob({ name: "Research Pipeline", schedule: "0 */6 * * *", last_run_at: "2026-08-14T22:00:53Z" });
    db.prepare(`INSERT INTO job_config_history (job_id, changed_by, changes, reason, changed_at) VALUES (?, 'web', ?, 'dashboard toggle', ?)`)
      .run(id, JSON.stringify({ status: { from: "disabled", to: "enabled" } }), new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, "Z"));
    const scheduler = new Scheduler({ onJobRecovered: null, execute: async () => {} } as unknown as JobExecutor);
    try {
      scheduler.reload();
      expect(scheduler.selfCheck().overdue).toEqual([]);
      expect(sent).toHaveLength(0);
    } finally {
      scheduler.stop();
    }
  });

  it("remembers a re-registration across a daemon restart", () => {
    noRetryToday();
    const id = addJob({ name: "Weekly Maintenance", schedule: "0 * * * *", last_run_at: hoursAgo(5).toISOString() });
    const first = new Scheduler({ onJobRecovered: null, execute: async () => {} } as unknown as JobExecutor);
    first.reload();
    expect(first.selfCheck().overdue).toEqual([id]);
    first.stop();

    const second = new Scheduler({ onJobRecovered: null, execute: async () => {} } as unknown as JobExecutor);
    try {
      second.reload();
      expect(second.selfCheck().overdue).toEqual([]);
    } finally {
      second.stop();
    }
  });

  it("alerts once when the self-check finds an overdue cron job", async () => {
    const scheduler = new Scheduler({ onJobRecovered: null, execute: async () => {} } as unknown as JobExecutor);
    try {
      // Pretend today's retry already ran so only the overdue path acts.
      noRetryToday();
      const id = addJob({ name: "Morning Brief", schedule: "0 * * * *", last_run_at: hoursAgo(5).toISOString() });
      addRun(id, "error", hoursAgo(5).toISOString(), "network down");
      scheduler.reload();

      const report = scheduler.selfCheck();
      expect(report.overdue).toEqual([id]);
      await flush();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("PsiBot job missed runs: Morning Brief");
      expect(sent[0]).toContain("Last error: network down");

      // The next self-check doesn't flag it again (re-registration resets its
      // baseline), and the job:<id> slot is taken for 24 h anyway.
      scheduler.selfCheck(new Date(Date.now() + 60_000));
      await flush();
      expect(sent).toHaveLength(1);
    } finally {
      scheduler.stop();
    }
  });
});
