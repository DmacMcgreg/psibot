import { describe, expect, test } from "bun:test";
import type { Context } from "grammy";
import type { AgentService } from "../agent/index.ts";
import { HubCallOutcomeUnknownError, type HubCall } from "../agent/hub-client.ts";
import type { MemorySystem } from "../memory/index.ts";
import type { Scheduler } from "../scheduler/index.ts";
import type { ChatState } from "./state.ts";
import {
  createCallbackHandler,
  fleetProposalConfirmKeyboard,
  fleetProposalKeyboard,
  parseFleetProposalCallback,
} from "./keyboards.ts";

type FleetReply =
  | { ok: true; detail?: string }
  | { ok: false; error?: string }
  | { needsConfirm: true; token: string; ttlSec: number };

interface CallbackHarness {
  readonly ctx: Context;
  readonly answers: Array<Record<string, unknown> | undefined>;
  readonly texts: string[];
  readonly markups: unknown[];
}

function makeContext(data: string, messageId = 1): CallbackHarness {
  const answers: Array<Record<string, unknown> | undefined> = [];
  const texts: string[] = [];
  const markups: unknown[] = [];

  const ctx = {
    from: { id: 4242 },
    chat: { id: 101 },
    callbackQuery: {
      data,
      message: {
        message_id: messageId,
        chat: { id: 101 },
      },
    },
    answerCallbackQuery: async (options?: Record<string, unknown>) => {
      answers.push(options);
    },
    editMessageText: async (text: string, options?: { reply_markup?: unknown }) => {
      texts.push(text);
      if (options?.reply_markup !== undefined) markups.push(options.reply_markup);
    },
    editMessageReplyMarkup: async (options?: { reply_markup?: unknown }) => {
      markups.push(options?.reply_markup);
    },
  } as unknown as Context;

  return { ctx, answers, texts, markups };
}

function makeHandler(hubCall: HubCall) {
  return createCallbackHandler({
    agent: {} as AgentService,
    scheduler: {} as Scheduler,
    state: {} as ChatState,
    memory: {} as MemorySystem,
    runAgent: async () => {},
    runQuickResearch: async () => {},
    runDeepResearch: async () => {},
    hubCall,
  });
}

describe("E3-T08 fleet Telegram callbacks", () => {
  test("warm restart calls fleet_verb with exact args and renders success", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      return { ok: true } satisfies FleetReply;
    });
    const harness = makeContext("fr:hub-core");

    await handler(harness.ctx);

    expect(calls).toEqual([["fleet_verb", { entity: "hub-core", verb: "restart" }]]);
    expect(harness.answers).toEqual([{ text: "Restarting hub-core..." }]);
    expect(harness.texts).toEqual(["✓ Restarted hub-core"]);
  });

  test("silence failure renders the hub's already-redacted error", async () => {
    const handler = makeHandler(async () => (
      { ok: false, error: "entity unavailable" } satisfies FleetReply
    ));
    const harness = makeContext("fs:psibot");

    await handler(harness.ctx);

    expect(harness.answers).toEqual([{ text: "Silencing psibot..." }]);
    expect(harness.texts).toEqual(["✗ Silence failed: entity unavailable"]);
  });

  test("confirmation is single-use locally before the hub request settles", async () => {
    const token = "a2a1c0d2-6a7d-4dde-a54c-57f7d862f117";
    const calls: Array<[string, Record<string, unknown>]> = [];
    let releaseConfirm!: () => void;
    let markConfirmStarted!: () => void;
    const confirmStarted = new Promise<void>((resolve) => {
      markConfirmStarted = resolve;
    });
    const confirmResult = new Promise<FleetReply>((resolve) => {
      releaseConfirm = () => resolve({ ok: true });
    });
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      if (args.confirmToken === token) {
        markConfirmStarted();
        return confirmResult;
      }
      return { needsConfirm: true, token, ttlSec: 60 } satisfies FleetReply;
    });

    const initial = makeContext("fr:vaultd", 9);
    await handler(initial.ctx);
    expect(initial.markups).toHaveLength(1);
    expect((initial.markups[0] as { inline_keyboard: unknown }).inline_keyboard).toEqual([
      [
        { text: "Confirm", callback_data: `fc:${token}` },
        { text: "Cancel", callback_data: "cx" },
      ],
    ]);

    const confirmed = makeContext(`fc:${token}`, 9);
    const confirming = handler(confirmed.ctx);
    await confirmStarted;

    const replay = makeContext(`fc:${token}`, 9);
    await handler(replay.ctx);
    expect(replay.texts).toEqual(["Confirmation expired — re-trigger from the original alert."]);
    expect(calls).toEqual([
      ["fleet_verb", { entity: "vaultd", verb: "restart" }],
      ["fleet_verb", { entity: "vaultd", verb: "restart", confirmToken: token }],
    ]);

    releaseConfirm();
    await confirming;
    expect(confirmed.texts).toEqual(["✓ Restarted vaultd"]);
  });

  test("cold or unknown confirmation never calls the hub", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      return { ok: true } satisfies FleetReply;
    });
    const harness = makeContext("fc:never-issued");

    await handler(harness.ctx);

    expect(calls).toEqual([]);
    expect(harness.answers).toEqual([{ text: "Confirmation expired" }]);
    expect(harness.texts).toEqual(["Confirmation expired — re-trigger from the original alert."]);
  });

  test("a found confirmation renders a confirm-specific structured failure", async () => {
    const token = "5633cce7-0b44-4d03-9193-1a2b75a4f5d3";
    const handler = makeHandler(async (_toolName, args) => {
      if (args.confirmToken === token) {
        return { ok: false, error: "confirmation rejected" } satisfies FleetReply;
      }
      return { needsConfirm: true, token, ttlSec: 60 } satisfies FleetReply;
    });

    await handler(makeContext("fr:vaultd", 14).ctx);
    const confirmed = makeContext(`fc:${token}`, 14);
    await handler(confirmed.ctx);

    expect(confirmed.answers).toEqual([{ text: "Confirming vaultd..." }]);
    expect(confirmed.texts).toEqual(["✗ Confirm failed: confirmation rejected"]);
  });

  test("pre-dispatch hub failures remain retryable without echoing thrown details", async () => {
    const handler = makeHandler(async () => {
      throw new Error("hub timeout Authorization: Bearer should-never-reach-telegram");
    });
    const harness = makeContext("fr:hub-core");

    await handler(harness.ctx);

    expect(harness.answers).toEqual([{ text: "Restarting hub-core..." }]);
    expect(harness.texts).toEqual(["✗ Fleet action failed. Try again after hub recovery."]);
    expect(harness.texts.join("\n")).not.toContain("should-never-reach-telegram");
  });

  test("unknown mutation outcome disables retry for the same callback", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      throw new HubCallOutcomeUnknownError();
    });
    const first = makeContext("fr:hub-core", 18);
    const retry = makeContext("fr:hub-core", 18);

    await handler(first.ctx);
    await handler(retry.ctx);

    expect(calls).toEqual([["fleet_verb", { entity: "hub-core", verb: "restart" }]]);
    expect(first.texts).toEqual([
      "⚠ Fleet action outcome unknown — do not retry. Check fleet status or audit before acting again.",
    ]);
    expect(first.markups).toEqual([undefined]);
    expect(retry.answers).toEqual([{ text: "Retry disabled: outcome unknown" }]);
    expect(retry.texts).toEqual([
      "⚠ Fleet action outcome unknown — do not retry. Check fleet status or audit before acting again.",
    ]);
  });

  test("an uncertain confirmation remains single-use and rejects replay without another hub call", async () => {
    const token = "7fd1717d-d3ee-4be1-94d3-eeae79f1a990";
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      if (args.confirmToken === token) throw new HubCallOutcomeUnknownError();
      return { needsConfirm: true, token, ttlSec: 60 } satisfies FleetReply;
    });

    await handler(makeContext("fr:vaultd", 19).ctx);
    const confirmed = makeContext(`fc:${token}`, 19);
    await handler(confirmed.ctx);
    const retry = makeContext(`fc:${token}`, 19);
    await handler(retry.ctx);

    expect(calls).toEqual([
      ["fleet_verb", { entity: "vaultd", verb: "restart" }],
      ["fleet_verb", { entity: "vaultd", verb: "restart", confirmToken: token }],
    ]);
    expect(confirmed.texts).toEqual([
      "⚠ Fleet action outcome unknown — do not retry. Check fleet status or audit before acting again.",
    ]);
    expect(retry.answers).toEqual([{ text: "Retry disabled: outcome unknown" }]);
  });

  test("does not render an oversized confirm callback and invalidates it locally", async () => {
    const token = "t".repeat(62);
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      return { needsConfirm: true, token, ttlSec: 60 } satisfies FleetReply;
    });
    const firstTap = makeContext("fs:hub-core", 21);

    await handler(firstTap.ctx);
    expect(firstTap.markups).toEqual([]);
    expect(firstTap.texts).toEqual(["Confirmation token is too long — re-trigger from the original alert."]);

    const secondTap = makeContext(`fc:${token}`, 21);
    await handler(secondTap.ctx);
    expect(calls).toEqual([["fleet_verb", { entity: "hub-core", verb: "silence" }]]);
    expect(secondTap.texts).toEqual(["Confirmation expired — re-trigger from the original alert."]);
  });

  test("fleet confirmation cancel clears only its local pending action", async () => {
    const token = "c7f54eaf-6861-4211-ae26-562f7cacac87";
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (toolName, args) => {
      calls.push([toolName, args]);
      return { needsConfirm: true, token, ttlSec: 60 } satisfies FleetReply;
    });
    const initial = makeContext("fs:hub-core", 31);
    await handler(initial.ctx);

    const cancelled = makeContext("cx", 31);
    await handler(cancelled.ctx);
    expect(cancelled.texts).toEqual(["Cancelled"]);

    const confirmed = makeContext(`fc:${token}`, 31);
    await handler(confirmed.ctx);
    expect(calls).toEqual([["fleet_verb", { entity: "hub-core", verb: "silence" }]]);
    expect(confirmed.texts).toEqual(["Confirmation expired — re-trigger from the original alert."]);
  });
});

describe("E8-T14 fleet proposal callbacks", () => {
  const proposalId = "p".repeat(22);
  const token = "a2a1c0d2-6a7d-4dde-a54c-57f7d862f117";

  test("builds byte-bounded callbacks and parses fp by its last colon without colliding with fc", () => {
    expect(fleetProposalKeyboard(proposalId).inline_keyboard).toEqual([[
      { text: "Approve", callback_data: `fp:${proposalId}:a` },
      { text: "Reject", callback_data: `fp:${proposalId}:r` },
    ]]);
    const confirmData = `fpc:${proposalId}:${token}`;
    expect(new TextEncoder().encode(confirmData).byteLength).toBe(63);
    expect(fleetProposalConfirmKeyboard(proposalId, token).inline_keyboard).toEqual([[
      { text: "Confirm", callback_data: confirmData },
      { text: "Cancel", callback_data: `fpx:${proposalId}` },
    ]]);
    expect(parseFleetProposalCallback(`fp:${proposalId}:a`)).toEqual({
      kind: "decision",
      proposalId,
      decision: "approve",
    });
    expect(parseFleetProposalCallback(`fp:${proposalId}:r`)).toEqual({
      kind: "decision",
      proposalId,
      decision: "reject",
    });
    expect(parseFleetProposalCallback(`fc:${token}`)).toBeNull();
    expect(parseFleetProposalCallback(`fpx:${proposalId}`)).toEqual({ kind: "cancel", proposalId });
  });

  test("threads the authenticated Telegram principal through the exact approve envelope", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (name, args) => {
      calls.push([name, args]);
      return { ok: true, status: "executed", detail: `done <"safely"> & 'verified'` };
    });
    const harness = makeContext(`fp:${proposalId}:a`, 40);

    await handler(harness.ctx);

    expect(calls).toEqual([["fleet_propose_decide", {
      proposalId,
      decision: "approve",
      principal: { projectId: "telegram:4242" },
    }]]);
    expect(harness.texts).toEqual([
      `✓ Proposal <code>${proposalId}</code> is <b>executed</b> — done &lt;&quot;safely&quot;&gt; &amp; &#39;verified&#39;`,
    ]);
    expect(harness.markups).toEqual([undefined]);
  });

  test("binds proposal and token on confirmation re-entry", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const handler = makeHandler(async (name, args) => {
      calls.push([name, args]);
      if (args.confirmToken === token) return { ok: true, status: "executed" };
      return { needsConfirm: true, token, ttlSec: 60, proposalId };
    });
    const initial = makeContext(`fp:${proposalId}:a`, 41);
    await handler(initial.ctx);
    expect((initial.markups[0] as { inline_keyboard: unknown }).inline_keyboard).toEqual([[
      { text: "Confirm", callback_data: `fpc:${proposalId}:${token}` },
      { text: "Cancel", callback_data: `fpx:${proposalId}` },
    ]]);

    await handler(makeContext(`fpc:${proposalId}:${token}`, 41).ctx);
    expect(calls).toEqual([
      ["fleet_propose_decide", { proposalId, decision: "approve", principal: { projectId: "telegram:4242" } }],
      ["fleet_propose_decide", {
        proposalId,
        decision: "approve",
        principal: { projectId: "telegram:4242" },
        confirmToken: token,
      }],
    ]);
  });

  test("keeps outcome-unknown proposal decisions non-retryable", async () => {
    const calls: unknown[] = [];
    const handler = makeHandler(async (...args) => {
      calls.push(args);
      throw new HubCallOutcomeUnknownError();
    });
    const first = makeContext(`fp:${proposalId}:r`, 42);
    const retry = makeContext(`fp:${proposalId}:r`, 42);
    await handler(first.ctx);
    await handler(retry.ctx);
    expect(calls).toHaveLength(1);
    expect(retry.answers).toEqual([{ text: "Retry disabled: outcome unknown" }]);
  });

  test("keeps initial controls on a recoverable decision failure", async () => {
    const handler = makeHandler(async () => {
      throw new Error("hub unavailable before dispatch");
    });
    const harness = makeContext(`fp:${proposalId}:a`, 43);
    await handler(harness.ctx);

    expect(harness.texts).toEqual(["✗ Proposal decision failed. Try again after hub recovery."]);
    expect((harness.markups[0] as { inline_keyboard: unknown }).inline_keyboard).toEqual([[
      { text: "Approve", callback_data: `fp:${proposalId}:a` },
      { text: "Reject", callback_data: `fp:${proposalId}:r` },
    ]]);
  });

  test("keeps initial controls on a structured proposal failure", async () => {
    const handler = makeHandler(async () => ({
      ok: false,
      error: `still <pending> & "retry" 'later'`,
    }));
    const harness = makeContext(`fp:${proposalId}:r`, 45);
    await handler(harness.ctx);

    expect(harness.texts).toEqual([
      "✗ Proposal failed: still &lt;pending&gt; &amp; &quot;retry&quot; &#39;later&#39;",
    ]);
    expect((harness.markups[0] as { inline_keyboard: unknown }).inline_keyboard).toEqual([[
      { text: "Approve", callback_data: `fp:${proposalId}:a` },
      { text: "Reject", callback_data: `fp:${proposalId}:r` },
    ]]);
  });

  test("proposal-bound cancel edits terminal state and never calls the hub", async () => {
    const calls: unknown[] = [];
    const handler = makeHandler(async (...args) => {
      calls.push(args);
      return { ok: true, status: "executed" };
    });
    const harness = makeContext(`fpx:${proposalId}`, 44);
    await handler(harness.ctx);

    expect(calls).toEqual([]);
    expect(harness.answers).toEqual([{ text: "Cancelled" }]);
    expect(harness.texts).toEqual([`Cancelled proposal <code>${proposalId}</code>.`]);
    expect(harness.markups).toEqual([undefined]);
  });
});
