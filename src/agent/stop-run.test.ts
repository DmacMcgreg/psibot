import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";

/**
 * A reply the user stops (web chat Stop, mini-app Cancel, Telegram Cancel)
 * must be saved as a normal partial assistant message marked
 * stop_reason = "interrupted" — not as "Agent encountered an error".
 *
 * The SDK's query() is faked. It uses mock.module, which is process-wide in
 * bun, so run this file on its own: `bun test src/agent/stop-run.test.ts`.
 */

type Scripted = {
  sessionId: string;
  texts: string[];
  /** What the fake SDK does once interrupted (or, with no interrupt, at the end). */
  end: "throw_on_interrupt" | "throw_now";
};

let script: Scripted;

function fakeQuery() {
  let interrupted: () => void = () => {};
  const interruptedP = new Promise<void>((r) => { interrupted = r; });
  const s = script;
  async function* gen() {
    yield { type: "system", subtype: "init", session_id: s.sessionId };
    for (const text of s.texts) {
      yield { type: "assistant", message: { content: [{ type: "text", text }], usage: {} } };
    }
    if (s.end === "throw_now") throw new Error("Claude Code process exited with code 1");
    await interruptedP;
    throw new Error("Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null");
  }
  const it = gen() as AsyncGenerator<unknown> & { interrupt: () => Promise<void> };
  it.interrupt = async () => { interrupted(); };
  return it;
}

const realSdk = await import("@anthropic-ai/claude-agent-sdk");
mock.module("@anthropic-ai/claude-agent-sdk", () => ({ ...realSdk, query: () => fakeQuery() }));
const { AgentService, STOPPED_BEFORE_REPLY } = await import("./index.ts");

// Throwaway env fixture: the gitignored developer .env normally supplies
// these, a clean checkout has neither, and loadConfig() below refuses to run
// without them. Literal dummies — never a real token or chat id.
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";

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

async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(5);
  if (!cond()) throw new Error("timed out");
}

function assistantRows(sessionId: string) {
  return db
    .prepare(`SELECT content, stop_reason FROM chat_messages WHERE session_id = ? AND role = 'assistant'`)
    .all(sessionId) as Array<{ content: string; stop_reason: string | null }>;
}

// source "job" keeps the run out of the daily log file.
const base = { source: "job" as const, sourceId: "stop-test", _lightweightSystemPrompt: true, model: "haiku", backend: "claude" as const, backendOnly: true };

describe("stopping a run", () => {
  it("resolves with the partial reply and saves it marked interrupted", async () => {
    script = { sessionId: "sess-partial", texts: ["First part.", "Second part."], end: "throw_on_interrupt" };
    const agent = service();
    let runId = "";
    let started = "";
    const chunks: string[] = [];
    let completed: { stopReason: string } | null = null;
    const p = agent.run({
      ...base,
      prompt: "tell me a long story",
      onRunStart: (id) => { runId = id; },
      onSessionStart: (sid) => { started = sid; },
      onText: (t) => chunks.push(t),
      onComplete: (r) => { completed = r; },
    });
    await until(() => chunks.length === 2);
    await agent.interrupt(runId);
    const result = await p;

    expect(started).toBe("sess-partial");
    expect(result.stopReason).toBe("interrupted");
    expect(result.result).toBe("First part.\n\nSecond part.");
    expect(completed).not.toBeNull();
    expect(assistantRows("sess-partial")).toEqual([{ content: "First part.\n\nSecond part.", stop_reason: "interrupted" }]);
    const session = db.prepare(`SELECT source FROM agent_sessions WHERE session_id = ?`).get("sess-partial");
    expect(session).toBeTruthy();
  });

  it("saves a short note when stopped before any text", async () => {
    script = { sessionId: "sess-empty", texts: [], end: "throw_on_interrupt" };
    const agent = service();
    let runId = "";
    let started = false;
    const p = agent.run({ ...base, prompt: "hi", onRunStart: (id) => { runId = id; }, onSessionStart: () => { started = true; } });
    await until(() => started);
    await agent.interrupt(runId);
    const result = await p;
    expect(result.stopReason).toBe("interrupted");
    expect(assistantRows("sess-empty")).toEqual([{ content: STOPPED_BEFORE_REPLY, stop_reason: "interrupted" }]);
  });

  it("still treats a real failure as an error", async () => {
    script = { sessionId: "sess-error", texts: ["Some text."], end: "throw_now" };
    const agent = service();
    await expect(agent.run({ ...base, prompt: "hi" })).rejects.toThrow("exited with code 1");
    const rows = assistantRows("sess-error");
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toStartWith("Agent encountered an error");
    expect(rows[0].stop_reason).toBeNull();
  });
});
