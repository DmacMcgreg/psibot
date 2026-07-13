import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import type { MemorySystem } from "../memory/index.ts";
import type {
  EntityStatus,
  FleetEvent,
  FleetProposal,
  FleetSnapshot,
} from "./fleet-reader.ts";
import { ChatState } from "../telegram/state.ts";
import type { HeartbeatRunner as HeartbeatRunnerType } from "./index.ts";

// Keep every external boundary in this test local. The reader still opens a real
// SQLite file, while the MCP and launchctl boundedness tests use a disposable
// fake hub-edge executable and an in-memory subprocess mock.
const originalEnv = {
  HUB_FLEET_DB: process.env.HUB_FLEET_DB,
  HUB_EDGE_BIN: process.env.HUB_EDGE_BIN,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ALLOWED_TELEGRAM_USER_IDS: process.env.ALLOWED_TELEGRAM_USER_IDS,
  TELEGRAM_GROUP_CHAT_IDS: process.env.TELEGRAM_GROUP_CHAT_IDS,
};
const testRoot = mkdtempSync(join(tmpdir(), "psibot-e2-t08-"));
const fleetDbPath = join(testRoot, "fleet.db");
const fakeHubEdgePath = join(testRoot, "fake-hub-edge");
const fakeHubEdgeMarker = join(testRoot, "fake-hub-edge.pid");

writeFileSync(
  fakeHubEdgePath,
  `#!/bin/sh
printf '%s' "$$" > ${JSON.stringify(fakeHubEdgeMarker)}
cat >/dev/null
`,
);
chmodSync(fakeHubEdgePath, 0o755);

process.env.HUB_FLEET_DB = fleetDbPath;
process.env.HUB_EDGE_BIN = fakeHubEdgePath;
process.env.TELEGRAM_BOT_TOKEN = "e2-t08-test-token";
process.env.ALLOWED_TELEGRAM_USER_IDS = "1";
process.env.TELEGRAM_GROUP_CHAT_IDS = "";

// Import the config-dependent modules only after the temporary path is in the
// environment. loadConfig() is memoized by design, so this ordering is part of
// the test contract rather than incidental setup.
const { loadConfig } = await import("../config.ts");
const { MIGRATIONS } = await import("../db/schema.ts");
const { setDbForTesting } = await import("../db/index.ts");
const { getFleetState, setFleetState } = await import("../db/queries.ts");
const { Cron } = await import("croner");
const { HeartbeatRunner, buildFleetDigestLines, buildFleetProposalCard } = await import("./index.ts");
const {
  openFleetDbReadOnly,
  readAlertedEventBatchSince,
  readAlertedEventsSince,
  readLatestSnapshot,
  readPendingFleetProposals,
  renderFleetEvent,
} = await import("./fleet-reader.ts");

const A4_DDL = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  `CREATE TABLE IF NOT EXISTS snapshots (
    ts INTEGER PRIMARY KEY,
    json TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    entity_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT,
    reason_class TEXT,
    fingerprint TEXT,
    alerted INTEGER NOT NULL DEFAULT 0,
    verbs TEXT NOT NULL DEFAULT '[]',
    detail TEXT NOT NULL DEFAULT ''
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL,
    entity_id TEXT NOT NULL, verb TEXT NOT NULL, args TEXT, rationale TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', decided_ts INTEGER
  ) STRICT`,
];

interface KickstartResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunnerTestView {
  cron: unknown;
  fleetPreludeCron: unknown;
  running: boolean;
  lastFleetPreludeSlot: number | null;
  fleetStaleStreak: number;
  hubDeathAlerted: boolean;
  sourceLostAlerted: boolean;
  tick(): Promise<void>;
  fleetPreludeTick(): Promise<void>;
  runFleetPrelude(): Promise<void>;
  phaseFleetAlerts(): Promise<void>;
  phaseFleetProposals(): Promise<void>;
  phaseFleetStaleness(): Promise<void>;
  isQuietHours(): boolean;
  confirmHubDoctor(timeoutMs: number): Promise<boolean>;
  kickstartHubCore(timeoutMs?: number): Promise<KickstartResult | null>;
  sendFleetStatusAlert(message: string, kind: string): Promise<void>;
}

interface SentMessage {
  chatId: number | string;
  text: string;
  options: Record<string, unknown> | undefined;
}

interface AlertRecord {
  message: string;
  kind: string;
}

interface StalenessHarness {
  alerts: AlertRecord[];
  doctorTimeouts: number[];
  kickstartTimeouts: Array<number | undefined>;
}

let ownDb: Database;
let fleetWriter: Database | null = null;
let nextSnapshotTs = 1;

function runnerView(runner: HeartbeatRunnerType): RunnerTestView {
  return runner as unknown as RunnerTestView;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function destroyFleetDb(): void {
  fleetWriter?.close();
  fleetWriter = null;
  rmSync(fleetDbPath, { force: true });
  rmSync(`${fleetDbPath}-wal`, { force: true });
  rmSync(`${fleetDbPath}-shm`, { force: true });
}

function prepareFleetDb(): Database {
  destroyFleetDb();
  fleetWriter = new Database(fleetDbPath);
  for (const sql of A4_DDL) fleetWriter.exec(sql);
  return fleetWriter;
}

function insertSnapshot(value: unknown, ts = nextSnapshotTs++): void {
  if (!fleetWriter) throw new Error("fleet DB fixture is not prepared");
  fleetWriter
    .prepare("INSERT INTO snapshots (ts, json) VALUES (?, ?)")
    .run(ts, JSON.stringify(value));
}

interface EventSeed {
  id: number;
  ts?: number;
  entity?: string;
  kind?: string;
  fromState?: string | null;
  toState?: string | null;
  reasonClass?: string | null;
  fingerprint?: string | null;
  alerted?: number;
  verbs?: string;
  detail?: string;
}

function insertEvent(seed: EventSeed): void {
  if (!fleetWriter) throw new Error("fleet DB fixture is not prepared");
  fleetWriter
    .prepare(
      `INSERT INTO events
        (id, ts, entity_id, kind, from_state, to_state, reason_class, fingerprint, alerted, verbs, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      seed.ts ?? seed.id,
      seed.entity ?? "hub-core",
      seed.kind ?? "transition",
      seed.fromState ?? null,
      seed.toState ?? null,
      seed.reasonClass ?? null,
      seed.fingerprint ?? null,
      seed.alerted ?? 1,
      seed.verbs ?? "[]",
      seed.detail ?? "test detail",
    );
}

function makeEntity(id: string, alertState: EntityStatus["alertState"]): EntityStatus {
  return {
    id,
    kind: "app",
    tier: "legacy",
    reachability: "reachable",
    health: "pass",
    alertState,
    pid: null,
    rssBytes: null,
    cpuPct: null,
    since: 1_000,
    detail: "test",
  };
}

function makeSnapshot(
  entities: EntityStatus[],
  generatedAtMs = 100_000,
  pollIntervalMs = 1_000,
): FleetSnapshot {
  return {
    schemaVersion: 1,
    generatedAtMs,
    pollIntervalMs,
    hostId: "test-host",
    entities,
    approvals: {
      pending: 0,
      vaultReachable: true,
      approvalsSource: "e7-t06",
    },
    pool: { active: "claude" },
    pollDurationMs: 1,
    pollErrors: [],
  };
}

function makeEvent(overrides: Partial<FleetEvent> = {}): FleetEvent {
  return {
    id: 1,
    ts: 1_000,
    entity: "hub-core",
    kind: "transition",
    alerted: 1,
    verbs: [],
    detail: "test detail",
    ...overrides,
  };
}

function makeBot(
  sendMessage: (
    chatId: number | string,
    text: string,
    options?: Record<string, unknown>,
  ) => Promise<unknown>,
): Bot {
  return {
    api: { sendMessage },
  } as unknown as Bot;
}

function makeRunner(options: {
  bot?: Bot | null;
  chatIds?: number[];
  digestChatId?: string;
  now?: () => number;
  state?: ChatState;
  readPendingFleetProposals?: (nowMs?: number) => FleetProposal[];
} = {}): HeartbeatRunnerType {
  return new HeartbeatRunner({
    getBot: () => options.bot ?? null,
    defaultChatIds: options.chatIds ?? [101, 202],
    digestChatId: options.digestChatId,
    config: {
      intervalMinutes: 30,
      fleetPreludeIntervalMinutes: 3,
      quietStart: 0,
      quietEnd: 0,
    },
    memory: {} as unknown as MemorySystem,
    now: options.now,
    state: options.state,
    readPendingFleetProposals: options.readPendingFleetProposals,
  });
}

function installStalenessStubs(
  runner: HeartbeatRunnerType,
  doctorResult: boolean,
  kickstartResult: KickstartResult | null = {
    exitCode: 0,
    stdout: "",
    stderr: "",
  },
): StalenessHarness {
  const view = runnerView(runner);
  const harness: StalenessHarness = {
    alerts: [],
    doctorTimeouts: [],
    kickstartTimeouts: [],
  };
  view.confirmHubDoctor = async (timeoutMs) => {
    harness.doctorTimeouts.push(timeoutMs);
    return doctorResult;
  };
  view.kickstartHubCore = async (timeoutMs) => {
    harness.kickstartTimeouts.push(timeoutMs);
    return kickstartResult;
  };
  view.sendFleetStatusAlert = async (message, kind) => {
    harness.alerts.push({ message, kind });
  };
  return harness;
}

async function withDateNow<T>(nowMs: number, action: () => Promise<T>): Promise<T> {
  const originalDateNow = Date.now;
  Object.defineProperty(Date, "now", { configurable: true, value: () => nowMs });
  try {
    return await action();
  } finally {
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
  }
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number(readFileSync(path, "utf8"));
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeHangingSubprocess(): { process: Bun.Subprocess; wasKilled: () => boolean } {
  let killed = false;
  let exitCode: number | null = null;
  let resolveExited!: (code: number) => void;
  let closeStdout!: () => void;
  let closeStderr!: () => void;

  const makeStream = (): { stream: ReadableStream<Uint8Array>; close: () => void } => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController;
      },
    });
    return {
      stream,
      close: () => controller?.close(),
    };
  };

  const stdout = makeStream();
  const stderr = makeStream();
  closeStdout = stdout.close;
  closeStderr = stderr.close;
  const exited = new Promise<number>((resolve) => {
    resolveExited = resolve;
  });

  const subprocess = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    get exitCode() {
      return exitCode;
    },
    kill() {
      killed = true;
      exitCode = 137;
      closeStdout();
      closeStderr();
      resolveExited(137);
    },
  } as unknown as Bun.Subprocess;

  return { process: subprocess, wasKilled: () => killed };
}

beforeAll(() => {
  ownDb = new Database(":memory:");
  ownDb.exec("PRAGMA journal_mode = WAL");
  ownDb.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(ownDb);
  for (const sql of MIGRATIONS) ownDb.exec(sql);
  setDbForTesting(ownDb);

  // This assertion proves the temp path won the first memoized config read.
  expect(loadConfig().HUB_FLEET_DB).toBe(fleetDbPath);
});

beforeEach(() => {
  ownDb.exec("DELETE FROM fleet_state");
  destroyFleetDb();
  nextSnapshotTs = 1;
});

afterAll(() => {
  destroyFleetDb();
  ownDb.close();
  restoreEnv("HUB_FLEET_DB", originalEnv.HUB_FLEET_DB);
  restoreEnv("HUB_EDGE_BIN", originalEnv.HUB_EDGE_BIN);
  restoreEnv("TELEGRAM_BOT_TOKEN", originalEnv.TELEGRAM_BOT_TOKEN);
  restoreEnv("ALLOWED_TELEGRAM_USER_IDS", originalEnv.ALLOWED_TELEGRAM_USER_IDS);
  restoreEnv("TELEGRAM_GROUP_CHAT_IDS", originalEnv.TELEGRAM_GROUP_CHAT_IDS);
  rmSync(testRoot, { recursive: true, force: true });
});

describe("E2-T08 fleet.db reader and config harness", () => {
  test("memoizes the temp HUB_FLEET_DB selected before the first config read", () => {
    expect(loadConfig().HUB_FLEET_DB).toBe(fleetDbPath);
    process.env.HUB_FLEET_DB = join(testRoot, "should-not-replace-memoized-path.db");
    expect(loadConfig().HUB_FLEET_DB).toBe(fleetDbPath);
    process.env.HUB_FLEET_DB = fleetDbPath;
  });

  test("degrades to null and empty results when the configured fleet DB is absent", () => {
    expect(openFleetDbReadOnly()).toBeNull();
    expect(readLatestSnapshot()).toBeNull();
    expect(readAlertedEventsSince(0)).toEqual([]);
  });

  test("creates the exact A4 tables and opens the file read-only", () => {
    prepareFleetDb();
    const tables = fleetWriter!
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables.filter((name) => name === "events" || name === "snapshots")).toEqual([
      "events",
      "snapshots",
    ]);

    const readOnly = openFleetDbReadOnly();
    expect(readOnly).not.toBeNull();
    if (readOnly) {
      expect(() => readOnly.exec("INSERT INTO events (entity_id, kind) VALUES ('x', 'verb')")).toThrow();
      readOnly.close();
    }
  });

  test("parses a valid snapshot with up and down entities from the real file", () => {
    prepareFleetDb();
    const snapshot = makeSnapshot([
      makeEntity("hub-core", "up"),
      makeEntity("psibot", "down"),
    ]);
    insertSnapshot(snapshot);

    expect(readLatestSnapshot()).toEqual(snapshot);
  });

  test("accepts a runtime snapshot that omits the future pool field", () => {
    prepareFleetDb();
    const snapshot = makeSnapshot([makeEntity("hub-core", "up")]);
    const snapshotWithoutPool: Record<string, unknown> = { ...snapshot };
    delete snapshotWithoutPool.pool;
    insertSnapshot(snapshotWithoutPool);

    expect(readLatestSnapshot()).not.toBeNull();
  });

  test("degrades malformed JSON, malformed shape, and newer schema rows to null", () => {
    prepareFleetDb();
    fleetWriter!
      .prepare("INSERT INTO snapshots (ts, json) VALUES (?, ?)")
      .run(1, "{not-json");
    expect(readLatestSnapshot()).toBeNull();

    fleetWriter!.exec("DELETE FROM snapshots");
    insertSnapshot({
      ...makeSnapshot([makeEntity("hub-core", "up")]),
      entities: [{ ...makeEntity("hub-core", "up"), alertState: "corrupt" }],
    });
    expect(readLatestSnapshot()).toBeNull();

    fleetWriter!.exec("DELETE FROM snapshots");
    insertSnapshot({ ...makeSnapshot([makeEntity("hub-core", "up")]), schemaVersion: 2 });
    expect(readLatestSnapshot()).toBeNull();
  });

  test("filters alerted events, parses verbs, and uses a strict greater-than cursor", () => {
    prepareFleetDb();
    insertEvent({ id: 1, verbs: '["restart", "silence"]', detail: "first" });
    insertEvent({ id: 2, alerted: 0, detail: "not queued" });
    insertEvent({ id: 3, verbs: '["open_logs"]', detail: "third" });

    const firstRead = readAlertedEventsSince(0);
    expect(firstRead.map((event) => event.id)).toEqual([1, 3]);
    expect(firstRead[0]?.verbs).toEqual(["restart", "silence"]);
    expect(firstRead[1]?.verbs).toEqual(["open_logs"]);
    expect(readAlertedEventsSince(firstRead[0]?.id ?? 0).map((event) => event.id)).toEqual([3]);

    fleetWriter!.exec("DELETE FROM events");
    insertEvent({ id: 4, detail: "four" });
    insertEvent({ id: 5, detail: "five" });
    expect(readAlertedEventsSince(4).map((event) => event.id)).toEqual([5]);
  });

  test("skips malformed rows without throwing and advances the scan cursor", () => {
    prepareFleetDb();
    insertEvent({ id: 1, kind: "unknown-kind", detail: "skip me" });
    insertEvent({ id: 2, detail: "valid" });
    insertEvent({ id: 3, verbs: "not-json", detail: "valid with fallback verbs" });

    const batch = readAlertedEventBatchSince(0);
    expect(batch.events.map((event) => event.id)).toEqual([2, 3]);
    expect(batch.events[1]?.verbs).toEqual([]);
    expect(batch.maxScannedId).toBe(3);
  });

  test("closes a distinct read-only SQLite handle after every reader operation", () => {
    prepareFleetDb();
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")]));
    insertEvent({ id: 1, detail: "queued" });
    const originalClose = Database.prototype.close;
    const closedHandles: Database[] = [];
    Database.prototype.close = function closeObservedHandle(this: Database): void {
      closedHandles.push(this);
      originalClose.call(this);
    };

    try {
      expect(readLatestSnapshot()).not.toBeNull();
      expect(readAlertedEventsSince(0)).toHaveLength(1);
      fleetWriter!.prepare("UPDATE snapshots SET json = ?").run("{not-json");
      expect(readLatestSnapshot()).toBeNull();
    } finally {
      Database.prototype.close = originalClose;
    }

    expect(closedHandles).toHaveLength(3);
    expect(new Set(closedHandles).size).toBe(3);
    expect(closedHandles).not.toContain(fleetWriter);
  });

  test("reads only live pending proposals and closes fresh handles on success and query failure", () => {
    prepareFleetDb();
    const now = 100_000_000;
    const insert = fleetWriter!.prepare(
      "INSERT INTO proposals (id, ts, entity_id, verb, args, rationale, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("proposal0001", now - 1, "hub<&>", "restart", null, "Recover <now> & safely", "pending");
    insert.run("proposal0002", now - 24 * 60 * 60 * 1_000, "old", "restart", null, "Expired", "pending");
    insert.run("proposal0003", now - 2, "done", "restart", null, "Done", "executed");

    const originalClose = Database.prototype.close;
    let opens = 0;
    let closes = 0;
    Database.prototype.close = function observedClose(this: Database): void {
      closes++;
      originalClose.call(this);
    };
    try {
      const factory = () => {
        opens++;
        return new Database(fleetDbPath, { readonly: true });
      };
      expect(readPendingFleetProposals(now, factory)).toEqual([{
        id: "proposal0001",
        ts: now - 1,
        entity: "hub<&>",
        verb: "restart",
        args: null,
        rationale: "Recover <now> & safely",
        status: "pending",
      }]);
      expect(readPendingFleetProposals(now, () => {
        opens++;
        return new Database(":memory:");
      })).toEqual([]);
    } finally {
      Database.prototype.close = originalClose;
    }
    expect({ opens, closes }).toEqual({ opens: 2, closes: 2 });
  });

  test("exposes no fleet proposal write method", () => {
    const readerExports = {
      openFleetDbReadOnly,
      readAlertedEventBatchSince,
      readAlertedEventsSince,
      readLatestSnapshot,
      readPendingFleetProposals,
      renderFleetEvent,
    };
    expect(Object.keys(readerExports).filter((name) => /write|update|decide|insert/i.test(name))).toEqual([]);
  });
});

describe("E8-T14 proposal cards", () => {
  const proposal: FleetProposal = {
    id: "proposal0001",
    ts: 1,
    entity: `hub<"quoted">'&`,
    verb: `restart"'<&>`,
    args: null,
    rationale: `Recover "now" & 'safely' <today>`,
    status: "pending",
  };

  test("HTML-escapes card fields", () => {
    const card = buildFleetProposalCard(proposal);
    expect(card).toContain("<code>hub&lt;&quot;quoted&quot;&gt;&#39;&amp;</code>");
    expect(card).toContain("<code>restart&quot;&#39;&lt;&amp;&gt;</code>");
    expect(card).toContain("Recover &quot;now&quot; &amp; &#39;safely&#39; &lt;today&gt;");
    expect(card).not.toContain(`hub<"quoted">'&`);
  });

  test("marks only successful sends, retries failures, and deduplicates successes", async () => {
    const state = new ChatState();
    const sent: SentMessage[] = [];
    let shouldFail = true;
    const runner = makeRunner({
      chatIds: [101, 202, 303],
      state,
      readPendingFleetProposals: () => [proposal],
      bot: makeBot(async (chatId, text, options) => {
        sent.push({ chatId, text, options });
        if (shouldFail) throw new Error("simulated Telegram failure");
        return {};
      }),
    });
    const view = runnerView(runner);

    await view.phaseFleetProposals();
    expect(state.renderedFleetProposalIds.has(proposal.id)).toBe(false);
    shouldFail = false;
    await view.phaseFleetProposals();
    expect(state.renderedFleetProposalIds.has(proposal.id)).toBe(true);
    await view.phaseFleetProposals();

    expect(sent).toHaveLength(2);
    expect(sent.map(({ chatId }) => chatId)).toEqual([101, 101]);
    expect(sent[1]?.options).toMatchObject({ parse_mode: "HTML" });
    expect((sent[1]?.options?.reply_markup as { inline_keyboard: unknown }).inline_keyboard).toEqual([[
      { text: "Approve", callback_data: "fp:proposal0001:a" },
      { text: "Reject", callback_data: "fp:proposal0001:r" },
    ]]);
  });

  test("chooses exactly one canonical destination even when multiple chats are configured", async () => {
    const sendToDefaults: Array<string | number> = [];
    const defaultRunner = makeRunner({
      chatIds: [101, 202, 303],
      state: new ChatState(),
      readPendingFleetProposals: () => [proposal],
      bot: makeBot(async (chatId) => {
        sendToDefaults.push(chatId);
        return {};
      }),
    });
    await runnerView(defaultRunner).phaseFleetProposals();
    expect(sendToDefaults).toEqual([101]);

    const sendToDigest: Array<string | number> = [];
    const digestRunner = makeRunner({
      chatIds: [101, 202, 303],
      digestChatId: "-500",
      state: new ChatState(),
      readPendingFleetProposals: () => [proposal],
      bot: makeBot(async (chatId) => {
        sendToDigest.push(chatId);
        return {};
      }),
    });
    await runnerView(digestRunner).phaseFleetProposals();
    expect(sendToDigest).toEqual(["-500"]);
  });
});

describe("E2-T08 alert rendering, watermark, and retry semantics", () => {
  test("renders every event kind with HTML escaping", () => {
    expect(renderFleetEvent(makeEvent({ toState: "down", detail: "<evil>&" }))).toBe(
      "🔴 <b>hub-core</b> DOWN — &lt;evil&gt;&amp;",
    );
    expect(renderFleetEvent(makeEvent({ fromState: "down", toState: "up" }))).toContain("recovered");
    expect(renderFleetEvent(makeEvent({ toState: "flapping" }))).toContain("flapping");
    expect(
      renderFleetEvent(
        makeEvent({ kind: "verb", entity: "<evil>&", detail: "<payload>&" }),
      ),
    ).toBe("ℹ️ <b>&lt;evil&gt;&amp;</b> verb: &lt;payload&gt;&amp;");
  });

  test("sends an alerted event to every chat and commits its watermark", async () => {
    prepareFleetDb();
    insertEvent({ id: 7, toState: "down", detail: "<disk>&" });
    const sent: SentMessage[] = [];
    const bot = makeBot(async (chatId, text, options) => {
      sent.push({ chatId, text, options });
    });
    const runner = makeRunner({ bot, chatIds: [101, 202] });

    await runnerView(runner).phaseFleetAlerts();

    expect(sent).toHaveLength(2);
    expect(sent.map((message) => message.chatId)).toEqual([101, 202]);
    expect(sent[0]?.text).toBe("🔴 <b>hub-core</b> DOWN — &lt;disk&gt;&amp;");
    expect(sent[0]?.options).toEqual({ parse_mode: "HTML" });
    expect(ownDb.prepare("SELECT value FROM fleet_state WHERE key = ?").get("fleet_event_watermark")).toEqual({
      value: "7",
    });
  });

  test("renders recovery, flapping, and generic events exactly through HeartbeatRunner", async () => {
    prepareFleetDb();
    insertEvent({
      id: 12,
      entity: "hub-core",
      fromState: "down",
      toState: "up",
      detail: "healthy again",
    });
    insertEvent({
      id: 13,
      entity: "psibot",
      fromState: "up",
      toState: "flapping",
      detail: "three edges",
    });
    insertEvent({
      id: 14,
      entity: "disk<root>&",
      kind: "threshold",
      detail: "usage < 5% & falling",
    });
    const sent: SentMessage[] = [];
    const runner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        sent.push({ chatId, text, options });
      }),
      chatIds: [101],
    });

    await runnerView(runner).phaseFleetAlerts();

    expect(sent.map((message) => message.text)).toEqual([
      "✅ <b>hub-core</b> recovered — healthy again",
      "⚠️ <b>psibot</b> flapping — three edges",
      "ℹ️ <b>disk&lt;root&gt;&amp;</b> threshold: usage &lt; 5% &amp; falling",
    ]);
    expect(sent.map((message) => message.options)).toEqual([
      { parse_mode: "HTML" },
      { parse_mode: "HTML" },
      { parse_mode: "HTML" },
    ]);
    expect(getFleetStateValue("fleet_event_watermark")).toBe("14");
  });

  test("advances the production watermark when a batch contains only malformed rows", async () => {
    prepareFleetDb();
    insertEvent({ id: 20, kind: "invalid-one" });
    insertEvent({ id: 21, kind: "invalid-two" });
    const sent: SentMessage[] = [];
    const runner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        sent.push({ chatId, text, options });
      }),
      chatIds: [101],
    });

    await runnerView(runner).phaseFleetAlerts();

    expect(sent).toEqual([]);
    expect(getFleetStateValue("fleet_event_watermark")).toBe("21");
  });

  test("isolates per-chat send failures and still commits the attempted cursor", async () => {
    prepareFleetDb();
    insertEvent({ id: 8, toState: "down" });
    const attempts: number[] = [];
    const bot = makeBot(async (chatId) => {
      attempts.push(Number(chatId));
      if (chatId === 101) throw new Error("simulated Telegram rejection");
    });
    const runner = makeRunner({ bot, chatIds: [101, 202] });

    await runnerView(runner).phaseFleetAlerts();

    expect(attempts).toEqual([101, 202]);
    expect(ownDb.prepare("SELECT value FROM fleet_state WHERE key = ?").get("fleet_event_watermark")).toEqual({
      value: "8",
    });
  });

  test("leaves the committed watermark untouched when the bot is unavailable", async () => {
    prepareFleetDb();
    insertEvent({ id: 9, toState: "down" });
    setFleetState("fleet_event_watermark", "4");
    const runner = makeRunner({ bot: null, chatIds: [101] });

    await runnerView(runner).phaseFleetAlerts();

    expect(getFleetStateValue("fleet_event_watermark")).toBe("4");
  });

  test("restarting from a committed watermark makes zero duplicate sends", async () => {
    prepareFleetDb();
    insertEvent({ id: 10, toState: "down" });
    const firstRun: SentMessage[] = [];
    const firstRunner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        firstRun.push({ chatId, text, options });
      }),
      chatIds: [101],
    });
    await runnerView(firstRunner).phaseFleetAlerts();
    expect(firstRun).toHaveLength(1);

    // Honest E2 guarantee: the send -> SQLite commit crash window can duplicate
    // a Telegram attempt, but a successfully committed cursor selects no event twice.
    const afterRestart: SentMessage[] = [];
    const restartedRunner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        afterRestart.push({ chatId, text, options });
      }),
      chatIds: [101],
    });
    await runnerView(restartedRunner).phaseFleetAlerts();

    expect(afterRestart).toEqual([]);
    expect(getFleetStateValue("fleet_event_watermark")).toBe("10");
  });

  test("advances after best-effort attempts, so a committed failed send is not retried", async () => {
    prepareFleetDb();
    insertEvent({ id: 11, toState: "down" });
    let attempts = 0;
    const bot = makeBot(async () => {
      attempts++;
      throw new Error("simulated send failure");
    });
    const runner = makeRunner({ bot, chatIds: [101] });

    await runnerView(runner).phaseFleetAlerts();
    await runnerView(makeRunner({ bot, chatIds: [101] })).phaseFleetAlerts();

    expect(attempts).toBe(1);
    expect(getFleetStateValue("fleet_event_watermark")).toBe("11");
  });
});

describe("E3-T09 fleet alert keyboard coupling", () => {
  test("renders restart and silence as the exact supported callback buttons", async () => {
    prepareFleetDb();
    insertEvent({
      id: 30,
      entity: "hub-core",
      verbs: '["restart","silence"]',
    });
    const sent: SentMessage[] = [];
    const runner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        sent.push({ chatId, text, options });
      }),
      chatIds: [101],
    });

    await runnerView(runner).phaseFleetAlerts();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toMatchObject({ parse_mode: "HTML" });
    expect(sent[0]?.options?.reply_markup).toEqual({
      inline_keyboard: [[
        { text: "🔄 Restart", callback_data: "fr:hub-core" },
        { text: "🔕 Silence", callback_data: "fs:hub-core" },
      ]],
    });
    expect(Buffer.byteLength("fr:hub-core", "utf8")).toBe(11);
    expect(Buffer.byteLength("fs:hub-core", "utf8")).toBe(11);
  });

  test("keeps empty verb lists as plain-text fleet alerts", async () => {
    prepareFleetDb();
    insertEvent({ id: 31, verbs: "[]" });
    const sent: SentMessage[] = [];
    const runner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        sent.push({ chatId, text, options });
      }),
      chatIds: [101],
    });

    await runnerView(runner).phaseFleetAlerts();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ parse_mode: "HTML" });
  });

  test("skips unknown verb names without guessing a callback code", async () => {
    prepareFleetDb();
    insertEvent({ id: 32, verbs: '["stop"]' });
    const sent: SentMessage[] = [];
    const runner = makeRunner({
      bot: makeBot(async (chatId, text, options) => {
        sent.push({ chatId, text, options });
      }),
      chatIds: [101],
    });

    await runnerView(runner).phaseFleetAlerts();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.options).toEqual({ parse_mode: "HTML" });
  });

  for (const scenario of [
    { label: "long ASCII", id: 33, entity: "a".repeat(62), callbackBytes: 65 },
    { label: "multibyte", id: 34, entity: "界".repeat(21), callbackBytes: 66 },
  ]) {
    test(`sends and watermarks ${scenario.label} entity alerts without oversized buttons`, async () => {
      prepareFleetDb();
      insertEvent({
        id: scenario.id,
        entity: scenario.entity,
        verbs: '["restart","silence"]',
      });
      const sent: SentMessage[] = [];
      const runner = makeRunner({
        bot: makeBot(async (chatId, text, options) => {
          sent.push({ chatId, text, options });
        }),
        chatIds: [101],
      });

      expect(Buffer.byteLength(`fr:${scenario.entity}`, "utf8")).toBe(scenario.callbackBytes);
      expect(Buffer.byteLength(`fs:${scenario.entity}`, "utf8")).toBe(scenario.callbackBytes);

      await runnerView(runner).phaseFleetAlerts();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toContain(`<b>${scenario.entity}</b>`);
      expect(sent[0]?.options).toEqual({ parse_mode: "HTML" });
      expect(getFleetStateValue("fleet_event_watermark")).toBe(String(scenario.id));
    });
  }
});

function getFleetStateValue(key: string): string | null {
  return getFleetState(key);
}

describe("E2-T08 heartbeat lifecycle, guard, cadence, and digest", () => {
  test("starts exactly two Cron schedules with the ADR-0042 patterns and stops both", () => {
    const runner = makeRunner();
    const view = runnerView(runner);

    runner.start();
    try {
      const schedules = Object.values(runner).filter(
        (value): value is InstanceType<typeof Cron> => value instanceof Cron,
      );
      expect(schedules).toHaveLength(2);
      expect(schedules.map((schedule) => schedule.getPattern()).sort()).toEqual([
        "*/3 * * * *",
        "*/30 * * * *",
      ]);
      expect(view.cron).toBeInstanceOf(Cron);
      expect(view.fleetPreludeCron).toBeInstanceOf(Cron);
    } finally {
      runner.stop();
    }

    expect(view.cron).toBeNull();
    expect(view.fleetPreludeCron).toBeNull();
  });

  test("uses one shared running guard across heartbeat and dedicated prelude callbacks", async () => {
    const runner = makeRunner();
    const view = runnerView(runner);
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    view.runFleetPrelude = async () => {
      entered = true;
      await held;
    };
    view.isQuietHours = () => true;

    const heartbeat = view.tick();
    while (!entered) await Bun.sleep(1);
    await view.fleetPreludeTick();
    expect(view.running).toBe(true);

    release();
    await heartbeat;
    expect(view.running).toBe(false);
  });

  test("deduplicates same-slot dual callbacks and runs the next cadence slot", async () => {
    let nowMs = 3 * 60_000;
    const runner = makeRunner({ now: () => nowMs });
    const view = runnerView(runner);
    let alertRuns = 0;
    let stalenessRuns = 0;
    view.phaseFleetAlerts = async () => {
      alertRuns++;
    };
    view.phaseFleetStaleness = async () => {
      stalenessRuns++;
    };
    view.isQuietHours = () => true;

    await view.tick();
    await view.fleetPreludeTick();
    expect(alertRuns).toBe(1);
    expect(stalenessRuns).toBe(1);

    nowMs += 3 * 60_000;
    await view.fleetPreludeTick();
    expect(alertRuns).toBe(2);
    expect(stalenessRuns).toBe(2);
  });

  test("runs the interrupt prelude before the quiet-hours early return", async () => {
    const runner = makeRunner();
    const view = runnerView(runner);
    let alertRuns = 0;
    let stalenessRuns = 0;
    view.phaseFleetAlerts = async () => {
      alertRuns++;
    };
    view.phaseFleetStaleness = async () => {
      stalenessRuns++;
    };
    view.isQuietHours = () => true;

    await view.tick();

    expect(alertRuns).toBe(1);
    expect(stalenessRuns).toBe(1);
  });

  test("folds no snapshot, one not-up entity, and all-up snapshots into the digest", () => {
    expect(buildFleetDigestLines(null)).toEqual([]);
    expect(
      buildFleetDigestLines(
        makeSnapshot([
          makeEntity("hub<core>", "down"),
          makeEntity("psibot", "up"),
          makeEntity("vaultd", "up"),
        ]),
      ),
    ).toEqual(["Fleet: 1 of 3 not up (hub&lt;core&gt;)"]);
    expect(
      buildFleetDigestLines(
        makeSnapshot([
          makeEntity("hub-core", "up"),
          makeEntity("psibot", "up"),
          makeEntity("vaultd", "up"),
        ]),
      ),
    ).toEqual(["Fleet: 3/3 up"]);
  });
});

describe("E2-T08 staleness matrix", () => {
  test("null snapshot with no previously-seen source is silent", async () => {
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false);

    await runnerView(runner).phaseFleetStaleness();

    expect(harness.alerts).toEqual([]);
    expect(harness.doctorTimeouts).toEqual([]);
    expect(harness.kickstartTimeouts).toEqual([]);
    expect(runnerView(runner).fleetStaleStreak).toBe(0);
  });

  test("null snapshot after a prior snapshot emits one source-lost alert and never kicks", async () => {
    setFleetState("fleet_snapshot_last_seen_ms", "1000");
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false);

    await runnerView(runner).phaseFleetStaleness();
    await runnerView(runner).phaseFleetStaleness();

    expect(harness.alerts).toEqual([
      {
        kind: "source-lost",
        message: "⚠️ hub-core fleet.db unreadable — previously-seen snapshot source is now missing/corrupt",
      },
    ]);
    expect(harness.doctorTimeouts).toEqual([]);
    expect(harness.kickstartTimeouts).toEqual([]);
  });

  test("an age exactly at the threshold is fresh and resets the streak", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs - 2_500, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false);
    const view = runnerView(runner);
    view.fleetStaleStreak = 2;
    view.sourceLostAlerted = true;

    await withDateNow(nowMs, () => view.phaseFleetStaleness());

    expect(harness.alerts).toEqual([]);
    expect(harness.doctorTimeouts).toEqual([]);
    expect(harness.kickstartTimeouts).toEqual([]);
    expect(view.fleetStaleStreak).toBe(0);
    expect(view.sourceLostAlerted).toBe(false);
  });

  test("uses the fallback cadence for omitted and zero pollIntervalMs without remediation", async () => {
    const nowMs = 100_000;
    for (const variant of ["omitted", "zero"] as const) {
      ownDb.exec("DELETE FROM fleet_state");
      prepareFleetDb();
      const snapshot = makeSnapshot(
        [makeEntity("hub-core", "up")],
        nowMs - 37_500,
        variant === "zero" ? 0 : 1_000,
      );
      let storedSnapshot: unknown = snapshot;
      if (variant === "omitted") {
        const withoutPollInterval: Record<string, unknown> = { ...snapshot };
        delete withoutPollInterval.pollIntervalMs;
        storedSnapshot = withoutPollInterval;
      }
      insertSnapshot(storedSnapshot);
      const runner = makeRunner();
      const harness = installStalenessStubs(runner, false);
      const view = runnerView(runner);
      view.fleetStaleStreak = 2;
      view.sourceLostAlerted = true;

      await withDateNow(nowMs, () => view.phaseFleetStaleness());

      expect(harness.alerts).toEqual([]);
      expect(harness.doctorTimeouts).toEqual([]);
      expect(harness.kickstartTimeouts).toEqual([]);
      expect(view.fleetStaleStreak).toBe(0);
      expect(view.sourceLostAlerted).toBe(false);
      expect(view.hubDeathAlerted).toBe(false);
    }
  });

  test("treats a future generatedAtMs as fresh clock skew and resets without remediation", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs + 60_000, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false);
    const view = runnerView(runner);
    view.fleetStaleStreak = 2;
    view.sourceLostAlerted = true;

    await withDateNow(nowMs, () => view.phaseFleetStaleness());

    expect(harness.alerts).toEqual([]);
    expect(harness.doctorTimeouts).toEqual([]);
    expect(harness.kickstartTimeouts).toEqual([]);
    expect(view.fleetStaleStreak).toBe(0);
    expect(view.sourceLostAlerted).toBe(false);
    expect(view.hubDeathAlerted).toBe(false);
  });

  test("stale reads one and two do not call hub_doctor", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs - 10_000, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false);
    const view = runnerView(runner);

    await withDateNow(nowMs, async () => {
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
    });

    expect(view.fleetStaleStreak).toBe(2);
    expect(harness.doctorTimeouts).toEqual([]);
    expect(harness.kickstartTimeouts).toEqual([]);
    expect(harness.alerts).toEqual([]);
  });

  test("three stale reads with a resolving doctor emit only a warning and reset", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs - 10_000, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, true);
    const view = runnerView(runner);

    await withDateNow(nowMs, async () => {
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
    });

    expect(harness.doctorTimeouts).toEqual([5_000]);
    expect(harness.kickstartTimeouts).toEqual([]);
    expect(harness.alerts).toEqual([]);
    expect(view.fleetStaleStreak).toBe(0);
  });

  test("three stale reads with a rejecting doctor kick once and suppress repeats", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs - 10_000, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false, {
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const view = runnerView(runner);

    await withDateNow(nowMs, async () => {
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
    });

    expect(harness.doctorTimeouts).toEqual([5_000]);
    expect(harness.kickstartTimeouts).toEqual([undefined]);
    expect(harness.alerts).toEqual([
      {
        kind: "confirmed-death",
        message: expect.stringContaining("launchctl kickstart -k com.dmac.hub-core"),
      },
    ]);
    expect(view.hubDeathAlerted).toBe(true);
  });

  test("a fresh snapshot after a confirmed death emits one recovery and clears the flag", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false);
    const view = runnerView(runner);
    view.hubDeathAlerted = true;

    await withDateNow(nowMs, () => view.phaseFleetStaleness());

    expect(harness.alerts).toEqual([
      { kind: "recovery", message: "✅ hub-core snapshot fresh again" },
    ]);
    expect(view.hubDeathAlerted).toBe(false);
    expect(view.fleetStaleStreak).toBe(0);
  });

  test("a bounded kickstart failure still sends the one confirmed-death alert", async () => {
    prepareFleetDb();
    const nowMs = 100_000;
    insertSnapshot(makeSnapshot([makeEntity("hub-core", "up")], nowMs - 10_000, 1_000));
    const runner = makeRunner();
    const harness = installStalenessStubs(runner, false, {
      exitCode: -1,
      stdout: "",
      stderr: "<evil>&".repeat(2_000),
    });
    const view = runnerView(runner);

    await withDateNow(nowMs, async () => {
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
      await view.phaseFleetStaleness();
    });

    expect(harness.alerts).toHaveLength(1);
    expect(harness.alerts[0]?.kind).toBe("confirmed-death");
    expect(harness.alerts[0]?.message).toContain("(exit -1)");
    expect(view.hubDeathAlerted).toBe(true);
  });

  test("bounds a hanging MCP connect and cleans up its child", async () => {
    rmSync(fakeHubEdgeMarker, { force: true });
    const runner = makeRunner();
    const startedAt = Date.now();
    const result = await runnerView(runner).confirmHubDoctor(25);
    const elapsedMs = Date.now() - startedAt;
    const pid = await waitForFile(fakeHubEdgeMarker);

    expect(result).toBe(false);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(isProcessAlive(pid)).toBe(false);
  });

  test("bounds a hanging launchctl mock, kills it, and returns a failure result", async () => {
    const runner = makeRunner();
    const originalSpawn = Bun.spawn;
    const hanging = makeHangingSubprocess();
    Bun.spawn = (() => hanging.process) as typeof Bun.spawn;
    let result: KickstartResult | null = null;
    try {
      result = await runnerView(runner).kickstartHubCore(25);
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(result).not.toBeNull();
    expect(result?.exitCode).not.toBe(0);
    expect(hanging.wasKilled()).toBe(true);
  });
});
