import { InlineKeyboard, type Context } from "grammy";
import type { AgentService } from "../agent/index.ts";
import type { Scheduler } from "../scheduler/index.ts";
import type { ChatState } from "./state.ts";
import {
  resolveSessionByPrefix,
  getLastUserMessage,
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
  updatePendingItem,
  insertFeedbackLog,
} from "../db/queries.ts";
import { escapeMarkdownV2 } from "./format.ts";
import { createLogger } from "../shared/logger.ts";
import { updateAutonomyFromFeedback } from "../heartbeat/autonomy.ts";
import { getPendingItemById } from "../db/queries.ts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const log = createLogger("telegram:keyboards");

/** Update a tag in a NotePlan note's YAML frontmatter. */
function addNoteplanTag(noteplanPath: string | null, tag: string): void {
  if (!noteplanPath || !existsSync(noteplanPath)) return;
  try {
    const content = readFileSync(noteplanPath, "utf-8");
    if (!content.startsWith("---")) return;
    const endIdx = content.indexOf("---", 3);
    if (endIdx === -1) return;
    const frontmatter = content.slice(0, endIdx + 3);
    const body = content.slice(endIdx + 3);

    // Check if tag already exists
    if (frontmatter.includes(`- ${tag}`)) return;

    // Insert tag after existing tags
    const tagsMatch = frontmatter.match(/^tags:\n((?:\s+-\s+.+\n)*)/m);
    if (tagsMatch) {
      const insertPos = frontmatter.indexOf(tagsMatch[0]) + tagsMatch[0].length;
      const updated = frontmatter.slice(0, insertPos) + `  - ${tag}\n` + frontmatter.slice(insertPos);
      writeFileSync(noteplanPath, updated + body, "utf-8");
    } else {
      // No tags section — add one before closing ---
      const updated = frontmatter.slice(0, endIdx) + `tags:\n  - ${tag}\n` + frontmatter.slice(endIdx);
      writeFileSync(noteplanPath, updated + body, "utf-8");
    }
  } catch (err) {
    log.error("Failed to update NotePlan tag", { noteplanPath, tag, error: String(err) });
  }
}

const MD2 = { parse_mode: "MarkdownV2" as const };

/** Session key incorporating topic thread ID for isolated sessions per group topic. */
function sessionKey(ctx: Context): string {
  const chatId = String(ctx.chat?.id ?? "");
  const threadId = ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id;
  return threadId ? `${chatId}:${threadId}` : chatId;
}

// --- Keyboard Builders ---

export function agentResponseKeyboard(sessionId: string): InlineKeyboard {
  const sid = sessionId.slice(0, 8);
  return new InlineKeyboard()
    .text("Regenerate", `rg:${sid}`)
    .text("Continue", `ct:${sid}`)
    .text("Switch Model", "sm");
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

export function briefingActionKeyboard(reminderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("PAID", `bp:${reminderId}`)
    .text("SKIP", `bs:${reminderId}`)
    .row()
    .text("1h", `bz:${reminderId}:1`)
    .text("4h", `bz:${reminderId}:4`)
    .text("24h", `bz:${reminderId}:24`)
    .row()
    .text("MORE", `bm:${reminderId}`);
}

export function approvalKeyboard(reminderId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("APPROVE", `ba:${reminderId}`)
    .text("REJECT", `br:${reminderId}`);
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

// --- Callback Handler ---

const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5-20250929",
  haiku: "claude-haiku-4-5-20251001",
};

interface CallbackDeps {
  agent: AgentService;
  scheduler: Scheduler;
  state: ChatState;
  runAgent: (ctx: Context, prompt: string) => Promise<void>;
}

export function createCallbackHandler(deps: CallbackDeps) {
  const { scheduler, state, runAgent } = deps;

  return async (ctx: Context) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    const { action, payload } = parseCallback(data);
    const sKey = sessionKey(ctx);

    try {
      switch (action) {
        case "rg": {
          // Regenerate: resolve session, get last user message, run fresh
          const session = resolveSessionByPrefix(payload);
          if (!session) {
            await ctx.answerCallbackQuery({ text: "Session not found" });
            return;
          }
          const lastMsg = getLastUserMessage(session.session_id);
          if (!lastMsg) {
            await ctx.answerCallbackQuery({ text: "No message to regenerate" });
            return;
          }
          await ctx.answerCallbackQuery();
          // Start fresh session for regeneration
          state.resetChats.add(sKey);
          state.bootedChats.delete(sKey);
          state.resumeOverrides.delete(sKey);
          await runAgent(ctx, lastMsg);
          break;
        }

        case "ct": {
          // Continue: resume session, send "continue"
          const session = resolveSessionByPrefix(payload);
          if (!session) {
            await ctx.answerCallbackQuery({ text: "Session not found" });
            return;
          }
          await ctx.answerCallbackQuery();
          state.resumeOverrides.set(sKey, session.session_id);
          state.bootedChats.add(sKey);
          state.resetChats.delete(sKey);
          await runAgent(ctx, "continue");
          break;
        }

        case "sm": {
          // Show model picker
          await ctx.answerCallbackQuery();
          await ctx.editMessageReplyMarkup({ reply_markup: modelPickerKeyboard() });
          break;
        }

        case "md": {
          // Set model
          const resolved = MODEL_ALIASES[payload];
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
            updateJob(jobId, { paused_until: null });
            await ctx.answerCallbackQuery({ text: `Job "${job.name}" unpaused` });
          } else {
            const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
            updateJob(jobId, { paused_until: until });
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
          updateJob(jobId, { status: newStatus as "enabled" | "disabled" });
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

        case "bp": {
          // Bill PAID
          const id = parseInt(payload, 10);
          completeReminder(id);
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

        case "ba": {
          // APPROVE research/action
          const id = parseInt(payload, 10);
          completeReminder(id);
          await ctx.answerCallbackQuery({ text: "Approved" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "br": {
          // REJECT
          const id = parseInt(payload, 10);
          dismissReminder(id);
          await ctx.answerCallbackQuery({ text: "Rejected" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }


        case "rr": {
          // Research — user wants to research this item
          const id = parseInt(payload, 10);
          const rrItem = getPendingItemById(id);
          updatePendingItem(id, { status: "archived", auto_decision: "research_requested" });
          addNoteplanTag(rrItem?.noteplan_path ?? null, "research");
          insertFeedbackLog({ item_id: id, user_action: "research", system_recommendation: "triage" });
          updateAutonomyFromFeedback({
            signalType: "digest_item",
            signalValue: "source:telegram",
            systemRecommendation: "triage",
            userAction: "research",
          });
          await ctx.answerCallbackQuery({ text: "Queued for research" });
          // Replace buttons with just the hint text
          const hint = `Use <code>/research ${id}</code> for quick scan or <code>/research deep ${id}</code> for full dive`;
          const origText = ctx.callbackQuery?.message && "text" in ctx.callbackQuery.message
            ? ctx.callbackQuery.message.text ?? ""
            : "";
          try {
            await ctx.editMessageText(origText + "\n\n" + hint, { parse_mode: "HTML" });
          } catch {
            // If edit fails, just remove the keyboard
            await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          }
          break;
        }

        case "rw": {
          // Watch — mark item for monitoring, remove from digest
          const id = parseInt(payload, 10);
          const rwItem = getPendingItemById(id);
          updatePendingItem(id, { status: "archived", watch_status: "watching" });
          addNoteplanTag(rwItem?.noteplan_path ?? null, "watch");
          insertFeedbackLog({ item_id: id, user_action: "watch", system_recommendation: "triage" });
          updateAutonomyFromFeedback({
            signalType: "digest_item",
            signalValue: "source:telegram",
            systemRecommendation: "triage",
            userAction: "watch",
          });
          await ctx.answerCallbackQuery({ text: "Watching this topic" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "rx": {
          // Archive
          const id = parseInt(payload, 10);
          const rxItem = getPendingItemById(id);
          updatePendingItem(id, { status: "archived" });
          addNoteplanTag(rxItem?.noteplan_path ?? null, "archived");
          insertFeedbackLog({ item_id: id, user_action: "archive", system_recommendation: "triage" });
          updateAutonomyFromFeedback({
            signalType: "digest_item",
            signalValue: "source:telegram",
            systemRecommendation: "triage",
            userAction: "archive",
          });
          await ctx.answerCallbackQuery({ text: "Archived" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "rd": {
          // Drop — mark as deleted
          const id = parseInt(payload, 10);
          const rdItem = getPendingItemById(id);
          updatePendingItem(id, { status: "deleted" });
          addNoteplanTag(rdItem?.noteplan_path ?? null, "dropped");
          insertFeedbackLog({ item_id: id, user_action: "drop", system_recommendation: "triage" });
          updateAutonomyFromFeedback({
            signalType: "digest_item",
            signalValue: "source:telegram",
            systemRecommendation: "triage",
            userAction: "drop",
          });
          await ctx.answerCallbackQuery({ text: "Dropped" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }

        case "cx": {
          // Cancel / dismiss keyboard
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
