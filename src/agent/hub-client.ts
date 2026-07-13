import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getHubMcpServer } from "./hub-mcp.ts";

interface TextContent {
  readonly type: string;
  readonly text?: string;
}

interface ProcessControl {
  isAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

interface HubCallOptions {
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly terminateGraceMs?: number;
  readonly reapTimeoutMs?: number;
  readonly processControl?: ProcessControl;
}

/** A short-lived deterministic call made outside an LLM tool-use turn. */
export type HubCall = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ProposalPrincipal {
  readonly projectId: string;
}

export interface DecideProposalArgs {
  readonly proposalId: string;
  readonly decision: "approve" | "reject";
  readonly principal: ProposalPrincipal;
  readonly confirmToken?: string;
}

export type DecideProposalReply =
  | { readonly ok: true; readonly status: "pending" | "approved" | "rejected" | "executed" | "expired"; readonly detail?: string }
  | { readonly ok: false; readonly error: string }
  | { readonly needsConfirm: true; readonly token: string; readonly ttlSec: number; readonly proposalId: string };

const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9_-]{12,22}$/;
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/**
 * The request reached tools/call, but no trustworthy mutation result came back.
 * Callers must not retry automatically because fleet_verb may have committed.
 */
export class HubCallOutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;
  readonly retryable = false;

  constructor() {
    super("fleet mutation outcome unknown; retry disabled");
    this.name = "HubCallOutcomeUnknownError";
  }
}

export function isHubCallOutcomeUnknown(error: unknown): error is HubCallOutcomeUnknownError {
  return error instanceof HubCallOutcomeUnknownError || (
    typeof error === "object" && error !== null &&
    (error as { outcomeUnknown?: unknown }).outcomeUnknown === true &&
    (error as { retryable?: unknown }).retryable === false
  );
}

const HUB_CONNECT_TIMEOUT_MS = 3_000;
const HUB_CALL_TIMEOUT_MS = 3_000;
const HUB_CLIENT_CLOSE_GRACE_MS = 1_000;
const HUB_PROCESS_TERMINATE_GRACE_MS = 500;
const HUB_PROCESS_REAP_TIMEOUT_MS = 1_000;
const HUB_ENV_ALLOWLIST = new Set(["HUB_CORE_SOCKET"]);
const HUB_ENV_VALUE_MAX_LENGTH = 4_096;

const defaultProcessControl: ProcessControl = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
    });
  },
};

function validatedHubEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined;

  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!HUB_ENV_ALLOWLIST.has(key)) {
      throw new Error(`hub-edge env key is not allowlisted: ${key}`);
    }
    if (typeof value !== "string" || value.length === 0 ||
      value.length > HUB_ENV_VALUE_MAX_LENGTH || value.includes("\0")) {
      throw new Error(`hub-edge env value is invalid: ${key}`);
    }
    allowed[key] = value;
  }
  return Object.keys(allowed).length === 0 ? undefined : allowed;
}

function deadline(timeoutMs: number, operation: string): {
  readonly controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${operation} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return { controller, dispose: () => clearTimeout(timer) };
}

function killIfAlive(
  pid: number,
  signal: NodeJS.Signals,
  processControl: ProcessControl,
): void {
  if (!processControl.isAlive(pid)) return;
  try {
    processControl.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(
  pid: number,
  timeoutMs: number,
  processControl: ProcessControl,
): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (processControl.isAlive(pid) && Date.now() < deadlineAt) {
    await processControl.sleep(Math.min(25, Math.max(1, deadlineAt - Date.now())));
  }
  return !processControl.isAlive(pid);
}

async function closeKillAndReap(
  client: Client,
  transport: StdioClientTransport,
  processControl: ProcessControl,
  closeGraceMs: number,
  terminateGraceMs: number,
  reapTimeoutMs: number,
): Promise<void> {
  const pid = transport.pid;
  let closeFailed = false;
  const closePromise = client.close().catch(() => {
    closeFailed = true;
  });

  await Promise.race([closePromise, processControl.sleep(closeGraceMs)]);
  if (pid === null) {
    if (closeFailed) throw new Error("hub-edge client cleanup failed");
    return;
  }

  if (processControl.isAlive(pid)) {
    killIfAlive(pid, "SIGTERM", processControl);
    await waitForExit(pid, terminateGraceMs, processControl);
  }
  if (processControl.isAlive(pid)) {
    killIfAlive(pid, "SIGKILL", processControl);
  }
  if (!await waitForExit(pid, reapTimeoutMs, processControl)) {
    throw new Error("hub-edge process was not reaped");
  }
}

/**
 * Build the one-shot hub caller. Options are a narrow timing/process seam for
 * deterministic cleanup tests; production uses the defaults below.
 */
export function createHubCall(options: HubCallOptions = {}): HubCall {
  const connectTimeoutMs = options.connectTimeoutMs ?? HUB_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? HUB_CALL_TIMEOUT_MS;
  const closeGraceMs = options.closeGraceMs ?? HUB_CLIENT_CLOSE_GRACE_MS;
  const terminateGraceMs = options.terminateGraceMs ?? HUB_PROCESS_TERMINATE_GRACE_MS;
  const reapTimeoutMs = options.reapTimeoutMs ?? HUB_PROCESS_REAP_TIMEOUT_MS;
  const processControl = options.processControl ?? defaultProcessControl;

  return async (toolName, args) => {
    const cfg = getHubMcpServer().hub;
    if (!cfg) throw new Error("hub MCP server not configured/enabled (HUB_MCP_ENABLED)");

    const env = validatedHubEnv(cfg.env);
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      ...(env === undefined ? {} : { env }),
    });
    const client = new Client(
      { name: "psibot-fleet-callback", version: "1.0.0" },
      { capabilities: {} },
    );

    let dispatched = false;
    let result: unknown;
    let failure: Error | undefined;

    try {
      const connectDeadline = deadline(connectTimeoutMs, "hub connect");
      try {
        await client.connect(transport, {
          signal: connectDeadline.controller.signal,
          timeout: connectTimeoutMs,
          maxTotalTimeout: connectTimeoutMs,
        });
      } finally {
        connectDeadline.dispose();
      }

      const callDeadline = deadline(callTimeoutMs, "hub call");
      try {
        // The SDK binds this AbortSignal to the JSON-RPC request ID and emits
        // notifications/cancelled before rejecting an aborted tools/call.
        dispatched = true;
        const response = await client.callTool(
          { name: "hub_call", arguments: { name: toolName, args } },
          undefined,
          {
            signal: callDeadline.controller.signal,
            timeout: callTimeoutMs,
            maxTotalTimeout: callTimeoutMs,
          },
        );
        const text = (response.content as TextContent[])
          .find((part) => part.type === "text")?.text;
        result = text === undefined ? response : JSON.parse(text) as unknown;
      } catch {
        if (!callDeadline.controller.signal.aborted) {
          callDeadline.controller.abort(new Error("hub call cancelled after dispatch failure"));
        }
        failure = new HubCallOutcomeUnknownError();
      } finally {
        callDeadline.dispose();
      }
    } catch {
      failure = dispatched
        ? new HubCallOutcomeUnknownError()
        : new Error("hub connection failed before dispatch");
    } finally {
      try {
        await closeKillAndReap(
          client,
          transport,
          processControl,
          closeGraceMs,
          terminateGraceMs,
          reapTimeoutMs,
        );
      } catch {
        failure = dispatched
          ? new HubCallOutcomeUnknownError()
          : new Error("hub process cleanup failed before dispatch");
      }
    }

    if (failure) throw failure;
    return result;
  };
}

/**
 * Invoke one hub tool through a fresh hub-edge stdio session.
 *
 * fleet_verb is COLD, so the call must go through the always-visible hub_call
 * meta-tool. The Edge's --client other invocation establishes the immutable
 * dispatch principal. Proposal decisions additionally carry the authenticated
 * Telegram actor as an authorization input; it never replaces dispatch auth.
 */
export const hubCall: HubCall = createHubCall();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isCallbackSafeConfirmation(proposalId: string, token: string): boolean {
  return PROPOSAL_ID_PATTERN.test(proposalId) && token.length > 0 &&
    new TextEncoder().encode(`fpc:${proposalId}:${token}`).byteLength <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

/** Typed proposal-decision call over the existing one-shot hub_call seam. */
export async function decideProposal(
  args: DecideProposalArgs,
  callHub: HubCall = hubCall,
): Promise<DecideProposalReply> {
  const reply = await callHub("fleet_propose_decide", { ...args });
  if (!isRecord(reply)) throw new Error("unexpected fleet proposal decision result");

  if (
    hasExactKeys(reply, ["ok", "error"]) &&
    reply.ok === false && typeof reply.error === "string"
  ) {
    return { ok: false, error: reply.error };
  }
  const validStatuses = new Set(["pending", "approved", "rejected", "executed", "expired"]);
  if (
    hasExactKeys(reply, ["ok", "status"], ["detail"]) &&
    reply.ok === true && typeof reply.status === "string" && validStatuses.has(reply.status) &&
    (reply.detail === undefined || typeof reply.detail === "string")
  ) {
    return {
      ok: true,
      status: reply.status as Extract<DecideProposalReply, { ok: true }>["status"],
      ...(typeof reply.detail === "string" ? { detail: reply.detail } : {}),
    };
  }
  if (
    hasExactKeys(reply, ["needsConfirm", "token", "ttlSec", "proposalId"]) &&
    reply.needsConfirm === true &&
    typeof reply.token === "string" &&
    reply.ttlSec === 60 &&
    typeof reply.proposalId === "string" &&
    reply.proposalId === args.proposalId &&
    isCallbackSafeConfirmation(reply.proposalId, reply.token)
  ) {
    return {
      needsConfirm: true,
      token: reply.token,
      ttlSec: reply.ttlSec,
      proposalId: reply.proposalId,
    };
  }
  throw new Error("unexpected fleet proposal decision result");
}
