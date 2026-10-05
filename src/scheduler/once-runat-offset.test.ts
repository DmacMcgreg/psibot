import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { Scheduler } from "./index.ts";
import { JobExecutor } from "./executor.ts";
import { AgentService } from "../agent/index.ts";
import { getJob } from "../db/queries.ts";

/**
 * One-off job run_at parsing (fix 8291ea9, 2026-07-05): only bare
 * timestamps get a 'Z' appended to parse as UTC. A run_at that already
 * carries an offset ("-04:00") must be left as-is — appending 'Z' produced
 * "...-04:00Z", an Invalid Date whose toISOString() threw inside reload()
 * and crashed the daemon on restart. Invalid values must mark the job
 * failed instead of throwing.
 */

// Throwaway env fixture: the gitignored developer .env normally supplies
// these, a clean checkout has neither, and loadConfig() below refuses to run
// without them. Literal dummies — never a real token or chat id.
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";

/** Records execute() calls; subclasses the real executor so no cast is needed. */
class StubExecutor extends JobExecutor {
  executedJobIds: number[] = [];
  override execute = async (jobId: number): Promise<void> => {
    this.executedJobIds.push(jobId);
  };
}

function makeStub(): StubExecutor {
  // Only what createAgentTools reads while building the (unused) tool server.
  const deps = {
    memory: {},
    reloadScheduler: () => {},
    triggerJob: () => {},
    getBot: () => null,
    defaultChatIds: [],
    groupChatIds: [],
    psibotDir: "/nonexistent-psibot-test-dir",
    scheduleRestart: () => {},
  };
  return new StubExecutor(new AgentService(deps as never));
}

let db: Database;
let stub: StubExecutor;

beforeAll(() => {
  loadConfig();
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});
afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM job_runs; DELETE FROM jobs;");
  stub = makeStub();
});

function newScheduler(): Scheduler {
  const scheduler = new Scheduler(stub); // StubExecutor IS a JobExecutor
  scheduler.start(); // reload() lives here, not in the constructor
  return scheduler;
}

function addOnceJob(runAt: string, name = "once-job"): number {
  const row = db
    .prepare(
      `INSERT INTO jobs (name, prompt, type, run_at, status, created_at)
       VALUES (?, 'p', 'once', ?, 'enabled', '2026-01-01 00:00:00') RETURNING id`,
    )
    .get(name, runAt) as { id: number };
  return row.id;
}

describe("one-off job run_at parsing (8291ea9)", () => {
  it("an offset-bearing future run_at schedules without throwing", () => {
    const jobId = addOnceJob("2026-12-01T09:30:00-04:00");
    let scheduler: Scheduler | null = null;
    expect(() => {
      scheduler = newScheduler();
    }).not.toThrow(); // pre-fix: 'Z' appended after the offset → Invalid Date → toISOString() RangeError

    const job = getJob(jobId);
    expect(job?.status).toBe("enabled");
    expect(job?.next_run_at).toBe("2026-12-01T13:30:00.000Z"); // offset honored, parsed as 13:30Z
    expect(stub.executedJobIds).toEqual([]); // future: not executed
    void scheduler;
  });

  it("an invalid run_at marks the job failed instead of throwing", () => {
    const jobId = addOnceJob("not-a-date", "once-invalid");
    expect(() => newScheduler()).not.toThrow();
    expect(getJob(jobId)?.status).toBe("failed");
  });

  it("a bare past-due UTC run_at still executes immediately (retained behavior)", () => {
    const jobId = addOnceJob("2000-01-01T00:00:00", "once-past-due");
    expect(() => newScheduler()).not.toThrow();
    expect(stub.executedJobIds).toEqual([jobId]);
  });
});
