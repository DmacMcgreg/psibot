import { InlineKeyboard, InputFile, type Context } from "grammy";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { Scheduler } from "../scheduler/index.ts";
import type { ChatState } from "./state.ts";
import type { ChatContext } from "../shared/types.ts";
import {
  agentResponseKeyboard,
  modelPickerKeyboard,
  sessionListKeyboard,
  jobListKeyboard,
} from "./keyboards.ts";
import {
  getAllJobs,
  createJob,
  getRecentRuns,
  getJob,
  getLatestSessionId,
  getRecentSessions,
  getRecentSessionsBySourcePrefix,
  getSessionPreview,
  getMessagesBySession,
  insertPendingItem,
  getPendingItemCount,
  getPendingItemById,
  getPendingItems,
  updatePendingItem,
} from "../db/queries.ts";
import {
  preliminaryResearch,
  deepResearch,
  createResearchNote,
} from "../research/index.ts";
import {
  splitMessage,
  escapeMarkdownV2,
  markdownToTelegramV2,
  formatCost,
  formatJobSummary,
  formatRunMeta,
  formatToolLine,
  formatToolsSummary,
} from "./format.ts";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import { PLIST_LABEL } from "../cli/paths.ts";
import type { TaskQueue } from "../shared/task-queue.ts";

const log = createLogger("telegram:commands");

/** Execute a deferred daemon restart via launchctl kickstart -k. */
function executeDeferredRestart(): void {
  const uid = process.getuid?.() ?? 501;
  const target = `gui/${uid}/${PLIST_LABEL}`;
  log.info("Executing deferred daemon restart", { target });
  // Spawn detached: sleep 1s to let current response flush, then kickstart
  Bun.spawn(["bash", "-c", `sleep 1 && launchctl kickstart -k ${target}`], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
}

/**
 * Session key for topic-isolated sessions.
 * In groups with topics, returns "chatId:threadId" so each topic gets its own session.
 * In DMs or groups without topics, returns just "chatId".
 * Works for both regular messages and callback queries.
 */
function sessionKey(ctx: Context): string {
  const chatId = String(ctx.chat?.id ?? "");
  const threadId = ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id;
  return threadId ? `${chatId}:${threadId}` : chatId;
}

/** Base chat ID without topic suffix, for cross-topic session discovery. */
function baseChatId(ctx: Context): string {
  return String(ctx.chat?.id ?? "");
}

/** Build ChatContext from a grammy Context for routing agent responses. */
function chatContext(ctx: Context): ChatContext | undefined {
  const chat = ctx.chat;
  if (!chat) return undefined;
  const chatType = chat.type as ChatContext["chatType"];
  if (chatType === "private") return undefined; // DMs don't need routing hints
  const threadId = ctx.message?.message_thread_id
    ?? ctx.callbackQuery?.message?.message_thread_id;
  return {
    chatId: String(chat.id),
    chatType,
    ...(threadId ? { topicId: threadId } : {}),
  };
}

const MD2 = { parse_mode: "MarkdownV2" as const };

/** Reply with MarkdownV2-escaped text. Merges extra options (reply_markup, etc). */
async function replyMd2(ctx: Context, text: string, opts?: Record<string, unknown>): Promise<ReturnType<Context["reply"]>> {
  return ctx.reply(escapeMarkdownV2(text), { ...MD2, ...opts });
}

/** Edit a message with MarkdownV2-escaped text. Merges extra options. */
async function editMd2(ctx: Context, chatId: number, messageId: number, text: string, opts?: Record<string, unknown>): Promise<void> {
  await ctx.api.editMessageText(chatId, messageId, escapeMarkdownV2(text), { ...MD2, ...opts });
}

/** Reply with agent output converted from standard Markdown to MarkdownV2. */
async function replyAgentMd2(ctx: Context, text: string, opts?: Record<string, unknown>): Promise<ReturnType<Context["reply"]>> {
  return ctx.reply(markdownToTelegramV2(text), { ...MD2, ...opts });
}

/** Edit a message with agent output converted from standard Markdown to MarkdownV2. */
async function editAgentMd2(ctx: Context, chatId: number, messageId: number, text: string, opts?: Record<string, unknown>): Promise<void> {
  await ctx.api.editMessageText(chatId, messageId, markdownToTelegramV2(text), { ...MD2, ...opts });
}

interface CommandDeps {
  agent: AgentService;
  memory: MemorySystem;
  scheduler: Scheduler;
  state: ChatState;
  taskQueue: TaskQueue;
}

export function registerCommands(deps: CommandDeps) {
  const { agent, memory, scheduler, state, taskQueue } = deps;
  const { resetChats, bootedChats, resumeOverrides, modelOverrides } = state;

  async function handleStart(ctx: Context): Promise<void> {
    await replyMd2(ctx,
      "Agent ready. Send me any message or use commands:\n\n" +
        "/ask <question> - Ask the agent\n" +
        "/new - Start a fresh session\n" +
        "/sessions - List recent sessions\n" +
        "/resume [n] - Resume an older session\n" +
        "/fork [n] [prompt] - Fork a session with new context\n" +
        "/jobs - List scheduled jobs\n" +
        "/newjob - Create a new job\n" +
        "/memory - View memory\n" +
        "/remember <fact> - Store a fact\n" +
        "/search <query> - Search knowledge\n" +
        "/browse <url> - Screenshot a URL\n" +
        "/save <url> - Save a URL to inbox\n" +
        "/model <name> - Switch model (opus/sonnet/haiku)\n" +
        "/status - Agent status"
    );
  }

  async function handleAsk(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const prompt = text.replace(/^\/ask\s*/i, "").trim();
    if (!prompt) {
      await replyMd2(ctx, "Usage: /ask <your question>");
      return;
    }
    await runAgent(ctx, prompt);
  }

  async function handlePlainText(ctx: Context): Promise<void> {
    const prompt = ctx.message?.text?.trim();
    if (!prompt) return;

    // Check if replying to a research message — inject context
    const replyMsg = ctx.message?.reply_to_message;
    if (replyMsg && "text" in replyMsg && replyMsg.text) {
      const match = replyMsg.text.match(/^Research: .+\nID: (\d+)/);
      if (match) {
        const itemId = Number(match[1]);
        const item = getPendingItemById(itemId);
        if (item) {
          const context = [
            `The user is asking about a recently researched item. Here is the context:`,
            ``,
            `Title: ${item.title ?? "Unknown"}`,
            `URL: ${item.url}`,
            `Description: ${item.description ?? "None"}`,
            `Research Summary: ${item.triage_summary ?? "None"}`,
            `NotePlan Note: ${item.noteplan_path ?? "None"}`,
            ``,
            `Previous research output:`,
            replyMsg.text.slice(0, 3000),
            ``,
            `User question: ${prompt}`,
          ].join("\n");
          await runAgent(ctx, context);
          return;
        }
      }
    }

    await runAgent(ctx, prompt);
  }

  async function runAgent(ctx: Context, prompt: string): Promise<void> {
    const config = getConfig();

    // Check queue capacity before sending "Thinking..."
    if (!taskQueue.hasCapacity && taskQueue.pendingCount > 0) {
      await replyMd2(ctx, `Queued (position ${taskQueue.pendingCount + 1}, ${taskQueue.activeCount} running)`);
    }

    const thinkingMsg = await replyMd2(ctx, "Thinking...");
    const sKey = sessionKey(ctx);
    const chatId = ctx.chat!.id;

    // Capture session state synchronously before returning
    let sessionId: string | undefined;
    if (resetChats.has(sKey)) {
      resetChats.delete(sKey);
      sessionId = undefined;
      log.info("Starting fresh session", { sessionKey: sKey });
    } else if (resumeOverrides.has(sKey)) {
      sessionId = resumeOverrides.get(sKey);
      log.info("Resuming overridden session", { sessionKey: sKey, sessionId });
    } else {
      sessionId = getLatestSessionId("telegram", sKey) ?? undefined;
    }
    bootedChats.add(sKey);
    const model = modelOverrides.get(sKey);
    const ctxChat = chatContext(ctx);

    // Fire-and-forget: enqueue the agent run and return immediately
    const taskId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    taskQueue.enqueue({
      id: taskId,
      label: `runAgent:${sKey}`,
      execute: async () => {
        const toolLines: string[] = [];
        let lastEditAt = 0;

        try {
          const result = await agent.run({
            prompt,
            source: "telegram",
            sourceId: sKey,
            sessionId,
            chatContext: ctxChat,
            useBrowser: true,
            ...(model ? { model } : {}),
            onToolUse: (toolName, input, subagent) => {
              if (!config.VERBOSE_FEEDBACK) return;
              toolLines.push(formatToolLine(toolName, input, subagent));
              const now = Date.now();
              if (now - lastEditAt >= 3000) {
                lastEditAt = now;
                editMd2(ctx, chatId, thinkingMsg.message_id,
                  `Thinking...\n${formatToolsSummary(toolLines)}`
                ).catch(() => {});
              }
            },
          });

          const meta = formatRunMeta(result, config.VERBOSE_FEEDBACK);
          const toolsBlock = config.VERBOSE_FEEDBACK && toolLines.length > 0
            ? `${formatToolsSummary(toolLines)}\n\n`
            : "";
          const modelTag = model ? `[${model}] ` : "";
          const response = `${toolsBlock}${modelTag}${result.result}\n\n${meta}`;
          const chunks = splitMessage(response);

          if (chunks.length === 1) {
            await editAgentMd2(ctx, chatId, thinkingMsg.message_id, chunks[0],
              { reply_markup: agentResponseKeyboard(result.sessionId) }
            );
          } else {
            await editAgentMd2(ctx, chatId, thinkingMsg.message_id, chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              const opts = i === chunks.length - 1
                ? { reply_markup: agentResponseKeyboard(result.sessionId) }
                : {};
              await replyAgentMd2(ctx, chunks[i], opts);
            }
          }
          if (agent.consumeRestart()) {
            executeDeferredRestart();
          }
        } catch (err) {
          log.error("Telegram agent error", { error: String(err) });
          await editMd2(ctx, chatId, thinkingMsg.message_id,
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      },
    });
  }

  async function handleJobs(ctx: Context): Promise<void> {
    const jobs = getAllJobs();
    if (jobs.length === 0) {
      await replyMd2(ctx, "No jobs configured. Use /newjob to create one.");
      return;
    }

    const lines = jobs.map(
      (j, i) => `${i + 1}. ${formatJobSummary(j)}`
    );
    await replyMd2(ctx, lines.join("\n"), {
      reply_markup: jobListKeyboard(jobs),
    });
  }

  async function handleNewJob(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/newjob\s*/i, "").trim();

    if (!args) {
      await replyMd2(ctx,
        "Usage: /newjob <name> | <cron_expression> | <prompt>\n\nExample:\n/newjob Daily Summary | 0 9 * * * | Summarize my latest notes"
      );
      return;
    }

    const parts = args.split("|").map((s) => s.trim());
    if (parts.length < 3) {
      await replyMd2(ctx, "Format: /newjob <name> | <schedule> | <prompt>");
      return;
    }

    const [name, schedule, ...promptParts] = parts;
    const prompt = promptParts.join(" | ");

    const job = createJob({
      name,
      prompt,
      type: "cron",
      schedule,
    });

    scheduler.reload();
    await replyMd2(ctx, `Job created: ${job.name} (ID: ${job.id})\nSchedule: ${schedule}`);
  }

  async function handleMemory(ctx: Context): Promise<void> {
    const content = memory.readMemory();
    if (!content.trim()) {
      await replyMd2(ctx, "Memory is empty.");
      return;
    }
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await replyMd2(ctx, chunk);
    }
  }

  async function handleRemember(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const fact = text.replace(/^\/remember\s*/i, "").trim();
    if (!fact) {
      await replyMd2(ctx, "Usage: /remember <fact to store>");
      return;
    }

    memory.appendToSection("Key Facts", `- ${fact}`);
    await replyMd2(ctx, `Remembered: ${fact}`);
  }

  async function handleSearch(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const query = text.replace(/^\/search\s*/i, "").trim();
    if (!query) {
      await replyMd2(ctx, "Usage: /search <query>");
      return;
    }

    const results = memory.search(query);
    if (results.length === 0) {
      await replyMd2(ctx, "No results found.");
      return;
    }

    const lines = results.map(
      (r) => `${r.path}: ${r.title}\n${r.snippet}`
    );
    const response = lines.join("\n\n");
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await replyMd2(ctx, chunk);
    }
  }

  async function handleBrowse(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const url = text.replace(/^\/browse\s*/i, "").trim();
    if (!url) {
      await replyMd2(ctx, "Usage: /browse <url>");
      return;
    }

    const msg = await replyMd2(ctx, "Taking screenshot...");

    try {
      const tmpPath = join(INBOUND_MEDIA_DIR, `screenshot-${Date.now()}.png`);
      mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });

      const proc = Bun.spawn(
        ["agent-browser", "open", url, "--wait", "networkidle"],
        { stdout: "pipe", stderr: "pipe" }
      );
      await proc.exited;

      const shotProc = Bun.spawn(
        ["agent-browser", "screenshot", tmpPath],
        { stdout: "pipe", stderr: "pipe" }
      );
      const shotStderr = await new Response(shotProc.stderr).text();
      const shotExit = await shotProc.exited;

      if (shotExit !== 0 || !existsSync(tmpPath)) {
        await editMd2(ctx, ctx.chat!.id, msg.message_id,
          `Screenshot failed: ${shotStderr.slice(0, 500) || "unknown error"}`
        );
        return;
      }

      const fileData = await Bun.file(tmpPath).arrayBuffer();
      await ctx.replyWithPhoto(new InputFile(new Uint8Array(fileData), "screenshot.png"));
    } catch (err) {
      await editMd2(ctx, ctx.chat!.id, msg.message_id,
        `Screenshot error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleNew(ctx: Context): Promise<void> {
    const sKey = sessionKey(ctx);
    resetChats.add(sKey);
    bootedChats.delete(sKey);
    resumeOverrides.delete(sKey);
    await replyMd2(ctx, "Session cleared. Next message starts a fresh conversation.");
  }

  const MODEL_ALIASES: Record<string, string> = {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-5-20250929",
    haiku: "claude-haiku-4-5-20251001",
  };

  async function handleModel(ctx: Context): Promise<void> {
    const config = getConfig();
    const sKey = sessionKey(ctx);
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/model\s*/i, "").trim().toLowerCase();

    if (!arg) {
      const current = modelOverrides.get(sKey) ?? config.DEFAULT_MODEL;
      modelOverrides.delete(sKey);
      const aliases = Object.entries(MODEL_ALIASES)
        .map(([k, v]) => `  ${k} -> ${v}`)
        .join("\n");
      await replyMd2(ctx,
        `Model reset to default: ${config.DEFAULT_MODEL}\n\nAliases:\n${aliases}\n\nUsage: /model <name or alias>`,
        { reply_markup: modelPickerKeyboard() }
      );
      return;
    }

    const resolved = MODEL_ALIASES[arg] ?? arg;
    modelOverrides.set(sKey, resolved);
    await replyMd2(ctx, `Model set to: ${resolved}\nUse /model with no args to reset to default.`);
  }

  async function handleStatus(ctx: Context): Promise<void> {
    const jobs = getAllJobs();
    const enabled = jobs.filter((j) => j.status === "enabled").length;
    const recentRuns = getRecentRuns(5);

    let status = `Agent Status\n`;
    status += `Active runs: ${agent.activeRunCount}\n`;
    status += `Jobs: ${enabled} enabled / ${jobs.length} total\n`;

    if (recentRuns.length > 0) {
      status += `\nRecent runs:\n`;
      for (const r of recentRuns) {
        const job = getJob(r.job_id);
        const cost = r.cost_usd ? formatCost(r.cost_usd) : "-";
        status += `  ${job?.name ?? `#${r.job_id}`}: ${r.status} (${cost})\n`;
      }
    }

    await replyMd2(ctx, status);
  }

  async function handleSave(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/save\s*/i, "").trim();

    if (!arg) {
      const count = getPendingItemCount("pending");
      await replyMd2(ctx, `Usage: /save <url> [description]\n\nInbox: ${count} pending items`);
      return;
    }

    // Extract URL (first token) and optional description (rest)
    const parts = arg.split(/\s+/);
    const url = parts[0];
    const description = parts.length > 1 ? parts.slice(1).join(" ") : undefined;

    // Basic URL validation
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      await replyMd2(ctx, "Please provide a valid URL starting with http:// or https://");
      return;
    }

    const item = insertPendingItem({
      url,
      description,
      source: "telegram",
      platform: new URL(url).hostname.replace("www.", ""),
      captured_at: new Date().toISOString(),
    });

    if (item) {
      const pending = getPendingItemCount("pending");
      await replyMd2(ctx, `Saved: ${item.title ?? url}\nInbox: ${pending} pending`);
    } else {
      await replyMd2(ctx, "Failed to save item (may already exist).");
    }
  }

  function formatSessionList(
    sessions: { session_id: string; source_id: string | null; label: string | null; message_count: number; total_cost_usd: number; updated_at: string }[],
    currentKey: string
  ): string {
    if (sessions.length === 0) return "No sessions found.";
    const lines = sessions.map((s, i) => {
      const preview = s.label ?? getSessionPreview(s.session_id) ?? "(empty)";
      const shortId = s.session_id.slice(0, 8);
      const cost = formatCost(s.total_cost_usd);
      const date = s.updated_at.split(" ")[0];
      const active = resumeOverrides.get(currentKey) === s.session_id ? " [active]" : "";
      return `${i + 1}. ${shortId} - ${preview}\n   ${date} | ${s.message_count} msgs | ${cost}${active}`;
    });
    return lines.join("\n\n");
  }

  function resolveSessionArg(
    arg: string,
    baseId: string
  ): { sessionId: string } | { error: string } {
    const sessions = getRecentSessionsBySourcePrefix("telegram", baseId, 10);
    if (sessions.length === 0) return { error: "No sessions found." };

    // Try numeric index first (1-based)
    const num = parseInt(arg, 10);
    if (!isNaN(num) && num >= 1 && num <= sessions.length) {
      return { sessionId: sessions[num - 1].session_id };
    }

    // Try prefix match on session_id
    const match = sessions.find((s) => s.session_id.startsWith(arg));
    if (match) return { sessionId: match.session_id };

    return { error: `No session matching "${arg}". Use /sessions to see available sessions.` };
  }

  async function handleSessions(ctx: Context): Promise<void> {
    const sKey = sessionKey(ctx);
    const baseId = baseChatId(ctx);
    const sessions = getRecentSessionsBySourcePrefix("telegram", baseId, 10);
    const header = "Recent sessions:\n\n";
    await replyMd2(ctx, header + formatSessionList(sessions, sKey), {
      reply_markup: sessionListKeyboard(sessions),
    });
  }

  async function handleResume(ctx: Context): Promise<void> {
    const sKey = sessionKey(ctx);
    const baseId = baseChatId(ctx);
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/resume\s*/i, "").trim();

    if (!arg) {
      const sessions = getRecentSessionsBySourcePrefix("telegram", baseId, 10);
      await replyMd2(ctx,
        "Usage: /resume <number or session id prefix>\n\n" +
        formatSessionList(sessions, sKey)
      );
      return;
    }

    const result = resolveSessionArg(arg, baseId);
    if ("error" in result) {
      await replyMd2(ctx, result.error);
      return;
    }

    resumeOverrides.set(sKey, result.sessionId);
    bootedChats.add(sKey);
    resetChats.delete(sKey);
    const preview = getSessionPreview(result.sessionId) ?? "(empty)";
    await replyMd2(ctx, `Resumed session ${result.sessionId.slice(0, 8)}: ${preview}\n\nNext messages will continue in this session. Use /new to start fresh.`);
  }

  async function handleFork(ctx: Context): Promise<void> {
    const sKey = sessionKey(ctx);
    const baseId = baseChatId(ctx);
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/fork\s*/i, "").trim();

    if (!args) {
      const sessions = getRecentSessionsBySourcePrefix("telegram", baseId, 10);
      await replyMd2(ctx,
        "Usage: /fork <number or id> [prompt]\n\n" +
        "Starts a new session with the prior conversation as context.\n\n" +
        formatSessionList(sessions, sKey)
      );
      return;
    }

    // Split: first token is session ref, rest is prompt
    const parts = args.split(/\s+/);
    const sessionArg = parts[0];
    const forkPrompt = parts.slice(1).join(" ") || "Continue from where this conversation left off.";

    const result = resolveSessionArg(sessionArg, baseId);
    if ("error" in result) {
      await replyMd2(ctx, result.error);
      return;
    }

    const messages = getMessagesBySession(result.sessionId);
    if (messages.length === 0) {
      await replyMd2(ctx, "That session has no messages to fork from.");
      return;
    }

    // Build context preamble from prior conversation (truncate from tail to 50k chars)
    const transcript = messages
      .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
      .join("\n\n");
    const maxChars = 50_000;
    const trimmed = transcript.length > maxChars
      ? "...\n" + transcript.slice(transcript.length - maxChars)
      : transcript;

    const preamble = `<prior_conversation session="${result.sessionId}">\n${trimmed}\n</prior_conversation>\n\n`;
    const fullPrompt = preamble + forkPrompt;

    // Force fresh session for the fork
    resetChats.add(sKey);
    bootedChats.delete(sKey);
    resumeOverrides.delete(sKey);

    await runAgent(ctx, fullPrompt);
  }

  const INBOUND_MEDIA_DIR = resolve(process.cwd(), "data", "media", "inbound");

  async function handlePhoto(ctx: Context): Promise<void> {
    const config = getConfig();
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    const thinkingMsg = await replyMd2(ctx, "Thinking...");
    const sKey = sessionKey(ctx);
    const caption = ctx.message?.caption ?? "";

    const toolLines: string[] = [];
    let lastEditAt = 0;

    try {
      mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });

      // Get the highest resolution photo (last in array)
      const photo = photos[photos.length - 1];
      const file = await ctx.api.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.status}`);
      }

      const ext = file.file_path?.split(".").pop() ?? "jpg";
      const localPath = join(INBOUND_MEDIA_DIR, `${Date.now()}.${ext}`);
      const buffer = await response.arrayBuffer();
      await Bun.write(localPath, buffer);

      log.info("Photo saved", { localPath, size: buffer.byteLength });

      const sessionId = getLatestSessionId("telegram", sKey) ?? undefined;
      const captionPart = caption ? `\n\nThe user included this caption: ${caption}` : "";
      const prompt = `The user sent a photo. The image file is saved at: ${localPath}${captionPart}\n\nAcknowledge receipt and respond to any caption or context.`;

      const result = await agent.run({
        prompt,
        source: "telegram",
        sourceId: sKey,
        sessionId,
        chatContext: chatContext(ctx),
        useBrowser: true,
        onToolUse: (toolName, input, subagent) => {
          if (!config.VERBOSE_FEEDBACK) return;
          toolLines.push(formatToolLine(toolName, input, subagent));
          const now = Date.now();
          if (now - lastEditAt >= 3000) {
            lastEditAt = now;
            editMd2(ctx, ctx.chat!.id, thinkingMsg.message_id,
              `Thinking...\n${formatToolsSummary(toolLines)}`
            ).catch(() => {});
          }
        },
      });

      const meta = formatRunMeta(result, config.VERBOSE_FEEDBACK);
      const toolsBlock = config.VERBOSE_FEEDBACK && toolLines.length > 0
        ? `${formatToolsSummary(toolLines)}\n\n`
        : "";
      const responseText = `${toolsBlock}${result.result}\n\n${meta}`;
      const chunks = splitMessage(responseText);

      if (chunks.length === 1) {
        await editAgentMd2(ctx, ctx.chat!.id, thinkingMsg.message_id, chunks[0],
          { reply_markup: agentResponseKeyboard(result.sessionId) }
        );
      } else {
        await editAgentMd2(ctx, ctx.chat!.id, thinkingMsg.message_id, chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          const opts = i === chunks.length - 1
            ? { reply_markup: agentResponseKeyboard(result.sessionId) }
            : {};
          await replyAgentMd2(ctx, chunks[i], opts);
        }
      }

      if (agent.consumeRestart()) {
        executeDeferredRestart();
      }
    } catch (err) {
      log.error("Photo message error", { error: String(err) });
      await editMd2(ctx, ctx.chat!.id, thinkingMsg.message_id,
        `Photo error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleVoice(ctx: Context): Promise<void> {
    const config = getConfig();
    const voice = ctx.message?.voice ?? ctx.message?.audio;
    if (!voice) return;

    const thinkingMsg = await replyMd2(ctx, "Transcribing voice message...");
    const sKey = sessionKey(ctx);

    try {
      mkdirSync(INBOUND_MEDIA_DIR, { recursive: true });

      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice file: ${response.status}`);
      }

      const ext = file.file_path?.split(".").pop() ?? "ogg";
      const localPath = join(INBOUND_MEDIA_DIR, `${Date.now()}.${ext}`);
      const buffer = await response.arrayBuffer();
      await Bun.write(localPath, buffer);

      log.info("Voice message saved", { localPath, size: buffer.byteLength });

      const sessionId = getLatestSessionId("telegram", sKey) ?? undefined;
      const prompt = `The user sent a voice message. The audio file is at: ${localPath}\n\nPlease transcribe it using the audio_transcribe tool, then respond to whatever they said.`;

      const result = await agent.run({
        prompt,
        source: "telegram",
        sourceId: sKey,
        sessionId,
        chatContext: chatContext(ctx),
        useBrowser: false,
      });

      const meta = formatRunMeta(result, config.VERBOSE_FEEDBACK);
      const responseText = `${result.result}\n\n${meta}`;
      const chunks = splitMessage(responseText);

      if (chunks.length === 1) {
        await editAgentMd2(ctx, ctx.chat!.id, thinkingMsg.message_id, chunks[0],
          { reply_markup: agentResponseKeyboard(result.sessionId) }
        );
      } else {
        await editAgentMd2(ctx, ctx.chat!.id, thinkingMsg.message_id, chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          const opts = i === chunks.length - 1
            ? { reply_markup: agentResponseKeyboard(result.sessionId) }
            : {};
          await replyAgentMd2(ctx, chunks[i], opts);
        }
      }

      if (agent.consumeRestart()) {
        executeDeferredRestart();
      }
    } catch (err) {
      log.error("Voice message error", { error: String(err) });
      await editMd2(ctx, ctx.chat!.id, thinkingMsg.message_id,
        `Voice message error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    handleStart,
    handleAsk,
    handlePlainText,
    handleJobs,
    handleNewJob,
    handleMemory,
    handleRemember,
    handleSearch,
    handleBrowse,
    handleNew,
    handleStatus,
    handlePhoto,
    handleVoice,
    handleSessions,
    handleResume,
    handleFork,
    handleModel,
    handleSave,
    handleResearch,
    runAgent,
    runQuickResearchById: async (ctx: Context, itemId: number) => {
      const item = getPendingItemById(itemId);
      if (!item) {
        await replyMd2(ctx, `Item ${itemId} not found.`);
        return;
      }
      await runQuickResearch(ctx, item);
    },
    runDeepResearchById: async (ctx: Context, itemId: number) => {
      const item = getPendingItemById(itemId);
      if (!item) {
        await replyMd2(ctx, `Item ${itemId} not found.`);
        return;
      }
      await runDeepResearch(ctx, item);
    },
  };

  async function handleResearch(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/research\s*/i, "").trim();

    if (!arg) {
      // Show recent triaged items to pick from
      const triaged = getPendingItems("triaged", 10);
      if (triaged.length === 0) {
        await replyMd2(ctx, "No triaged items. Use /research <url> or /research <id>");
        return;
      }
      const lines = triaged.map((item) => {
        const vt = item.value_type ?? item.category ?? "?";
        const title = item.title ?? item.url;
        return `${item.id}. [${vt}] P${item.priority ?? "?"} ${title}`;
      });
      await replyMd2(ctx, `Pick an item:\n\n${lines.join("\n")}\n\n/research <id> — quick scan\n/research deep <id> — full deep dive`);
      return;
    }

    // Check for "deep" prefix
    const isDeep = arg.startsWith("deep ");
    const resolvedArg = isDeep ? arg.replace(/^deep\s+/, "") : arg;

    // Find the item — by ID or URL
    let item = null;
    const asId = Number(resolvedArg);
    if (Number.isFinite(asId) && asId > 0) {
      item = getPendingItemById(asId);
    }

    if (!item && (resolvedArg.startsWith("http://") || resolvedArg.startsWith("https://"))) {
      item = insertPendingItem({
        url: resolvedArg,
        source: "telegram",
        platform: new URL(resolvedArg).hostname.replace("www.", ""),
        captured_at: new Date().toISOString(),
      });
    }

    if (!item) {
      await replyMd2(ctx, "Item not found. Use /research <id> or /research <url>");
      return;
    }

    if (isDeep) {
      await runDeepResearch(ctx, item);
    } else {
      await runQuickResearch(ctx, item);
    }
  }

  async function runQuickResearch(ctx: Context, item: NonNullable<ReturnType<typeof getPendingItemById>>): Promise<void> {
    const statusMsg = await replyMd2(ctx, `Scanning: ${item.title ?? item.url}...`);
    const chatId = ctx.chat!.id;

    const taskId = `quick-research-${item.id}-${Date.now()}`;
    taskQueue.enqueue({
      id: taskId,
      label: `quickResearch:${item.id}`,
      execute: async () => {
        try {
          const prelim = await preliminaryResearch(item);
          const notePath = createResearchNote(item, prelim);

          updatePendingItem(item.id, {
            status: "archived",
            auto_decision: "quick_research_done",
            quick_scan_summary: prelim.summary,
            noteplan_path: notePath,
          });

          const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const noteFile = notePath ? notePath.split("/").pop() : null;

          const result = [
            `<b>Quick Scan done:</b> ${esc(prelim.title)}`,
            noteFile ? `Saved to ${esc(noteFile)}` : "",
          ].filter(Boolean).join("\n");

          const kb = new InlineKeyboard()
            .text("Deep Dive", `rds:${item.id}`)
            .text("Watch", `rw:${item.id}`)
            .text("Archive", `rx:${item.id}`);

          try {
            await ctx.api.deleteMessage(chatId, statusMsg.message_id);
          } catch { /* ignore */ }

          await ctx.api.sendMessage(chatId, result, {
            parse_mode: "HTML",
            reply_markup: kb,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await editMd2(ctx, chatId, statusMsg.message_id, `Quick scan failed: ${message}`);
        }
      },
    });
  }

  async function runDeepResearch(ctx: Context, item: NonNullable<ReturnType<typeof getPendingItemById>>): Promise<void> {
    const statusMsg = await replyMd2(ctx, `Deep research: ${item.title ?? item.url}\n\nThis may take a minute...`);
    const chatId = ctx.chat!.id;

    const taskId = `deep-research-${item.id}-${Date.now()}`;
    taskQueue.enqueue({
      id: taskId,
      label: `deepResearch:${item.id}`,
      execute: async () => {
        try {
          const deep = await deepResearch(item);
          const notePath = createResearchNote(item, deep);

          updatePendingItem(item.id, {
            status: "triaged",
            noteplan_path: notePath,
          });

          const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const noteFile = notePath ? notePath.split("/").pop() : null;

          const result = [
            `<b>Deep Research done:</b> ${esc(deep.title)}`,
            noteFile ? `Saved to ${esc(noteFile)}` : "",
          ].filter(Boolean).join("\n");

          const kb = new InlineKeyboard()
            .text("Watch", `rw:${item.id}`)
            .text("Archive", `rx:${item.id}`);

          try {
            await ctx.api.deleteMessage(chatId, statusMsg.message_id);
          } catch { /* ignore */ }

          await ctx.api.sendMessage(chatId, result, {
            parse_mode: "HTML",
            reply_markup: kb,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await editMd2(ctx, chatId, statusMsg.message_id, `Deep research failed: ${message}`);
        }
      },
    });
  }
}