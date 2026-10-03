import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import {
  dismissOverCapReminders,
  getDueReminders,
  getJob,
  getReminder,
  insertReminder,
  updateReminder,
} from "../db/queries.ts";
import { HeartbeatRunner } from "../heartbeat/index.ts";
import { Scheduler } from "./index.ts";
import type { JobExecutor } from "./executor.ts";

/**
 * Over-cap reminder dismissal (fix 8291ea9, 2026-07-05, the second half —
 * the once-job run_at half is pinned by once-runat-offset.test.ts).
 * getDueReminders() excludes rows with remind_count >= max_reminds, so
 * checkDueReminders()'s per-row dismiss branch can never see them; without
 * the sweep inside checkDueReminders() these rows go permanently inert
 * instead of being dismissed. Driven at the cap boundary (==, +1, -1) and
 * through the real heartbeat entry point, asserting the PERSISTED row
 * (stored status read back via getReminder), never just the returned count.
 */

type ReminderStatus = "active" | "snoozed" | "completed" | "dismissed";

// checkDueReminders is private; literal element access is the test seam (a
// visibility change would need to touch heartbeat/index.ts, which carries
// sibling WIP and stays out of this commit).

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});
afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM job_runs; DELETE FROM jobs; DELETE FROM reminders;");
});

function addReminder(opts: {
  remindCount: number;
  maxReminds?: number;
  status?: ReminderStatus;
}): number {
  const row = insertReminder({
    type: "task",
    title: `overcap-suite-${opts.remindCount}-${opts.maxReminds ?? 5}-${opts.status ?? "active"}`,
    max_reminds: opts.maxReminds,
  });
  updateReminder(row.id, {
    remind_count: opts.remindCount,
    ...(opts.status ? { status: opts.status } : {}),
  });
  return row.id;
}

/**
 * The real heartbeat path: checkDueReminders() runs dismissOverCapReminders()
 * BEFORE its `if (!bot ...) return` guard, so a botless runner still sweeps.
 */
async function sweepViaHeartbeat(): Promise<void> {
  const runner = new HeartbeatRunner({
    getBot: () => null,
    defaultChatIds: [],
    config: {
      intervalMinutes: 60,
      fleetPreludeIntervalMinutes: 60,
      quietStart: 0,
      quietEnd: 0,
    },
    memory: {} as never,
  });
  await runner["checkDueReminders"]();
}

function recordingExecutor(executed: number[]): JobExecutor {
  return {
    execute: async (jobId: number): Promise<void> => {
      executed.push(jobId);
    },
  } as JobExecutor;
}

function addOnceJob(runAt: string, name: string): number {
  const row = db
    .prepare<{ id: number }, [string, string]>(
      `INSERT INTO jobs (name, prompt, type, run_at, status, created_at)
       VALUES (?, 'p', 'once', ?, 'enabled', '2026-01-01 00:00:00') RETURNING id`,
    )
    .get(name, runAt)!;
  return row.id;
}

describe("dismissOverCapReminders boundary sweep (8291ea9)", () => {
  it("exactly at cap is dismissed (active and snoozed alike), counter untouched", () => {
    const active = addReminder({ remindCount: 5 });
    const snoozed = addReminder({ remindCount: 5, status: "snoozed" });

    expect(dismissOverCapReminders()).toBe(2);

    expect(getReminder(active)?.status).toBe("dismissed");
    expect(getReminder(snoozed)?.status).toBe("dismissed");
    expect(getReminder(active)?.remind_count).toBe(5); // sweep must not alter the counter
  });

  it("one over cap is dismissed", () => {
    const over = addReminder({ remindCount: 6 });

    expect(dismissOverCapReminders()).toBe(1);

    expect(getReminder(over)?.status).toBe("dismissed");
  });

  it("none over cap: returns 0 and rows stay active", () => {
    const under = addReminder({ remindCount: 4 });

    expect(dismissOverCapReminders()).toBe(0);

    expect(getReminder(under)?.status).toBe("active");
  });

  it("cap is per-row: same remind_count, different max_reminds — only the at-cap row goes", () => {
    const atCap = addReminder({ remindCount: 5, maxReminds: 5 });
    const headroom = addReminder({ remindCount: 5, maxReminds: 10 });

    expect(dismissOverCapReminders()).toBe(1);

    expect(getReminder(atCap)?.status).toBe("dismissed");
    expect(getReminder(headroom)?.status).toBe("active");
  });

  it("terminal rows are never re-swept", () => {
    const completed = addReminder({ remindCount: 6, status: "completed" });
    const dismissed = addReminder({ remindCount: 6, status: "dismissed" });

    expect(dismissOverCapReminders()).toBe(0);

    expect(getReminder(completed)?.status).toBe("completed");
    expect(getReminder(dismissed)?.status).toBe("dismissed");
  });
});

describe("heartbeat reaches the sweep (checkDueReminders)", () => {
  it("sweep runs before the bot guard — dismisses with no bot configured", async () => {
    const atCap = addReminder({ remindCount: 5 });
    const over = addReminder({ remindCount: 6 });
    const under = addReminder({ remindCount: 4 });

    await sweepViaHeartbeat();

    expect(getReminder(atCap)?.status).toBe("dismissed");
    expect(getReminder(over)?.status).toBe("dismissed");
    expect(getReminder(under)?.status).toBe("active");
  });

  it("an under-cap due reminder survives the sweep — still returned by getDueReminders", async () => {
    const due = addReminder({ remindCount: 4 });

    await sweepViaHeartbeat();

    expect(getReminder(due)?.status).toBe("active");
    expect(getDueReminders().map((r) => r.id)).toContain(due);
  });
});

describe("both halves of 8291ea9 compose (run_at offset × over-cap sweep)", () => {
  it("offset-bearing once-job schedules while the heartbeat sweep dismisses on the same DB", async () => {
    const pastDueId = addOnceJob("2026-01-01T09:30:00-04:00", "once-past-offset");
    const futureId = addOnceJob("2026-12-01T09:30:00-04:00", "once-future-offset");
    const atCap = addReminder({ remindCount: 5 });

    const executed: number[] = [];
    const scheduler = new Scheduler(recordingExecutor(executed));
    expect(() => scheduler.start()).not.toThrow(); // pre-fix: offset + 'Z' → throw in reload()

    expect(executed).toEqual([pastDueId]); // past-due executes, future only schedules
    expect(getJob(futureId)?.next_run_at).toBe("2026-12-01T13:30:00.000Z");

    await sweepViaHeartbeat();

    expect(getReminder(atCap)?.status).toBe("dismissed");
  });
});
