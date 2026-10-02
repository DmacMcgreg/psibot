import { InlineKeyboard, type Context } from "grammy";
import { getConfig } from "../config.ts";
import type { AgentService } from "../agent/index.ts";
import type { Scheduler } from "../scheduler/index.ts";
import type { ChatState } from "./state.ts";
import {
  resolveSessionByPrefix,
  getAllJobs,
  getJob,
  updateJob,
  deleteJob,
  getSessionPreview,
  getMessagesBySession,
  getReminder,
  completeReminder,
  dismissReminder,
  snoozeReminder,
  getJobRun,
  getJobConfigHistory,
  recordSentMessage,
} from "../db/queries.ts";
import type { Job } from "../shared/types.ts";
import { escapeMarkdownV2 } from "./format.ts";
import { createLogger } from "../shared/logger.ts";
import {
  decideProposal,
  hubCall,
  isHubCallOutcomeUnknown,
  type DecideProposalArgs,
  type DecideProposalReply,
  type HubCall,
} from "../agent/hub-client.ts";
import type { AutonomyLevelChange } from "../heartbeat/autonomy.ts";
import type { MemorySystem } from "../memory/index.ts";
import { getPendingItemById } from "../db/queries.ts";
import { applyItemAction } from "../triage/actions.ts";
import { setExportApproved, resolveExportNudgeId, markExportDeclined, clearExportNudge } from "../skills/usage.ts";

const log = createLogger("telegram:keyboards");

const MD2 = { parse_mode: "MarkdownV2" as const };
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const FLEET_PROPOSAL_ID_PATTERN = /^[A-Za-z0-9_-]{12,22}$/;

type FleetReply =
  | { ok: true; detail?: string }
  | { ok: false; error?: string }
  | { needsConfirm: true; token: string; ttlSec: number };

const pendingFleetConfirms = new Map<string, { entity: string; verb: string }>();
const pendingFleetConfirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingFleetConfirmMessages = new Map<string, string>();

interface FleetCallbackState {
  readonly inFlight: Set<string>;
  readonly outcomeUnknown: Set<string>;
}

/** Session key incorporating topic thread ID for isolated sessions per group topic. */
function sessionKey(ctx: Context): string {
  const chatId = String(ctx.chat?.id ?? "");
  const threadId = ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id;
  return threadId ? `${chatId}:${threadId}` : chatId;
}

// --- Keyboard Builders ---

/** Keyboard shown on the "Thinking..." message while a run is in progress. */
export function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Cancel", "cn");
}

export function modelPickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Opus", "md:opus")
    .text("Sonnet", "md:sonnet")
    .text("Haiku", "md:haiku")
    .row()
    .text("Cancel", "cx");
}

export function sessionListKeyboard(
  sessions: { session_id: string; label: string | null }[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const s of sessions) {
    const sid = s.session_id.slice(0, 8);
    kb.text(`Resume ${sid}`, `sr:${sid}`)
      .text(`Fork ${sid}`, `sf:${sid}`)
      .row();
  }
  return kb;
}

export function jobListKeyboard(
  jobs: { id: number; name: string; status: string; paused_until: string | null }[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const j of jobs) {
    const isPaused = j.paused_until && new Date(j.paused_until.endsWith("Z") ? j.paused_until : j.paused_until + "Z") > new Date();
    const toggleLabel = j.status === "enabled" ? "Disable" : "Enable";
    kb.text("Run", `jr:${j.id}`)
      .text(isPaused ? "Unpause" : "Pause", `jp:${j.id}`)
      .text(toggleLabel, `je:${j.id}`)
      .text("Del", `jd:${j.id}`)
      .row();
  }
  return kb;
}

export function confirmDeleteKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Yes, delete", `jy:${jobId}`)
    .text("Cancel", "cx");
}

/**
 * Reminder action keyboard — collapsed by default into a single button.
 * Tapping it expands to reveal PAID/SKIP, snooze intervals, and MORE.
 * Mirrors the brief keyboard (bfx) expand/collapse convention so stacked
 * reminders don't fill the chat with two rows of green buttons each.
 */
export function briefingActionKeyboard(reminderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("▾ Options", `bx:${reminderId}`);
}

/**
 * Expanded reminder keyboard — full action set + collapse toggle.
 * The collapse button reuses the same `bx:<id>` callback as expand.
 */
export function briefingActionKeyboardExpanded(reminderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("PAID", `bp:${reminderId}`)
    .text("SKIP", `bs:${reminderId}`)
    .row()
    .text("1h", `bz:${reminderId}:1`)
    .text("4h", `bz:${reminderId}:4`)
    .text("24h", `bz:${reminderId}:24`)
    .row()
    .text("MORE", `bm:${reminderId}`)
    .row()
    .text("▴ Collapse", `bx:${reminderId}`);
}

/**
 * Morning Brief keyboard — collapsed by default into a single button.
 * Tapping it expands to reveal all section drill-down buttons.
 */
export function briefKeyboard(jobRunId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("▾ Brief actions", `bfx:${jobRunId}`);
}

/**
 * Expanded brief keyboard — all section buttons + collapse.
 */
export function briefKeyboardExpanded(jobRunId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("Markets", `bf:${jobRunId}:markets`)
    .text("Calendar", `bf:${jobRunId}:calendar`)
    .text("Inbox", `bf:${jobRunId}:inbox`)
    .row()
    .text("Email", `bf:${jobRunId}:email`)
    .text("Tasks", `bf:${jobRunId}:tasks`)
    .text("Actions", `bf:${jobRunId}:actions`)
    .row()
    .text("Reply", `bfr:${jobRunId}`)
    .row()
    .text("▴ Collapse", `bfx:${jobRunId}`);
}

/**
 * Job actions keyboard — attached (collapsed) to every non-brief job
 * notification so any job result can be configured in place: pause, skip,
 * silence, or inspect its config history. Mirrors the brief keyboard's
 * collapse pattern. Actions taken here are audited in job_config_history
 * with changed_by='user'.
 */
export function jobActionsKeyboard(jobId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("▾ Job actions", `jax:${jobId}`);
}

function isJobPaused(job: Job): boolean {
  if (!job.paused_until) return false;
  const until = new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z");
  return until > new Date();
}

export function jobActionsKeyboardExpanded(job: Job): InlineKeyboard {
  return new InlineKeyboard()
    .text(isJobPaused(job) ? "Resume" : "Pause 24h", `jnp:${job.id}`)
    .text("Skip next", `jns:${job.id}`)
    .row()
    .text(job.notify_policy === "silent" ? "Unsilence" : "Silence", `jnq:${job.id}`)
    .text("History", `jnh:${job.id}`)
    .text("Run now", `jr:${job.id}`)
    .row()
    .text("▴ Collapse", `jax:${job.id}`);
}

function callbackByteLength(data: string): number {
  return new TextEncoder().encode(data).byteLength;
}

function checkedProposalCallback(data: string): string {
  if (callbackByteLength(data) > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new RangeError("fleet proposal callback data exceeds Telegram's 64-byte limit");
  }
  return data;
}

export function fleetProposalKeyboard(proposalId: string): InlineKeyboard {
  if (!FLEET_PROPOSAL_ID_PATTERN.test(proposalId)) {
    throw new Error("invalid fleet proposal id");
  }
  return new InlineKeyboard()
    .text("Approve", checkedProposalCallback(`fp:${proposalId}:a`))
    .text("Reject", checkedProposalCallback(`fp:${proposalId}:r`));
}

export function fleetProposalConfirmKeyboard(proposalId: string, token: string): InlineKeyboard {
  if (!FLEET_PROPOSAL_ID_PATTERN.test(proposalId) || token.length === 0) {
    throw new Error("invalid fleet proposal confirmation");
  }
  return new InlineKeyboard()
    .text("Confirm", checkedProposalCallback(`fpc:${proposalId}:${token}`))
    .text("Cancel", checkedProposalCallback(`fpx:${proposalId}`));
}

// --- Callback Data Parser ---

interface CallbackAction {
  action: string;
  payload: string;
}

export function parseCallback(data: string): CallbackAction {
  const idx = data.indexOf(":");
  if (idx === -1) return { action: data, payload: "" };
  return { action: data.slice(0, idx), payload: data.slice(idx + 1) };
}

export type FleetProposalCallback =
  | { readonly kind: "decision"; readonly proposalId: string; readonly decision: "approve" | "reject" }
  | { readonly kind: "confirm"; readonly proposalId: string; readonly token: string }
  | { readonly kind: "cancel"; readonly proposalId: string };

/** Parse proposal callbacks without colliding with the older `fc:<token>` path. */
export function parseFleetProposalCallback(data: string): FleetProposalCallback | null {
  if (callbackByteLength(data) > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;

  if (data.startsWith("fp:")) {
    const decisionSeparator = data.lastIndexOf(":");
    if (decisionSeparator <= 3) return null;
    const proposalId = data.slice(3, decisionSeparator);
    const suffix = data.slice(decisionSeparator + 1);
    if (!FLEET_PROPOSAL_ID_PATTERN.test(proposalId)) return null;
    if (suffix === "a") return { kind: "decision", proposalId, decision: "approve" };
    if (suffix === "r") return { kind: "decision", proposalId, decision: "reject" };
    return null;
  }

  if (data.startsWith("fpc:")) {
    const tokenSeparator = data.indexOf(":", 4);
    if (tokenSeparator <= 4) return null;
    const proposalId = data.slice(4, tokenSeparator);
    const token = data.slice(tokenSeparator + 1);
    if (!FLEET_PROPOSAL_ID_PATTERN.test(proposalId) || token.length === 0) return null;
    return { kind: "confirm", proposalId, token };
  }

  if (data.startsWith("fpx:")) {
    const proposalId = data.slice(4);
    return FLEET_PROPOSAL_ID_PATTERN.test(proposalId)
      ? { kind: "cancel", proposalId }
      : null;
  }

  return null;
}

// --- Callback Handler ---

function getModelAliases(): Record<string, string> {
  const cfg = getConfig();
  const glm = cfg.DEFAULT_BACKEND === "glm";
  return {
    opus: glm ? cfg.GLM_OPUS_MODEL : "claude-opus-4-6",
    sonnet: glm ? cfg.GLM_SONNET_MODEL : "claude-sonnet-4-5-20250929",
    haiku: glm ? cfg.GLM_HAIKU_MODEL : "claude-haiku-4-5-20251001",
  };
}

interface CallbackDeps {
  agent: AgentService;
  scheduler: Scheduler;
  state: ChatState;
  memory: MemorySystem;
  runAgent: (ctx: Context, prompt: string) => Promise<void>;
  runQuickResearch: (ctx: Context, itemId: number) => Promise<void>;
  runDeepResearch: (ctx: Context, itemId: number) => Promise<void>;
  /** Test seam; production uses the deterministic short-lived hub client. */
  hubCall?: HubCall;
  digestChatId?: string;
  digestTopicId?: number;
}

function callbackMessageKey(ctx: Context): string | undefined {
  const messageId = ctx.callbackQuery?.message?.message_id;
  const chatId = ctx.chat?.id;
  return messageId === undefined || chatId === undefined ? undefined : `${chatId}:${messageId}`;
}

function fleetCallbackKey(ctx: Context, action: string, payload: string): string {
  return `${callbackMessageKey(ctx) ?? `chat:${ctx.chat?.id ?? "unknown"}`}:${action}:${payload}`;
}

const FLEET_OUTCOME_UNKNOWN_TEXT =
  "⚠ Fleet action outcome unknown — do not retry. Check fleet status or audit before acting again.";

async function renderFleetOutcomeUnknown(ctx: Context): Promise<void> {
  await ctx.editMessageText(FLEET_OUTCOME_UNKNOWN_TEXT).catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
}

function clearPendingFleetConfirm(token: string): void {
  pendingFleetConfirms.delete(token);
  const timeout = pendingFleetConfirmTimers.get(token);
  if (timeout !== undefined) clearTimeout(timeout);
  pendingFleetConfirmTimers.delete(token);
  for (const [messageKey, pendingToken] of pendingFleetConfirmMessages) {
    if (pendingToken === token) pendingFleetConfirmMessages.delete(messageKey);
  }
}

function rememberPendingFleetConfirm(
  ctx: Context,
  token: string,
  pending: { entity: string; verb: string },
  ttlSec: number,
): void {
  clearPendingFleetConfirm(token);
  pendingFleetConfirms.set(token, pending);
  const timeout = setTimeout(() => clearPendingFleetConfirm(token), Math.max(0, ttlSec) * 1_000);
  pendingFleetConfirmTimers.set(token, timeout);
  if (typeof timeout === "object" && timeout !== null && "unref" in timeout) {
    (timeout as { unref(): void }).unref();
  }
  const messageKey = callbackMessageKey(ctx);
  if (messageKey !== undefined) pendingFleetConfirmMessages.set(messageKey, token);
}

function isFleetOutcome(reply: unknown): reply is Extract<FleetReply, { ok: boolean }> {
  return typeof reply === "object" && reply !== null && "ok" in reply &&
    typeof (reply as { ok?: unknown }).ok === "boolean";
}

function isFleetConfirmation(reply: unknown): reply is Extract<FleetReply, { needsConfirm: true }> {
  if (typeof reply !== "object" || reply === null || !("needsConfirm" in reply)) return false;
  const candidate = reply as { needsConfirm?: unknown; token?: unknown; ttlSec?: unknown };
  return candidate.needsConfirm === true && typeof candidate.token === "string" &&
    typeof candidate.ttlSec === "number" && Number.isFinite(candidate.ttlSec);
}

function fleetResultText(
  reply: Extract<FleetReply, { ok: boolean }>,
  verb: string,
  entity: string,
  failureLabel = verb[0]?.toUpperCase() + verb.slice(1),
): string {
  if (reply.ok) {
    return verb === "silence"
      ? `🔕 Silenced ${entity} for 2h`
      : `✓ Restarted ${entity}`;
  }
  const error = typeof reply.error === "string" && reply.error ? reply.error : "unknown error";
  // fleet_verb redacts and caps its structured error before it reaches this UI.
  return `✗ ${failureLabel} failed: ${error}`;
}

function isCallbackDataWithinLimit(action: string, payload: string): boolean {
  return Buffer.byteLength(`${action}:${payload}`, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}

async function handleFleetCallback(
  ctx: Context,
  action: "fr" | "fs" | "fc",
  payload: string,
  callHub: HubCall,
  state: FleetCallbackState,
): Promise<void> {
  const callbackKey = fleetCallbackKey(ctx, action, payload);
  if (state.outcomeUnknown.has(callbackKey)) {
    await ctx.answerCallbackQuery({ text: "Retry disabled: outcome unknown" });
    await renderFleetOutcomeUnknown(ctx);
    return;
  }
  if (state.inFlight.has(callbackKey)) {
    if (action === "fc") {
      await ctx.answerCallbackQuery({ text: "Confirmation expired" });
      await ctx.editMessageText("Confirmation expired — re-trigger from the original alert.").catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery({ text: "Fleet action already in progress" });
    return;
  }

  state.inFlight.add(callbackKey);
  try {
    if (action === "fc") {
      const pending = pendingFleetConfirms.get(payload);
      if (!pending) {
        await ctx.answerCallbackQuery({ text: "Confirmation expired" });
        await ctx.editMessageText("Confirmation expired — re-trigger from the original alert.").catch(() => {});
        return;
      }

      // Delete before awaiting the hub so duplicate webhook deliveries cannot replay it.
      clearPendingFleetConfirm(payload);
      await ctx.answerCallbackQuery({ text: `Confirming ${pending.entity}...` });
      const reply = await callHub("fleet_verb", {
        entity: pending.entity,
        verb: pending.verb,
        confirmToken: payload,
      });
      if (!isFleetOutcome(reply)) throw new Error("unexpected fleet confirmation result");
      await ctx.editMessageText(fleetResultText(reply, pending.verb, pending.entity, "Confirm")).catch(() => {});
      return;
    }

    const verb = action === "fr" ? "restart" : "silence";
    await ctx.answerCallbackQuery({
      text: verb === "restart" ? `Restarting ${payload}...` : `Silencing ${payload}...`,
    });
    const reply = await callHub("fleet_verb", { entity: payload, verb });
    if (isFleetConfirmation(reply)) {
      if (!isCallbackDataWithinLimit("fc", reply.token)) {
        await ctx.editMessageText("Confirmation token is too long — re-trigger from the original alert.").catch(() => {});
        return;
      }
      rememberPendingFleetConfirm(ctx, reply.token, { entity: payload, verb }, reply.ttlSec);
      await ctx.editMessageReplyMarkup({
        reply_markup: new InlineKeyboard()
          .text("Confirm", `fc:${reply.token}`)
          .text("Cancel", "cx"),
      }).catch(() => {});
      return;
    }
    if (!isFleetOutcome(reply)) throw new Error("unexpected fleet result");
    await ctx.editMessageText(fleetResultText(reply, verb, payload)).catch(() => {});
  } catch (error) {
    // The hub owns structured error redaction. Never surface or log thrown transport text here.
    log.error("Fleet callback failed", { action, ...(action === "fc" ? {} : { entity: payload }) });
    if (isHubCallOutcomeUnknown(error)) {
      state.outcomeUnknown.add(callbackKey);
      await renderFleetOutcomeUnknown(ctx);
    } else {
      await ctx.editMessageText("✗ Fleet action failed. Try again after hub recovery.").catch(() => {});
    }
  } finally {
    state.inFlight.delete(callbackKey);
  }
}

function proposalResultText(reply: DecideProposalReply, proposalId: string): string {
  if ("needsConfirm" in reply) return "Confirmation required";
  if (!reply.ok) return `✗ Proposal failed: ${escapeHtml(reply.error)}`;
  const detail = reply.detail ? ` — ${escapeHtml(reply.detail)}` : "";
  return `✓ Proposal <code>${escapeHtml(proposalId)}</code> is <b>${escapeHtml(reply.status)}</b>${detail}`;
}

async function editProposalMessage(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    ...(keyboard === undefined ? {} : { reply_markup: keyboard }),
  }).catch(() => {});
  if (keyboard === undefined) {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  }
}

async function handleFleetProposalCallback(
  ctx: Context,
  callback: FleetProposalCallback,
  callHub: HubCall,
  state: FleetCallbackState,
): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const callbackAction = callback.kind === "decision" ? "fp" : callback.kind === "confirm" ? "fpc" : "fpx";
  const callbackKey = fleetCallbackKey(ctx, callbackAction, data);
  if (state.outcomeUnknown.has(callbackKey)) {
    await ctx.answerCallbackQuery({ text: "Retry disabled: outcome unknown" });
    await renderFleetOutcomeUnknown(ctx);
    return;
  }
  if (state.inFlight.has(callbackKey)) {
    await ctx.answerCallbackQuery({ text: "Proposal decision already in progress" });
    return;
  }

  if (callback.kind === "cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await editProposalMessage(
      ctx,
      `Cancelled proposal <code>${escapeHtml(callback.proposalId)}</code>.`,
    );
    return;
  }

  const telegramUserId = ctx.from?.id;
  if (telegramUserId === undefined) {
    await ctx.answerCallbackQuery({ text: "Unauthorized proposal decision" });
    return;
  }

  const args: DecideProposalArgs = {
    proposalId: callback.proposalId,
    decision: callback.kind === "decision" ? callback.decision : "approve",
    principal: { projectId: `telegram:${telegramUserId}` },
    ...(callback.kind === "confirm" ? { confirmToken: callback.token } : {}),
  };

  state.inFlight.add(callbackKey);
  try {
    await ctx.answerCallbackQuery({ text: callback.kind === "confirm" ? "Confirming proposal..." : "Recording decision..." });
    const reply = await decideProposal(args, callHub);
    if ("needsConfirm" in reply) {
      if (reply.proposalId !== callback.proposalId) {
        throw new Error("proposal confirmation did not match request");
      }
      const keyboard = fleetProposalConfirmKeyboard(callback.proposalId, reply.token);
      await editProposalMessage(
        ctx,
        `⚠ Proposal <code>${escapeHtml(callback.proposalId)}</code> requires confirmation.`,
        keyboard,
      );
      return;
    }
    if (!reply.ok) {
      const retryKeyboard = callback.kind === "confirm"
        ? fleetProposalConfirmKeyboard(callback.proposalId, callback.token)
        : fleetProposalKeyboard(callback.proposalId);
      await editProposalMessage(ctx, proposalResultText(reply, callback.proposalId), retryKeyboard);
      return;
    }
    await editProposalMessage(ctx, proposalResultText(reply, callback.proposalId));
  } catch (error) {
    log.error("Fleet proposal callback failed", { proposalId: callback.proposalId });
    if (isHubCallOutcomeUnknown(error)) {
      state.outcomeUnknown.add(callbackKey);
      await renderFleetOutcomeUnknown(ctx);
    } else {
      const retryKeyboard = callback.kind === "confirm"
        ? fleetProposalConfirmKeyboard(callback.proposalId, callback.token)
        : fleetProposalKeyboard(callback.proposalId);
      await editProposalMessage(
        ctx,
        "✗ Proposal decision failed. Try again after hub recovery.",
        retryKeyboard,
      );
    }
  } finally {
    state.inFlight.delete(callbackKey);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Record an autonomy-rule level change to the daily log and post a News-topic ping.
 * Silent on null (no change) or on transient network failures.
 */
async function surfaceAutonomyChange(
  change: AutonomyLevelChange | null,
  deps: Pick<CallbackDeps, "memory" | "digestChatId" | "digestTopicId">,
  ctx: Context,
): Promise<void> {
  if (!change) return;

  const arrow = change.direction === "promoted"
    ? "→"
    : change.direction === "demoted"
      ? "↓"
      : "↺";
  const verb = change.direction === "promoted"
    ? "promoted"
    : change.direction === "demoted"
      ? "demoted"
      : "reset";

  const line =
    `- autonomy ${verb}: ${change.signalType}/${change.signalValue} ` +
    `${change.from} ${arrow} ${change.to} ` +
    `(action=${change.learnedAction}, conf=${change.confidence.toFixed(2)}, n=${change.decisions})`;

  try {
    deps.memory.appendDailyLog(line);
  } catch (err) {
    log.error("Failed to append autonomy daily-log entry", { error: String(err) });
  }

  const arrowIcon = change.direction === "promoted"
    ? "⬆️"
    : change.direction === "demoted"
      ? "⬇️"
      : "🔄";
  const message =
    `${arrowIcon} <b>Autonomy ${verb}</b>\n` +
    `<code>${escapeHtml(change.signalType)}/${escapeHtml(change.signalValue)}</code>\n` +
    `<b>${change.from}</b> ${arrow} <b>${change.to}</b>\n` +
    `action: <code>${escapeHtml(change.learnedAction)}</code> · ` +
    `confidence: ${change.confidence.toFixed(2)} · n=${change.decisions}`;

  try {
    if (deps.digestChatId) {
      await ctx.api.sendMessage(deps.digestChatId, message, {
        parse_mode: "HTML",
        ...(deps.digestTopicId ? { message_thread_id: deps.digestTopicId } : {}),
        link_preview_options: { is_disabled: true },
      });
    } else if (ctx.chat?.id) {
      // Fallback: DM the user who pressed the button
      await ctx.api.sendMessage(ctx.chat.id, message, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    }
  } catch (err) {
    log.error("Failed to post autonomy-change notice", { error: String(err) });
  }
}

export function createCallbackHandler(deps: CallbackDeps) {
  const { agent, scheduler, state, runAgent } = deps;
  const callHub = deps.hubCall ?? hubCall;
  const fleetCallbackState: FleetCallbackState = {
    inFlight: new Set(),
    outcomeUnknown: new Set(),
  };

  return async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const proposalCallback = parseFleetProposalCallback(data);
    if (proposalCallback !== null) {
      await handleFleetProposalCallback(ctx, proposalCallback, callHub, fleetCallbackState);
      return;
    }

    const { action, payload } = parseCallback(data);
    const sKey = sessionKey(ctx);

    try {
      switch (action) {
        case "cn": {
          // Cancel: interrupt the run tied to *this* Cancel button's message,
          // not just "whatever is active in this chat/topic" — multiple runs
          // can overlap in the same session (TaskQueue maxConcurrency > 1).
          const cnMsgId = ctx.callbackQuery?.message?.message_id;
          const runId = cnMsgId != null ? state.getActiveRun(sKey, cnMsgId) : undefined;
          if (!runId) {
            await ctx.answerCallbackQuery({ text: "Nothing to cancel" });
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
            return;
          }
          await agent.interrupt(runId);
          state.deleteActiveRun(sKey, cnMsgId!);
          await ctx.answerCallbackQuery({ text: "Cancelling..." });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "md": {
          // Set model
          const resolved = getModelAliases()[payload];
          if (!resolved) {
            await ctx.answerCallbackQuery({ text: "Unknown model" });
            return;
          }
          state.modelOverrides.set(sKey, resolved);
          await ctx.answerCallbackQuery({ text: `Model: ${payload}` });
          // Remove the model picker keyboard
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "sr": {
          // Resume session
          const session = resolveSessionByPrefix(payload);
          if (!session) {
            await ctx.answerCallbackQuery({ text: "Session not found" });
            return;
          }
          state.resumeOverrides.set(sKey, session.session_id);
          state.bootedChats.add(sKey);
          state.resetChats.delete(sKey);
          const preview = getSessionPreview(session.session_id) ?? "(empty)";
          await ctx.answerCallbackQuery({ text: `Resumed: ${payload}` });
          await ctx.reply(escapeMarkdownV2(`Resumed session ${payload}: ${preview}\n\nNext messages continue in this session. Use /new to start fresh.`), MD2);
          break;
        }

        case "sf": {
          // Fork session
          const session = resolveSessionByPrefix(payload);
          if (!session) {
            await ctx.answerCallbackQuery({ text: "Session not found" });
            return;
          }
          const messages = getMessagesBySession(session.session_id);
          if (messages.length === 0) {
            await ctx.answerCallbackQuery({ text: "Session has no messages" });
            return;
          }
          await ctx.answerCallbackQuery();
          const transcript = messages
            .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
            .join("\n\n");
          const maxChars = 50_000;
          const trimmed = transcript.length > maxChars
            ? "...\n" + transcript.slice(transcript.length - maxChars)
            : transcript;
          const preamble = `<prior_conversation session="${session.session_id}">\n${trimmed}\n</prior_conversation>\n\n`;
          state.resetChats.add(sKey);
          state.bootedChats.delete(sKey);
          state.resumeOverrides.delete(sKey);
          await runAgent(ctx, preamble + "Continue from where this conversation left off.");
          break;
        }

        case "jr": {
          // Run job immediately
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          scheduler.trigger(jobId);
          await ctx.answerCallbackQuery({ text: `Job "${job.name}" triggered` });
          break;
        }

        case "jp": {
          // Toggle pause (24h)
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          const isPaused = job.paused_until && new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z") > new Date();
          if (isPaused) {
            updateJob(jobId, { paused_until: null }, { by: "user", reason: "job-list button" });
            await ctx.answerCallbackQuery({ text: `Job "${job.name}" unpaused` });
          } else {
            const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
            updateJob(jobId, { paused_until: until }, { by: "user", reason: "job-list button" });
            await ctx.answerCallbackQuery({ text: `Job "${job.name}" paused 24h` });
          }
          // Refresh the job list keyboard
          const jobs = getAllJobs();
          if (jobs.length > 0) {
            await ctx.editMessageReplyMarkup({ reply_markup: jobListKeyboard(jobs) }).catch(() => {});
          }
          break;
        }

        case "je": {
          // Toggle enabled/disabled
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          const newStatus = job.status === "enabled" ? "disabled" : "enabled";
          updateJob(jobId, { status: newStatus as "enabled" | "disabled" }, { by: "user", reason: "job-list button" });
          scheduler.reload();
          await ctx.answerCallbackQuery({ text: `Job "${job.name}" ${newStatus}` });
          // Refresh keyboard
          const jobs = getAllJobs();
          if (jobs.length > 0) {
            await ctx.editMessageReplyMarkup({ reply_markup: jobListKeyboard(jobs) }).catch(() => {});
          }
          break;
        }

        case "jd": {
          // Show delete confirmation
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({ reply_markup: confirmDeleteKeyboard(jobId) });
          break;
        }

        case "jy": {
          // Confirm delete
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job already deleted" });
            return;
          }
          deleteJob(jobId);
          scheduler.reload();
          await ctx.answerCallbackQuery({ text: `Job "${job.name}" deleted` });
          await ctx.editMessageText(escapeMarkdownV2("Job deleted."), MD2).catch(() => {});
          break;
        }

        case "jax": {
          // Job actions expand/collapse toggle (on job notification messages).
          // Preserves any trailing URL row (the "Open in app" deep link).
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          const current = ctx.callbackQuery?.message;
          const hasCollapse = current?.reply_markup?.inline_keyboard?.some(row =>
            row.some(btn => btn.text.includes("Collapse"))
          );
          const urlRows = (current?.reply_markup?.inline_keyboard ?? []).filter(row =>
            row.some(btn => "url" in btn)
          );
          await ctx.answerCallbackQuery({});
          const markup = hasCollapse ? jobActionsKeyboard(jobId) : jobActionsKeyboardExpanded(job);
          for (const row of urlRows) {
            markup.row();
            for (const btn of row) {
              if ("url" in btn && btn.url) markup.url(btn.text, btn.url);
            }
          }
          await ctx.editMessageReplyMarkup({ reply_markup: markup }).catch(() => {});
          break;
        }

        case "jnp": {
          // Pause 24h / resume from a job notification — audited as user action
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          if (isJobPaused(job)) {
            updateJob(jobId, { paused_until: null }, { by: "user", reason: "job-actions button" });
            await ctx.answerCallbackQuery({ text: `Job "${job.name}" resumed` });
          } else {
            const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
            updateJob(jobId, { paused_until: until }, { by: "user", reason: "job-actions button" });
            await ctx.answerCallbackQuery({ text: `Job "${job.name}" paused 24h` });
          }
          const refreshed = getJob(jobId);
          if (refreshed) {
            await ctx.editMessageReplyMarkup({ reply_markup: jobActionsKeyboardExpanded(refreshed) }).catch(() => {});
          }
          break;
        }

        case "jns": {
          // Skip the next scheduled run — audited as user action
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          const skips = (job.skip_runs ?? 0) + 1;
          updateJob(jobId, { skip_runs: skips }, { by: "user", reason: "job-actions button" });
          await ctx.answerCallbackQuery({ text: `Will skip next run (${skips} queued)` });
          break;
        }

        case "jnq": {
          // Silence / unsilence job notifications — audited as user action.
          // Unsilence restores the default policy chain (job NULL → agent → global).
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          const silencing = job.notify_policy !== "silent";
          updateJob(jobId, { notify_policy: silencing ? "silent" : null }, { by: "user", reason: "job-actions button" });
          await ctx.answerCallbackQuery({ text: silencing ? `Job "${job.name}" silenced` : `Job "${job.name}" unsilenced` });
          const refreshed = getJob(jobId);
          if (refreshed) {
            await ctx.editMessageReplyMarkup({ reply_markup: jobActionsKeyboardExpanded(refreshed) }).catch(() => {});
          }
          break;
        }

        case "jnh": {
          // Show recent config history for the job as a reply in the same thread
          const jobId = parseInt(payload, 10);
          const job = getJob(jobId);
          if (!job) {
            await ctx.answerCallbackQuery({ text: "Job not found" });
            return;
          }
          const history = getJobConfigHistory(jobId, 8);
          await ctx.answerCallbackQuery({});
          const short = (v: unknown): string => {
            const s = v === null || v === undefined ? "∅" : String(v);
            return s.length > 60 ? s.slice(0, 60) + "…" : s;
          };
          const lines = history.length === 0
            ? [`No recorded config changes for "${job.name}" (#${jobId}).`]
            : [
                `Config history — "${job.name}" (#${jobId}):`,
                ...history.map((h) => {
                  let fields = "?";
                  try {
                    const changes = JSON.parse(h.changes) as Record<string, { from: unknown; to: unknown }>;
                    fields = Object.entries(changes)
                      .map(([k, c]) => `${k}: ${short(c.from)} → ${short(c.to)}`)
                      .join("; ");
                  } catch { /* keep "?" */ }
                  const when = h.changed_at.slice(0, 16).replace("T", " ");
                  return `• ${when} [${h.changed_by}] ${fields}${h.reason ? ` (${h.reason})` : ""}`;
                }),
              ];
          const chatIdForHistory = ctx.chat?.id;
          if (chatIdForHistory !== undefined) {
            const threadId = ctx.callbackQuery?.message?.message_thread_id;
            try {
              const sent = await ctx.api.sendMessage(chatIdForHistory, lines.join("\n"), {
                ...(threadId ? { message_thread_id: threadId } : {}),
              });
              recordSentMessage(chatIdForHistory, sent.message_id, threadId ?? null, {
                source: "job-history",
                jobId,
                preview: lines[0],
              });
            } catch (err) {
              log.error("Failed to send job history", { jobId, error: String(err) });
            }
          }
          break;
        }

        case "bp": {
          // Bill PAID — also sync source system (Apple Reminders) when source_id is known.
          const id = parseInt(payload, 10);
          const reminder = getReminder(id);
          completeReminder(id);
          if (reminder?.source_id?.startsWith("apple-rem:")) {
            const appleId = reminder.source_id.slice("apple-rem:".length);
            Bun.spawn(["remindctl", "complete", appleId], {
              stdout: "ignore",
              stderr: "ignore",
              stdin: "ignore",
            });
          }
          await ctx.answerCallbackQuery({ text: "Marked as PAID" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "bs": {
          // SKIP/dismiss
          const id = parseInt(payload, 10);
          dismissReminder(id);
          await ctx.answerCallbackQuery({ text: "Dismissed" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "bz": {
          // SNOOZE
          // payload format: "reminderId:hours"
          const [idStr, hoursStr] = payload.split(":");
          const id = parseInt(idStr, 10);
          const hours = parseInt(hoursStr, 10);
          snoozeReminder(id, hours * 60 * 60 * 1000);
          await ctx.answerCallbackQuery({ text: `Snoozed ${hours}h` });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "bm": {
          // MORE details
          const id = parseInt(payload, 10);
          const reminder = getReminder(id);
          if (reminder?.description) {
            await ctx.answerCallbackQuery();
            await ctx.reply(escapeMarkdownV2(reminder.description), MD2);
          } else {
            await ctx.answerCallbackQuery({ text: "No additional details" });
          }
          break;
        }

        case "bx": {
          // Reminder keyboard expand/collapse toggle.
          // Same convention as bfx: inspect the current reply_markup — if any
          // button text contains "Collapse" we're expanded, so swap to collapsed.
          const bxId = parseInt(payload, 10);
          const current = ctx.callbackQuery?.message;
          const hasCollapse = current?.reply_markup?.inline_keyboard?.some(row =>
            row.some(btn => btn.text.includes("Collapse"))
          );
          await ctx.answerCallbackQuery({});
          const markup = hasCollapse
            ? briefingActionKeyboard(bxId)
            : briefingActionKeyboardExpanded(bxId);
          await ctx.editMessageReplyMarkup({ reply_markup: markup }).catch(() => {});
          break;
        }

        case "rr": {
          // Research — swap buttons immediately, background the rest
          const id = parseInt(payload, 10);
          const researchKb = new InlineKeyboard()
            .text("Quick Scan", `rqs:${id}`)
            .text("Deep Dive", `rds:${id}`);
          await ctx.answerCallbackQuery({ text: "Pick research depth" });
          await ctx.editMessageReplyMarkup({ reply_markup: researchKb }).catch(() => {});
          // Background: DB updates, NotePlan tag, feedback + autonomy learning.
          const rrResult = applyItemAction(id, "research");
          await surfaceAutonomyChange(rrResult.change, deps, ctx);
          break;
        }

        case "rqs": {
          // Quick scan research
          const id = parseInt(payload, 10);
          await ctx.answerCallbackQuery({ text: "Starting quick scan..." });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          await deps.runQuickResearch(ctx, id);
          break;
        }

        case "rds": {
          // Deep dive research
          const id = parseInt(payload, 10);
          await ctx.answerCallbackQuery({ text: "Starting deep research..." });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          await deps.runDeepResearch(ctx, id);
          break;
        }

        case "rw": {
          // Watch — respond immediately, background the rest
          const id = parseInt(payload, 10);
          await ctx.answerCallbackQuery({ text: "Watching this topic" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          const rwResult = applyItemAction(id, "watch");
          await surfaceAutonomyChange(rwResult.change, deps, ctx);
          break;
        }

        case "rx": {
          // Archive — for P1-3 items, ask for a reason first
          const id = parseInt(payload, 10);
          const rxItem = getPendingItemById(id);
          if (rxItem && rxItem.priority !== null && rxItem.priority <= 3) {
            await ctx.answerCallbackQuery({ text: "Why archive?" });
            const reasonKb = new InlineKeyboard()
              .text("Already knew", `rxr:${id}:known`)
              .text("Outdated", `rxr:${id}:outdated`)
              .row()
              .text("Not relevant", `rxr:${id}:irrelevant`)
              .text("Low quality", `rxr:${id}:low_quality`)
              .row()
              .text("Skip reason", `rxr:${id}:none`);
            await ctx.editMessageReplyMarkup({ reply_markup: reasonKb }).catch(() => {});
          } else {
            await ctx.answerCallbackQuery({ text: "Archived" });
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
            const rxResult = applyItemAction(id, "archive");
            await surfaceAutonomyChange(rxResult.change, deps, ctx);
          }
          break;
        }

        case "rxr": {
          // Archive with reason — payload is "id:reason"
          const [idStr, reason] = payload.split(":");
          const id = parseInt(idStr, 10);
          await ctx.answerCallbackQuery({ text: "Archived" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          const rxrResult = applyItemAction(id, "archive", reason);
          await surfaceAutonomyChange(rxrResult.change, deps, ctx);
          break;
        }

        case "rd": {
          // Drop — for P1-3 items, ask for a reason first
          const id = parseInt(payload, 10);
          const rdItem = getPendingItemById(id);
          if (rdItem && rdItem.priority !== null && rdItem.priority <= 3) {
            await ctx.answerCallbackQuery({ text: "Why drop?" });
            const reasonKb = new InlineKeyboard()
              .text("Already knew", `rdr:${id}:known`)
              .text("Outdated", `rdr:${id}:outdated`)
              .row()
              .text("Not relevant", `rdr:${id}:irrelevant`)
              .text("Low quality", `rdr:${id}:low_quality`)
              .row()
              .text("Skip reason", `rdr:${id}:none`);
            await ctx.editMessageReplyMarkup({ reply_markup: reasonKb }).catch(() => {});
          } else {
            await ctx.answerCallbackQuery({ text: "Dropped" });
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
            const rdResult = applyItemAction(id, "drop");
            await surfaceAutonomyChange(rdResult.change, deps, ctx);
          }
          break;
        }

        case "rdr": {
          // Drop with reason — payload is "id:reason"
          const [idStr, reason] = payload.split(":");
          const id = parseInt(idStr, 10);
          await ctx.answerCallbackQuery({ text: "Dropped" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          const rdrResult = applyItemAction(id, "drop", reason);
          await surfaceAutonomyChange(rdrResult.change, deps, ctx);
          break;
        }

        case "as": {
          // Asset digest buttons (src/assets/digest.ts): payload "q|f|x|n:<id>"
          // = queue, file into the kind's home, dismiss, already handled.
          const { handleAssetCallback, markRowDone } = await import("../assets/digest.ts");
          const r = await handleAssetCallback(payload);
          await ctx.answerCallbackQuery({ text: r.toast, show_alert: !r.ok && !payload.startsWith("n:") });
          if (r.ok && r.assetId !== null && r.doneLabel) {
            const rows = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard ?? [];
            const next = markRowDone(rows as Parameters<typeof markRowDone>[0], r.assetId, r.doneLabel);
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: next as InlineKeyboard["inline_keyboard"] } }).catch(() => {});
          }
          break;
        }

        case "dg": {
          // Weekly digest buttons (src/digest/buttons.ts): payload
          // "w|a|s|n:<itemId>:<week>" = watch / archive / snooze / already
          // handled. One attributed feedback_log row per click (F3/F4 fix).
          // Dynamic import matches the "as" case's pattern: dispatch stays
          // lazy so handler modules load only when their button is tapped.
          const { handleDigestCallback, markDigestRowDone } = await import("../digest/buttons.ts");
          const dg = handleDigestCallback(payload);
          await ctx.answerCallbackQuery({ text: dg.toast, show_alert: !dg.ok && !payload.startsWith("n:") });
          if (dg.ok && dg.itemId !== null && dg.doneLabel) {
            const rows = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard ?? [];
            const next = markDigestRowDone(rows as Parameters<typeof markDigestRowDone>[0], dg.itemId, dg.doneLabel);
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: next as InlineKeyboard["inline_keyboard"] } }).catch(() => {});
          }
          break;
        }

        case "fr":
        case "fs":
        case "fc": {
          await handleFleetCallback(ctx, action, payload, callHub, fleetCallbackState);
          break;
        }

        case "dv": {
          // YouTube discovery candidate feedback. payload = "<sub>:<candidateId>"
          // where sub is 'drop' (dismiss this discovery). Used to let the user
          // prune discoveries and feed the learning loop.
          const sepIdx = payload.indexOf(":");
          const sub = sepIdx >= 0 ? payload.slice(0, sepIdx) : payload;
          const candidateId = parseInt(sepIdx >= 0 ? payload.slice(sepIdx + 1) : payload, 10);
          const { updateCandidate } = await import("../discovery/db.ts");
          const { insertFeedbackLog } = await import("../db/queries.ts");

          if (sub === "drop") {
            updateCandidate(candidateId, { status: "dismissed" });
            await ctx.answerCallbackQuery({ text: "Dismissed — won't suggest again" });
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          } else {
            await ctx.answerCallbackQuery({ text: "Done" });
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          }
          insertFeedbackLog({
            content_type: "youtube_discovery",
            source: "telegram",
            user_action: sub,
            signal_snapshot: JSON.stringify({ candidateId }),
          });
          break;
        }

        case "bfx": {
          // Brief keyboard expand/collapse toggle
          const bfxJobRunId = parseInt(payload, 10) || 0;
          const current = ctx.callbackQuery?.message;
          const hasCollapse = current?.reply_markup?.inline_keyboard?.some(row =>
            row.some(btn => btn.text.includes("Collapse"))
          );
          await ctx.answerCallbackQuery({});
          const markup = hasCollapse
            ? briefKeyboard(bfxJobRunId)
            : briefKeyboardExpanded(bfxJobRunId);
          await ctx.editMessageReplyMarkup({ reply_markup: markup }).catch(() => {});
          break;
        }

        case "bf": {
          // Brief section drill-down: payload = "jobRunId:section"
          const sepIdx = payload.indexOf(":");
          const bfJobRunId = parseInt(sepIdx >= 0 ? payload.slice(0, sepIdx) : payload, 10);
          const section = sepIdx >= 0 ? payload.slice(sepIdx + 1) : payload;
          // Prefer the full stored job_run result over the message text: on a
          // brief split across multiple Telegram messages, the keyboard only
          // lands on the LAST chunk, so the message text alone is a truncated
          // tail of the real brief. Fall back to it only if the run row is gone.
          const bfRun = Number.isFinite(bfJobRunId) ? getJobRun(bfJobRunId) : null;
          const briefMsg = bfRun?.result ?? ctx.callbackQuery?.message?.text ?? "";

          const sectionLabels: Record<string, string> = {
            markets: "Markets",
            calendar: "Calendar & Schedule",
            inbox: "Inbox",
            email: "Gmail / Email",
            tasks: "Tasks",
            actions: "Actions Needed",
          };
          const label = sectionLabels[section] ?? section;

          await ctx.answerCallbackQuery({ text: `Expanding ${label}...` });

          // Spawn an agent conversation with the brief as context
          state.resetChats.add(sKey);
          state.bootedChats.delete(sKey);
          state.resumeOverrides.delete(sKey);
          await runAgent(
            ctx,
            `Here is today's morning brief:\n\n${briefMsg}\n\nGive me a detailed breakdown of the "${label}" section. ` +
            `Expand on the key points, provide additional context, and suggest specific actions I should take. ` +
            `Use the available tools to get live data if relevant.`
          );
          break;
        }

        case "bfr": {
          // Brief reply — start a general conversation about the brief.
          // payload = jobRunId. See "bf" above for why we prefer the stored
          // result over the message text (split-message truncation).
          const bfrJobRunId = parseInt(payload, 10);
          const bfrRun = Number.isFinite(bfrJobRunId) ? getJobRun(bfrJobRunId) : null;
          const briefText = bfrRun?.result ?? ctx.callbackQuery?.message?.text ?? "";
          await ctx.answerCallbackQuery({ text: "Starting conversation..." });

          state.resetChats.add(sKey);
          state.bootedChats.delete(sKey);
          state.resumeOverrides.delete(sKey);
          await runAgent(
            ctx,
            `Here is today's morning brief:\n\n${briefText}\n\nI'd like to discuss this brief. What questions do you have, or what should I focus on?`
          );
          break;
        }

        case "sxa": {
          // Skill export — Approve. payload is the short nudge id (skill
          // names can exceed the 64-byte callback_data limit). Runs the
          // exact same code path as skill_manage action=approve_export.
          const sxaName = resolveExportNudgeId(payload);
          if (!sxaName) {
            await ctx.answerCallbackQuery({ text: "Unknown skill (nudge expired)" });
            return;
          }
          setExportApproved(sxaName, true);
          clearExportNudge(sxaName);
          await ctx.answerCallbackQuery({ text: `Approved '${sxaName}' for export` });
          await ctx.editMessageText(
            `✅ Approved <b>${escapeHtml(sxaName)}</b> for export (synced to ~/.claude/skills on next curator pass).`,
            { parse_mode: "HTML" },
          ).catch(() => {});
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "sxs": {
          // Skill export — Skip. Marks the candidate declined so it isn't
          // re-nudged on future curator passes.
          const sxsName = resolveExportNudgeId(payload);
          if (!sxsName) {
            await ctx.answerCallbackQuery({ text: "Unknown skill (nudge expired)" });
            return;
          }
          markExportDeclined(sxsName);
          await ctx.answerCallbackQuery({ text: `Skipped '${sxsName}'` });
          await ctx.editMessageText(
            `⏭️ Skipped export of <b>${escapeHtml(sxsName)}</b> (won't ask again).`,
            { parse_mode: "HTML" },
          ).catch(() => {});
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "cx": {
          // Cancel / dismiss keyboard
          const messageKey = callbackMessageKey(ctx);
          const pendingToken = messageKey === undefined ? undefined : pendingFleetConfirmMessages.get(messageKey);
          if (pendingToken !== undefined) {
            clearPendingFleetConfirm(pendingToken);
            await ctx.answerCallbackQuery({ text: "Cancelled" });
            await ctx.editMessageText("Cancelled").catch(() => {});
            break;
          }
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        default:
          await ctx.answerCallbackQuery({ text: "Unknown action" });
      }
    } catch (err) {
      log.error("Callback handler error", { action, payload, error: String(err) });
      await ctx.answerCallbackQuery({ text: "Error processing action" }).catch(() => {});
    }
  };
}
