import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";

/**
 * Empty first responses (upstream returns a user-role result with no
 * assistant turn — the [ede_diagnostic] result_type=user stop_reason=null
 * CLI error) must not land as job error rows: one retry of the same tier
 * after a short backoff, then a skipped result. 2026-10-02 board row
 * psibot-yt-transient-fix; diagnosis in
 * research/psibot-yt-watchlist-diagnosis.md (vivaldi-home repo).
 *
 * The SDK's query() is faked with mock.module, which is process-wide in
 * bun — the same ownership stop-run.test.ts documents. The backoff env is
 * read at retry time by emptyResponseBackoffMs(), so this suite stays green
 * even when an earlier file (scheduler suites) already loaded ./index.ts.
 */

// Throwaway env fixture: the gitignored developer .env normally supplies
// these, a clean checkout has neither, and loadConfig() below refuses to run
// without them. Literal dummies — never a real token or chat id.
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";

// Shrink the retry backoff; index.ts reads it at retry time (not module
// scope), so setting it here reaches the already-loaded module. Saved and
// restored — bun test shares one process with every other suite.
const priorBackoffMs = process.env.EMPTY_RESPONSE_BACKOFF_MS;
process.env.EMPTY_RESPONSE_BACKOFF_MS = "10";

const EMPTY_EDE =
  "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null";

type Turn =
  | { kind: "empty"; sessionId: string }
  | { kind: "ok"; sessionId: string; text: string }
  | { kind: "throw"; sessionId: string; message: string };

let queue: Turn[] = [];
const queryCalls: Array<{ model?: string }> = [];

function fakeQuery(args: { options?: { model?: string } }) {
  queryCalls.push({ model: args?.options?.model });
  const turn = queue.shift();
  async function* gen(): AsyncGenerator<unknown> {
    if (!turn) throw new Error("fakeQuery: unscripted call");
    yield { type: "system", subtype: "init", session_id: turn.sessionId };
    if (turn.kind === "throw") throw new Error(turn.message);
    if (turn.kind === "empty") throw new Error(EMPTY_EDE);
    yield { type: "assistant", message: { content: [{ type: "text", text: turn.text }], usage: {} } };
    yield {
      type: "result",
      result: turn.text,
      subtype: "end_turn",
      total_cost_usd: 0.01,
      duration_ms: 1234,
      num_turns: 1,
      modelUsage: {},
    };
  }
  const it = gen() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
  it.interrupt = async () => {};
  return it;
}

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: fakeQuery }));
const { AgentService, isEmptyFirstResponseError, TOOL_STALE_TIMEOUT_MS } = await import("./index.ts");

let db: Database;
beforeAll(() => {
  loadConfig();
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});
afterAll(() => {
  db.close();
  if (priorBackoffMs === undefined) delete process.env.EMPTY_RESPONSE_BACKOFF_MS;
  else process.env.EMPTY_RESPONSE_BACKOFF_MS = priorBackoffMs;
});

function service() {
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
  return new AgentService(deps as never);
}

// source "job" keeps the run out of the daily log file; backendOnly pins the
// ladder to the claude primary tiers so retry counts are deterministic.
const base = {
  source: "job" as const,
  sourceId: "empty-retry-test",
  _lightweightSystemPrompt: true,
  model: "haiku",
  backend: "claude" as const,
  backendOnly: true,
};

describe("empty first response (transient upstream window)", () => {
  beforeEach(() => {
    queue = [];
    queryCalls.length = 0;
  });

  it("isEmptyFirstResponseError matches the verbatim upstream diagnostic, not near-misses", () => {
    expect(isEmptyFirstResponseError(new Error(EMPTY_EDE))).toBe(true);
    expect(isEmptyFirstResponseError(EMPTY_EDE)).toBe(true);
    // Assistant-turn diagnostics and plain errors are NOT the empty class.
    expect(
      isEmptyFirstResponseError(
        "[ede_diagnostic] result_type=assistant last_content_type=text stop_reason=error_during_execution",
      ),
    ).toBe(false);
    expect(isEmptyFirstResponseError(new Error("Claude Code process exited with code 1"))).toBe(false);
    expect(isEmptyFirstResponseError(undefined)).toBe(false);
  });

  it("retries the same tier once after backoff and returns the successful retry", async () => {
    queue = [
      { kind: "empty", sessionId: "sess-empty-1" },
      { kind: "ok", sessionId: "sess-ok-1", text: "Recovered." },
    ];
    const result = await service().run({ ...base, prompt: "process playlist" });

    expect(result.stopReason).toBe("end_turn");
    expect(result.result).toBe("Recovered.");
    expect(result.costUsd).toBe(0.01); // cost recorded on the class, not NULL
    expect(queryCalls).toHaveLength(2); // one retry, then success
    expect(queryCalls.map((c) => c.model)).toEqual(["haiku", "haiku"]); // same tier, no ladder walk
    expect(result.result).not.toContain("[fallback:");
  });

  it("returns a skipped result instead of throwing when the window persists", async () => {
    queue = [
      { kind: "empty", sessionId: "sess-empty-2" },
      { kind: "empty", sessionId: "sess-empty-2b" },
    ];
    const result = await service().run({ ...base, prompt: "process playlist" });

    expect(result.result).toStartWith("Skipped:");
    expect(result.costUsd).toBe(0);
    expect(queryCalls).toHaveLength(2); // terminal after the one retry — no 5-tier ladder walk
  });

  it("still throws non-empty CLI error results unchanged", async () => {
    queue = [
      {
        kind: "throw",
        sessionId: "sess-throw-1",
        message:
          "Claude Code returned an error result: [ede_diagnostic] result_type=assistant last_content_type=text stop_reason=error_during_execution",
      },
    ];
    await expect(service().run({ ...base, prompt: "p" })).rejects.toThrow("error_during_execution");
    expect(queryCalls).toHaveLength(1);
  });

  it("does not retry a resumed session — the user turn is already persisted", async () => {
    queue = [{ kind: "empty", sessionId: "sess-resumed" }];
    await expect(service().run({ ...base, prompt: "p", sessionId: "sess-resumed" })).rejects.toThrow(
      "[ede_diagnostic]",
    );
    expect(queryCalls).toHaveLength(1);
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = 'sess-resumed' AND role = 'user'`)
      .get() as { c: number };
    expect(rows.c).toBe(1); // a retry would have duplicated it
  });

  it("keeps the tool-stale watchdog above the playlist batch budget", () => {
    // src/youtube/playlist.ts defaults timeBudgetMs to 10 min; the old 15-min
    // watchdog killed catch-up batches that overshot it (exact-15:00.0 kills).
    expect(TOOL_STALE_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * 10 * 60 * 1000);
  });
});
