import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { JobExecutor, ExecutorAgent } from "./executor.ts";
import { setOpsAlertSender, resetOpsAlertsForTesting } from "../shared/ops-alerts.ts";
import type { AgentRunResult } from "../shared/types.ts";

/**
 * A provider 429 (quota/rate-limit) rejection used to be recorded as a
 * "success" job run — job_runs 10322-10324 (jobs 12/32/34, 2026-10-05T04:00Z)
 * are the live specimen, invisible to the watchdog and the job-alerts arm.
 * These tests pin that such a run is recorded "error" and reaches the same
 * streak → ops-alert path as any other failure.
 */

// Throwaway env fixture, same as job-alerts.test.ts: a clean checkout has no
// .env and loadConfig() refuses to run without these. Literal dummies.
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";

// Verbatim from the fresh /tmp trio copy of the registry
// (/tmp/psibot-429-20261005/app.db) — never the live registry.
const RUN_10322 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][20261005120002e143547df7b14f5c]";
const RUN_10323 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][202610051203064ba74f60123e4f91]";
const RUN_10324 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][2026100512031038e9dc9c153243e6]";

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

function addJob(fields: { name?: string; type?: string; schedule?: string | null; status?: string }): number {
  const r = row(
    `INSERT INTO jobs (name, prompt, type, schedule, run_at, status, created_at, last_run_at)
     VALUES (?, 'p', ?, ?, ?, ?, '2026-01-01 00:00:00', NULL) RETURNING id`,
    fields.name ?? "job",
    fields.type ?? "cron",
    fields.type === "once" ? null : (fields.schedule ?? "0 6 * * *"),
    fields.type === "once" ? "2026-01-01T00:00:00Z" : null,
    fields.status ?? "enabled",
  );
  if (r === null || typeof r.id !== "number") throw new Error("addJob: no RETURNING id");
  return r.id;
}

function addRun(jobId: number, status: string, startedAt: string, error: string | null = null): void {
  db.prepare(`INSERT INTO job_runs (job_id, status, started_at, error) VALUES (?, ?, ?, ?)`).run(jobId, status, startedAt, error);
}

// bun:sqlite's .get() types its result as {} — widen once to unknown values,
// then narrow each cell with typeof (no asserted shapes).
function row(sql: string, ...params: Array<string | number | null>): Record<string, unknown> | null {
  const r = db.prepare(sql).get(...params) as Record<string, unknown> | null | undefined;
  return r ?? null;
}

function jobStatus(id: number): string {
  const r = row(`SELECT status FROM jobs WHERE id = ?`, id);
  return r !== null && typeof r.status === "string" ? r.status : "";
}

function lastRun(id: number): { status: string; error: string | null } {
  const r = row(`SELECT status, error FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1`, id);
  if (r === null) throw new Error(`no run row for job ${id}`);
  return {
    status: typeof r.status === "string" ? r.status : "",
    error: typeof r.error === "string" ? r.error : null,
  };
}

function fakeResult(result: string): AgentRunResult {
  return {
    sessionId: "sess-quota-test",
    result,
    costUsd: 0,
    durationMs: 3_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    contextWindow: 200_000,
    promptTokens: 0,
    numTurns: 1,
    stopReason: "error",
    deliveredViaTool: false,
  };
}

/** An agent whose runs always *return* the given result — the CLI exits 0 on a
 *  provider 429, so the rejection arrives as a result, never a throw. */
function resultExecutor(result: string): JobExecutor {
  const agent = {
    run: async () => fakeResult(result),
    consumeRestart: () => false,
  } satisfies ExecutorAgent;
  return new JobExecutor(agent);
}

describe("executor classification of provider 429 results", () => {
  it("records the run as error, not success, with the 429 text as its error", async () => {
    const id = addJob({ name: "YouTube Watchlist", schedule: "0 */3 * * *" });
    await resultExecutor(RUN_10322).execute(id);

    const run = lastRun(id);
    expect(run.status).toBe("error");
    expect(run.error).toBe(RUN_10322);
    // Under the failure streak the job stays scheduled and quiet.
    expect(jobStatus(id)).toBe("enabled");
    expect(sent).toHaveLength(0);
  });

  it("counts toward the streak and fires the job-alerts arm at 3 in a row", async () => {
    const id = addJob({ name: "Reddit Saved Poller", schedule: "0 */4 * * *" });
    addRun(id, "error", "2026-10-05T00:00:00Z", RUN_10323);
    addRun(id, "error", "2026-10-05T00:04:00Z", RUN_10324);

    await resultExecutor(RUN_10322).execute(id);

    // The watchdog (shouldMarkFailed) only sees 3 errors in a row if THIS run
    // was recorded "error" — under the old always-success classification the
    // streak breaks here, no alert fires, and the job stays enabled.
    expect(jobStatus(id)).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("PsiBot job failed: Reddit Saved Poller");
    expect(sent[0]).toContain("Request rejected (429)");
    expect(sent[0]).toContain("Usage limit reached");
  });

  it("still records a normal result as success", async () => {
    const id = addJob({ name: "Digest", schedule: "0 6 * * *" });
    await resultExecutor("Digest complete! Processed 1429 items.").execute(id);

    expect(lastRun(id).status).toBe("success");
    expect(jobStatus(id)).toBe("enabled");
    expect(sent).toHaveLength(0);
  });
});
