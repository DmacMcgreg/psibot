import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { setOpsState } from "../db/queries.ts";
import { JobExecutor, type ExecutorAgent } from "./executor.ts";
import { Scheduler } from "./index.ts";
import { setOpsAlertSender, resetOpsAlertsForTesting } from "../shared/ops-alerts.ts";
import type { AgentRunResult } from "../shared/types.ts";
import {
  usageLimitRetryMs,
  providerWindowResetUntil,
  noteProviderWindowExhausted,
  staggeredWindowWait,
  PROVIDER_WINDOW_STATE_KEY,
  PROVIDER_WINDOW_BUFFER_MS,
  WINDOW_RUN_STAGGER_MS,
} from "./provider-window.ts";

/**
 * The provider usage-limit collision (goal "PsiBot scheduled jobs stop
 * failing silently"): the 04:00Z trio (jobs 12/32/34) and its storm-mates
 * (70/62, job_runs 10320-10324, plus 10352/10353 the next day) all fire
 * into an already-exhausted GLM 5-hour usage window and die with the
 * [1308] envelope. These tests pin the scheduler's answer: parse the
 * envelope's own reset clock, defer fires that land inside the window,
 * retry the failing job once after the reset, stagger the released runs —
 * while the failed run itself stays a classified error row exactly as
 * 5ac7324 landed it.
 */

// Throwaway env fixture, same as quota-classification.test.ts: a clean
// checkout has no .env and loadConfig() refuses to run without these.
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";

// Verbatim from the live registry (read-only probes 2026-10-05/06): the
// request-id bracket embeds the provider's own clock, which runs UTC+8
// across every specimen (10:00:00Z starts stamp 18:00 provider).
const RUN_10322 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][20261005120002e143547df7b14f5c]";
const RUN_10323 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][202610051203064ba74f60123e4f91]";
// Row 10324's request id really carries a corrupt date ("20261050…", month
// 10 day 50) — the fixed-zone fallback exists for exactly this specimen.
const RUN_10324 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][2026105012031038e9dc9c153243e6]";
const RUN_215_CONTEXT_WINDOW = "API Error: The model has reached its context window limit.";
const RUN_1402_AUTH_401 = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CZvmnzyRJiiSdrkpkZA6C"}';
const RUN_7000_FALLBACK_529 = `[fallback: glm/sonnet, tier 2/8]

API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][20260618114907e8635efcba4c4d98]"},"request_id":"20260618114907e8635efcba4c4d98"}`;

let db: Database;
let sent: string[];

beforeAll(() => {
  loadConfig();
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
  const r = db.prepare(
    `INSERT INTO jobs (name, prompt, type, schedule, run_at, status, created_at, last_run_at)
     VALUES (?, 'p', ?, ?, ?, ?, '2026-01-01 00:00:00', NULL) RETURNING id`,
  ).get(
    fields.name ?? "job",
    fields.type ?? "cron",
    fields.type === "once" ? null : (fields.schedule ?? "0 6 * * *"),
    fields.type === "once" ? "2026-01-01T00:00:00Z" : null,
    fields.status ?? "enabled",
  ) as { id: number } | undefined;
  if (!r || typeof r.id !== "number") throw new Error("addJob: no RETURNING id");
  return r.id;
}

function lastRun(jobId: number): { status: string; error: string | null } {
  const r = db.prepare(`SELECT status, error FROM job_runs WHERE job_id = ? ORDER BY id DESC LIMIT 1`).get(jobId) as
    | { status: string; error: string | null }
    | undefined;
  if (!r) throw new Error(`no run row for job ${jobId}`);
  return { status: r.status, error: r.error ?? null };
}

function fakeResult(result: string): AgentRunResult {
  return {
    sessionId: "sess-window-test",
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

/** An agent whose runs always *return* the given result, recording each
 * call's sourceId so diagnostic spawns (`diag:<jobId>`) are visible. */
function recordingResultAgent(result: string): { agent: ExecutorAgent; sourceIds: () => string[] } {
  const seen: string[] = [];
  const agent = {
    run: async (req: { sourceId?: string }) => {
      seen.push(req.sourceId ?? "");
      return fakeResult(result);
    },
    consumeRestart: () => false,
  } satisfies ExecutorAgent;
  return { agent, sourceIds: () => seen };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("usageLimitRetryMs (envelope parser)", () => {
  it("derives the wait from the request-id clock, timezone-free (trio specimens)", () => {
    // 12:12:52 − 12:00:02 = 12m50s; 12:12:52 − 12:03:06 = 9m46s. Both stamps
    // sit in the provider's own zone, so the difference needs no zone at all.
    expect(usageLimitRetryMs(RUN_10322)).toBe(770_000);
    expect(usageLimitRetryMs(RUN_10323)).toBe(586_000);
  });

  it("falls back to the fixed provider zone when the request id is corrupt (row 10324)", () => {
    // Envelope caught at 04:03:10Z; reset 12:12:52 UTC+8 = 04:12:52Z → 9m42s.
    const now = new Date("2026-10-05T04:03:10Z");
    expect(usageLimitRetryMs(RUN_10324, now)).toBe(582_000);
  });

  it("returns null for every non-usage-limit census shape", () => {
    expect(usageLimitRetryMs(RUN_215_CONTEXT_WINDOW)).toBeNull();
    expect(usageLimitRetryMs(RUN_1402_AUTH_401)).toBeNull();
    expect(usageLimitRetryMs(RUN_7000_FALLBACK_529)).toBeNull();
    expect(usageLimitRetryMs("Digest complete! Processed 1429 items.")).toBeNull();
    expect(usageLimitRetryMs("")).toBeNull();
  });

  it("rejects absurd deltas and corrupt reset sentences", () => {
    const yearAhead =
      "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2027-10-05 12:12:52][20261005120002e143547df7b14f5c]";
    expect(usageLimitRetryMs(yearAhead)).toBeNull();
    const corruptReset =
      "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-13-45 12:12:52][20261005120002e143547df7b14f5c]";
    expect(usageLimitRetryMs(corruptReset, new Date("2026-10-05T04:00:00Z"))).toBeNull();
  });
});

describe("provider window ops_state", () => {
  it("notes the deadline (plus buffer) and keeps the later of overlapping deadlines", () => {
    const t0 = new Date("2026-10-06T10:00:30Z");
    const first = noteProviderWindowExhausted(770_000, t0);
    expect(first.getTime() - t0.getTime()).toBe(770_000 + PROVIDER_WINDOW_BUFFER_MS);

    // A second storm report with a shorter wait must not shorten the window.
    const t1 = new Date(t0.getTime() + 60_000);
    const kept = noteProviderWindowExhausted(300_000, t1);
    expect(kept.getTime()).toBe(first.getTime());

    // A genuinely later reset extends it.
    const t2 = new Date(t0.getTime() + 90_000);
    const extended = noteProviderWindowExhausted(2_000_000, t2);
    expect(extended.getTime()).toBe(t2.getTime() + 2_000_000 + PROVIDER_WINDOW_BUFFER_MS);
  });

  it("reads the deadline back until it passes, then null", () => {
    expect(providerWindowResetUntil(new Date("2026-10-06T10:00:00Z"))).toBeNull();
    setOpsState(PROVIDER_WINDOW_STATE_KEY, new Date("2026-10-06T11:31:05Z").toISOString());
    expect(providerWindowResetUntil(new Date("2026-10-06T10:00:00Z"))?.toISOString()).toBe(
      "2026-10-06T11:31:05.000Z",
    );
    expect(providerWindowResetUntil(new Date("2026-10-06T11:31:06Z"))).toBeNull();
  });

  it("spaces simultaneous releases so the trio does not collide again at the window opening", () => {
    const now = new Date("2026-10-06T11:00:00Z");
    const until = new Date("2026-10-06T11:31:05Z");
    expect(staggeredWindowWait(until, 0, now)).toBe(1_865_000); // 31m05s to the deadline
    expect(staggeredWindowWait(until, 1, now)).toBe(1_865_000 + WINDOW_RUN_STAGGER_MS);
    expect(staggeredWindowWait(until, 3, now)).toBe(1_865_000 + 3 * WINDOW_RUN_STAGGER_MS);
    // Deadline already past: only the stagger remains.
    expect(staggeredWindowWait(until, 2, new Date("2026-10-06T11:31:06Z"))).toBe(2 * WINDOW_RUN_STAGGER_MS);
  });
});

describe("executor usage-limit failure arm", () => {
  it("keeps the run a classified error, schedules one retry at the parsed reset, and skips the diagnostic", async () => {
    const id = addJob({ name: "Reddit Saved Poller", schedule: "0 */4 * * *" });
    const { agent, sourceIds } = recordingResultAgent(RUN_10322);
    const executor = new JobExecutor(agent);
    const retries: Array<{ jobId: number; at: Date }> = [];
    executor.onProviderRetry = (jobId, at) => retries.push({ jobId, at });
    const before = Date.now();

    await executor.execute(id);

    // 5ac7324 behavior kept: the envelope is a failed run, not a success.
    const run = lastRun(id);
    expect(run.status).toBe("error");
    expect(run.error).toBe(RUN_10322);

    // One retry, at the reset parsed from the envelope (+ buffer).
    expect(retries).toHaveLength(1);
    expect(retries[0].jobId).toBe(id);
    const waited = retries[0].at.getTime() - before;
    expect(waited).toBeGreaterThanOrEqual(770_000 + PROVIDER_WINDOW_BUFFER_MS - 5_000);
    expect(waited).toBeLessThanOrEqual(770_000 + PROVIDER_WINDOW_BUFFER_MS + 5_000);

    // The deadline is shared state: other jobs' fires defer past it too.
    const deadline = providerWindowResetUntil();
    expect(deadline).not.toBeNull();
    expect(Math.abs((deadline?.getTime() ?? 0) - retries[0].at.getTime())).toBeLessThan(50);

    // No diagnostic agent fired into the exhausted window.
    expect(sourceIds().filter((s) => s.startsWith("diag:"))).toHaveLength(0);
  });

  it("a retry that hits the window again stays a failed run and does not chain another retry", async () => {
    const id = addJob({ name: "YouTube Watchlist Processor", schedule: "0 */3 * * *" });
    const { agent, sourceIds } = recordingResultAgent(RUN_10323);
    const executor = new JobExecutor(agent);
    const retries: number[] = [];
    executor.onProviderRetry = (jobId) => retries.push(jobId);

    await executor.execute(id, { providerRetry: true });

    expect(lastRun(id).status).toBe("error");
    expect(retries).toHaveLength(0);
    // The window deadline is still refreshed for other jobs.
    expect(providerWindowResetUntil()).not.toBeNull();
    expect(sourceIds().filter((s) => s.startsWith("diag:"))).toHaveLength(0);
  });

  it("a non-quota thrown failure still spawns the diagnostic and schedules no retry", async () => {
    const id = addJob({ name: "Alpha Researcher", schedule: "0 */4 * * *" });
    const seen: string[] = [];
    const agent = {
      run: async (req: { sourceId?: string }) => {
        seen.push(req.sourceId ?? "");
        throw new Error("Claude Code process exited with code 1");
      },
      consumeRestart: () => false,
    } satisfies ExecutorAgent;
    const executor = new JobExecutor(agent);
    const retries: number[] = [];
    executor.onProviderRetry = (jobId) => retries.push(jobId);

    await executor.execute(id);

    expect(lastRun(id).status).toBe("error");
    expect(retries).toHaveLength(0);
    expect(seen.filter((s) => s.startsWith("diag:"))).toHaveLength(1);
    expect(providerWindowResetUntil()).toBeNull();
  });
});

describe("Scheduler window defer and retry wiring", () => {
  function recordingScheduler(): {
    scheduler: Scheduler;
    executed: () => Array<{ jobId: number; options?: { manualTrigger?: boolean; providerRetry?: boolean }; at: number }>;
    retryHook: () => ((jobId: number, at: Date) => void) | null;
  } {
    const calls: Array<{ jobId: number; options?: { manualTrigger?: boolean; providerRetry?: boolean }; at: number }> = [];
    const executor = {
      onJobRecovered: null as (() => void) | null,
      onProviderRetry: null as ((jobId: number, at: Date) => void) | null,
      execute: async (jobId: number, options?: { manualTrigger?: boolean; providerRetry?: boolean }) => {
        calls.push({ jobId, options, at: Date.now() });
      },
    };
    // The Scheduler overwrites both hooks on its own executor reference; the
    // stub is the same object, so retryHook() reads the wired handler back.
    return { scheduler: new Scheduler(executor), executed: () => calls, retryHook: () => executor.onProviderRetry };
  }

  it("wires the executor's retry hook: fires the job once with providerRetry at the given time, only while enabled", async () => {
    const live = addJob({ name: "Reddit Saved Poller", schedule: "0 */4 * * *" });
    const dead = addJob({ name: "Parked", schedule: "0 */4 * * *", status: "failed" });
    const { scheduler, executed, retryHook } = recordingScheduler();

    // The executor calls this hook from its catch arm once the window resets.
    scheduler["wireExecutorHooks"](); // no-op if wired in constructor; safe if private-named differently
    const hook = retryHook();
    expect(typeof hook).toBe("function");
    hook!(live, new Date(Date.now() + 20));
    hook!(dead, new Date(Date.now() + 20));

    await sleep(400);
    const calls = executed();
    expect(calls).toHaveLength(1);
    expect(calls[0].jobId).toBe(live);
    expect(calls[0].options?.providerRetry).toBe(true);
    scheduler.stop();
  });

  it("defers a cron fire that lands inside the exhausted window until the deadline", async () => {
    const id = addJob({ name: "GitHub Stars Poller", schedule: "* * * * * *" }); // every second
    const deadline = Date.now() + 2_500;
    setOpsState(PROVIDER_WINDOW_STATE_KEY, new Date(deadline).toISOString());
    const { scheduler, executed } = recordingScheduler();

    scheduler.start();
    await sleep(4_200);
    scheduler.stop();

    const calls = executed();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    // No fire may execute before the window opens (150 ms timer slop allowed).
    for (const c of calls) expect(c.at).toBeGreaterThanOrEqual(deadline - 150);
  });
});
