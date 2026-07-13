import { beforeEach, describe, expect, mock, test } from "bun:test";

interface RequestOptions {
  readonly signal?: AbortSignal;
}

interface FakeClientState {
  clientInfo: unknown;
  transport?: FakeTransport;
  connectOptions?: RequestOptions;
  callOptions?: RequestOptions;
  calls: unknown[];
  closes: number;
  result: unknown;
  connectError?: Error;
  hangMutation: boolean;
  cancellationObserved: boolean;
  lateMutationExecuted: boolean;
  stubbornProcess: boolean;
}

let server: Record<string, unknown> = {};
let transportOptions: Array<Record<string, unknown>> = [];
let clientState: FakeClientState;
let processAlive = false;
let killSignals: NodeJS.Signals[] = [];

class FakeTransport {
  readonly pid = 41008;

  constructor(options: Record<string, unknown>) {
    transportOptions.push(options);
  }
}

class FakeClient {
  constructor(info: unknown, capabilities: unknown) {
    clientState.clientInfo = { info, capabilities };
  }

  async connect(transport: FakeTransport, options?: RequestOptions): Promise<void> {
    clientState.transport = transport;
    clientState.connectOptions = options;
    processAlive = true;
    if (clientState.connectError) throw clientState.connectError;
  }

  async callTool(call: unknown, _schema?: unknown, options?: RequestOptions): Promise<unknown> {
    clientState.calls.push(call);
    clientState.callOptions = options;
    if (!clientState.hangMutation) return clientState.result;

    return await new Promise<never>((_resolve, reject) => {
      const lateExecution = setTimeout(() => {
        clientState.lateMutationExecuted = true;
      }, 40);
      options?.signal?.addEventListener("abort", () => {
        clientState.cancellationObserved = true;
        clearTimeout(lateExecution);
        reject(options.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    });
  }

  async close(): Promise<void> {
    clientState.closes++;
    if (!clientState.stubbornProcess) processAlive = false;
  }
}

mock.module("./hub-mcp.ts", () => ({
  getHubMcpServer: () => server,
}));
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: FakeTransport,
}));
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: FakeClient,
}));

const {
  createHubCall,
  decideProposal,
  HubCallOutcomeUnknownError,
  hubCall,
} = await import("./hub-client.ts");

const fastHubCall = createHubCall({
  connectTimeoutMs: 10,
  callTimeoutMs: 10,
  closeGraceMs: 2,
  terminateGraceMs: 2,
  reapTimeoutMs: 10,
  processControl: {
    isAlive: () => processAlive,
    kill: (_pid, signal) => {
      killSignals.push(signal);
      processAlive = false;
    },
    sleep: async () => {
      await Bun.sleep(1);
    },
  },
});

beforeEach(() => {
  server = {
    hub: {
      type: "stdio",
      command: "/tmp/fake-hub-edge",
      args: ["--client", "other"],
      env: { HUB_CORE_SOCKET: "/tmp/test-hub-core.sock" },
    },
  };
  transportOptions = [];
  processAlive = false;
  killSignals = [];
  clientState = {
    clientInfo: undefined,
    calls: [],
    closes: 0,
    result: { content: [{ type: "text", text: JSON.stringify({ ok: true, detail: "done" }) }] },
    hangMutation: false,
    cancellationObserved: false,
    lateMutationExecuted: false,
    stubbornProcess: false,
  };
});

describe("E3-T08 deterministic hub client", () => {
  test("decideProposal sends the exact typed fleet_propose_decide envelope", async () => {
    const calls: unknown[] = [];
    const args = {
      proposalId: "proposal0001",
      decision: "approve" as const,
      principal: { projectId: "telegram:4242" },
      confirmToken: "confirm-token",
    };
    await expect(decideProposal(args, async (name, receivedArgs) => {
      calls.push([name, receivedArgs]);
      return { ok: true, status: "executed", detail: "done" };
    })).resolves.toEqual({ ok: true, status: "executed", detail: "done" });
    expect(calls).toEqual([["fleet_propose_decide", args]]);
  });

  test("decideProposal rejects contradictory, extra, or callback-unsafe response envelopes", async () => {
    const proposalId = "proposal0001";
    const token = "a2a1c0d2-6a7d-4dde-a54c-57f7d862f117";
    const invalidReplies: unknown[] = [
      { ok: true, status: "executed", extra: true },
      { ok: true, status: "executed", error: "contradiction" },
      { ok: false, error: "failed", status: "pending" },
      { needsConfirm: true, token, ttlSec: 59, proposalId },
      { needsConfirm: true, token: "", ttlSec: 60, proposalId },
      { needsConfirm: true, token: "t".repeat(64), ttlSec: 60, proposalId },
      { needsConfirm: true, token, ttlSec: 60, proposalId: "short" },
      { needsConfirm: true, token, ttlSec: 60, proposalId: "wrongproposal" },
      { needsConfirm: true, token, ttlSec: 60, proposalId, ok: false, error: "contradiction" },
    ];

    for (const reply of invalidReplies) {
      await expect(decideProposal({
        proposalId,
        decision: "approve",
        principal: { projectId: "telegram:4242" },
      }, async () => reply)).rejects.toThrow("unexpected fleet proposal decision result");
    }
  });

  test("uses one short-lived hub_call envelope with the exact fleet_verb args", async () => {
    const args = { entity: "hub-core", verb: "restart", args: { source: "telegram" } };

    await expect(hubCall("fleet_verb", args)).resolves.toEqual({ ok: true, detail: "done" });

    expect(transportOptions).toHaveLength(1);
    expect(transportOptions[0]).toEqual({
      command: "/tmp/fake-hub-edge",
      args: ["--client", "other"],
      env: { HUB_CORE_SOCKET: "/tmp/test-hub-core.sock" },
    });
    expect(clientState.clientInfo).toEqual({
      info: { name: "psibot-fleet-callback", version: "1.0.0" },
      capabilities: { capabilities: {} },
    });
    expect(clientState.calls).toEqual([
      { name: "hub_call", arguments: { name: "fleet_verb", args } },
    ]);
    expect(clientState.callOptions?.signal).toBeInstanceOf(AbortSignal);
    expect(clientState.closes).toBe(1);
    expect(processAlive).toBe(false);
  });

  test("never forwards process secrets and uses SDK restricted defaults when no override is needed", async () => {
    const previousTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const previousArbitrarySecret = process.env.ARBITRARY_TEST_SECRET;
    process.env.TELEGRAM_BOT_TOKEN = "telegram-secret";
    process.env.ARBITRARY_TEST_SECRET = "arbitrary-secret";
    server = {
      hub: {
        type: "stdio",
        command: "/tmp/fake-hub-edge",
        args: ["--client", "other"],
      },
    };

    try {
      await fastHubCall("fleet_verb", { entity: "hub-core", verb: "restart" });
    } finally {
      if (previousTelegramToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousTelegramToken;
      if (previousArbitrarySecret === undefined) delete process.env.ARBITRARY_TEST_SECRET;
      else process.env.ARBITRARY_TEST_SECRET = previousArbitrarySecret;
    }

    expect(transportOptions).toEqual([{
      command: "/tmp/fake-hub-edge",
      args: ["--client", "other"],
    }]);
  });

  test("rejects non-allowlisted cfg.env keys before spawning hub-edge", async () => {
    server = {
      hub: {
        type: "stdio",
        command: "/tmp/fake-hub-edge",
        args: ["--client", "other"],
        env: {
          HUB_CORE_SOCKET: "/tmp/test-hub-core.sock",
          TELEGRAM_BOT_TOKEN: "must-not-forward",
        },
      },
    };

    await expect(fastHubCall("fleet_verb", { entity: "hub-core", verb: "restart" }))
      .rejects.toThrow("hub-edge env key is not allowlisted");
    expect(transportOptions).toEqual([]);
    expect(clientState.calls).toEqual([]);
  });

  test("fails before spawning when hub-edge is not configured", async () => {
    server = {};

    await expect(fastHubCall("fleet_verb", { entity: "hub-core", verb: "restart" }))
      .rejects.toThrow("hub MCP server not configured/enabled (HUB_MCP_ENABLED)");
    expect(transportOptions).toEqual([]);
    expect(clientState.calls).toEqual([]);
  });

  test("cleans up and reaps a one-shot process when connect fails before dispatch", async () => {
    clientState.connectError = new Error("connect failed with secret detail");

    await expect(fastHubCall("fleet_verb", { entity: "hub-core", verb: "restart" }))
      .rejects.toThrow("hub connection failed before dispatch");

    expect(clientState.calls).toEqual([]);
    expect(clientState.closes).toBe(1);
    expect(processAlive).toBe(false);
  });

  test("aborts a timed mutation, prevents late execution, and kills and reaps its process", async () => {
    clientState.hangMutation = true;
    clientState.stubbornProcess = true;

    const error = await fastHubCall("fleet_verb", { entity: "hub-core", verb: "restart" })
      .catch((caught: unknown) => caught);
    await Bun.sleep(60);

    expect(error).toBeInstanceOf(HubCallOutcomeUnknownError);
    expect(error).toMatchObject({ retryable: false, outcomeUnknown: true });
    expect(clientState.callOptions?.signal?.aborted).toBe(true);
    expect(clientState.cancellationObserved).toBe(true);
    expect(clientState.lateMutationExecuted).toBe(false);
    expect(clientState.closes).toBe(1);
    expect(killSignals).toContain("SIGTERM");
    expect(processAlive).toBe(false);
  });
});
