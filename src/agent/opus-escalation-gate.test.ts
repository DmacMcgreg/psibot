import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";

/**
 * Opus escalation gate (fix fcbe15e, 2026-07-05): the "think hard" /
 * "use opus" / "deep think" prompt marker routes the whole turn to
 * claude-opus-4-8 — but ONLY for user-facing sources (telegram, web,
 * mini-app). A job/heartbeat prompt that happens to contain the marker must
 * not override its configured model/backend (opus review finding).
 *
 * The SDK's query() is faked with mock.module, which is process-wide and
 * first-wins in bun — same ownership note as empty-response-retry.test.ts.
 * Run this file on its own: `bun test src/agent/opus-escalation-gate.test.ts`.
 */

// Match empty-response-retry.test.ts's env shrink BEFORE index.ts loads, so
// an accidental same-process run cannot leave the 15s default cached and
// blow that file's retry tests.
process.env.EMPTY_RESPONSE_BACKOFF_MS = "10";

type Turn = { kind: "ok"; sessionId: string; text: string };

let queue: Turn[] = [];
const queryCalls: Array<{ model?: string }> = [];

function fakeQuery(args: { options?: { model?: string } }) {
  queryCalls.push({ model: args?.options?.model });
  const turn = queue.shift();
  async function* gen(): AsyncGenerator<unknown> {
    if (!turn) throw new Error("fakeQuery: unscripted call");
    yield { type: "system", subtype: "init", session_id: turn.sessionId };
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

// Dynamic imports are load-bearing: mock.module must install the SDK fake
// BEFORE ./index.ts evaluates — a static import of index.ts cannot work.
const realSdk = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: fakeQuery }));
const { AgentService } = await import("./index.ts");

let db: Database;
beforeAll(() => {
  loadConfig();
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});
afterAll(() => db.close());

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

const base = {
  sourceId: "escalation-gate-test",
  _lightweightSystemPrompt: true,
  model: "haiku",
  backend: "claude" as const,
  backendOnly: true,
};

const OPUS_MODEL = "claude-opus-4-8";

describe("opus escalation gate (fcbe15e)", () => {
  beforeEach(() => {
    queue = [];
    queryCalls.length = 0;
  });

  it("a job prompt carrying the marker stays on its configured tier", async () => {
    queue = [{ kind: "ok", sessionId: "sess-job-gate", text: "Done." }];
    const result = await service().run({ ...base, source: "job" as const, prompt: "think hard about the weekly digest" });

    expect(result.stopReason).toBe("end_turn");
    expect(queryCalls.map((c) => c.model)).toEqual(["haiku"]); // configured tier, no opus override
  });

  it("a heartbeat prompt carrying the marker stays on its configured tier", async () => {
    queue = [{ kind: "ok", sessionId: "sess-heartbeat-gate", text: "Done." }];
    await service().run({ ...base, source: "heartbeat" as const, prompt: "sweep the inbox — use opus if needed" });

    expect(queryCalls.map((c) => c.model)).toEqual(["haiku"]);
  });

  it("a user-facing prompt carrying the marker still escalates to opus", async () => {
    queue = [{ kind: "ok", sessionId: "sess-web-escalate", text: "Deep answer." }];
    const result = await service().run({ ...base, source: "web" as const, prompt: "think hard about this architecture" });

    expect(result.stopReason).toBe("end_turn");
    expect(queryCalls.map((c) => c.model)).toEqual([OPUS_MODEL]); // gate must not over-block
  });
});
