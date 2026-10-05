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
const RUN_10324 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][2026105012031038e9dc9c153243e6]";

// Census residual shapes (research/psibot-jobruns-silent-blindspot-2026-10.md),
// verbatim from the /tmp trio copy /tmp/psibot-jobruns-blindspot-20261005/ —
// same registry as the 429 trio above, byte-verified against its rows.
const RUN_215_CONTEXT_WINDOW = "API Error: The model has reached its context window limit.";
const RUN_1402_AUTH_401 = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CZvmnzyRJiiSdrkpkZA6C"}';
const RUN_7000_FALLBACK_529 = `[fallback: glm/sonnet, tier 2/8]

API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][20260618114907e8635efcba4c4d98]"},"request_id":"20260618114907e8635efcba4c4d98"}`;
const RUN_7002_FALLBACK_529 = `[fallback: glm/sonnet, tier 2/8]

API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][202606181148379b45b770b1964988]"},"request_id":"202606181148379b45b770b1964988"}`;
const RUN_4117_PROSE = `[NOTIFY]
🌙 NIGHTLY BRIEF — Tuesday, May 5

📅 TOMORROW (Wednesday, May 6)
  Calendar data unavailable (Google/Apple API errors)
  
🌤️ TOMORROW'S WEATHER
  11.8°C / 6.9°C ☁ Overcast — precip 16%

📚 CLASS PREP
  ⚠️ CLASS NIGHT TOMORROW (Wednesday)
  No lecture notes found in upcoming-lectures/

💤 No confirmed early commitments (calendar unavailable). Sleep well, but remember to prep class material for tomorrow night.

---
Brief saved to: ~/Documents/NotePlan-Notes/Notes/60 - Briefings/2026-05-05-nightly-brief.md
[/NOTIFY]`;

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

/** An agent that returns each scripted result once, in order — for driving a
 *  pipeline (job A's run, then job B's executePipelineStep run) in one test. */
function scriptedExecutor(results: string[]): { executor: JobExecutor; calls: () => number } {
  let i = 0;
  const agent = {
    run: async () => fakeResult(results[Math.min(i++, results.length - 1)]),
    consumeRestart: () => false,
  } satisfies ExecutorAgent;
  return { executor: new JobExecutor(agent), calls: () => i };
}

/** execute() fires pipeline steps without awaiting them, so no promise is
 *  exposed to await — yield the event loop (zero-delay, no wall-clock sleep)
 *  until the condition holds or the turn budget is spent. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; !cond(); i++) {
    if (i > 5_000) throw new Error("until: condition never held");
    await new Promise<void>((r) => setImmediate(r));
  }
}

function runCount(jobId: number): number {
  const r = row(`SELECT COUNT(*) AS n FROM job_runs WHERE job_id = ?`, jobId);
  return r !== null && typeof r.n === "number" ? r.n : 0;
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

describe("executor classification of census residual shapes", () => {
  it("records context-window, auth-401 and fallback-exhausted results as error runs", async () => {
    const cases: Array<[string, string]> = [
      ["Inbox Triage", RUN_215_CONTEXT_WINDOW],
      ["Research Pipeline", RUN_1402_AUTH_401],
      ["Nightly Brief", RUN_7000_FALLBACK_529],
    ];
    for (const [name, text] of cases) {
      const id = addJob({ name, schedule: "0 */6 * * *" });
      await resultExecutor(text).execute(id);

      const run = lastRun(id);
      expect(run.status).toBe("error");
      expect(run.error).toBe(text);
      // Under the failure streak the job stays scheduled and quiet.
      expect(jobStatus(id)).toBe("enabled");
      expect(sent).toHaveLength(0);
    }
  });

  it("counts a fallback-exhausted 529 toward the streak and fires the job-alerts arm at 3 in a row", async () => {
    const id = addJob({ name: "Alpha Researcher", schedule: "0 */4 * * *" });
    addRun(id, "error", "2026-06-18T02:00:00Z", RUN_7000_FALLBACK_529);
    addRun(id, "error", "2026-06-18T03:31:00Z", RUN_7002_FALLBACK_529);

    await resultExecutor(RUN_7000_FALLBACK_529).execute(id);

    expect(jobStatus(id)).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("PsiBot job failed: Alpha Researcher");
    // jobFailedAlertText truncates the error — the fallback tag survives.
    expect(sent[0]).toContain("[fallback: glm/sonnet, tier 2/8]");
  });

  it("keeps the id-4117 prose brief a success (the census's contains-predicate false positive)", async () => {
    const id = addJob({ name: "Nightly Brief", schedule: "0 3 * * *" });
    await resultExecutor(RUN_4117_PROSE).execute(id);

    expect(lastRun(id).status).toBe("success");
    expect(jobStatus(id)).toBe("enabled");
    expect(sent).toHaveLength(0);
  });

  it("pipeline path: a fallback-exhausted 529 fails the step and never feeds forward", async () => {
    const first = addJob({ name: "Stage A", schedule: "0 6 * * *" });
    const second = addJob({ name: "Stage B", schedule: "0 6 * * *" });
    const third = addJob({ name: "Stage C", schedule: "0 6 * * *" });
    db.prepare(`UPDATE jobs SET next_job_id = ? WHERE id = ?`).run(second, first);
    db.prepare(`UPDATE jobs SET next_job_id = ? WHERE id = ?`).run(third, second);

    const { executor, calls } = scriptedExecutor(["Stage A output", RUN_7000_FALLBACK_529, "never reached"]);
    await executor.execute(first);

    // execute() fires the step without awaiting it — yield until B's row lands.
    await until(() => runCount(second) === 1);

    expect(lastRun(first).status).toBe("success");
    expect(lastRun(second).status).toBe("error");
    expect(lastRun(second).error).toBe(RUN_7000_FALLBACK_529);
    // The error text never feeds forward: Stage C never gets a run.
    expect(runCount(third)).toBe(0);
    expect(calls()).toBe(2);
  });
});
