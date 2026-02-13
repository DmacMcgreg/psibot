import { InputFile, type Context } from "grammy";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { Scheduler } from "../scheduler/index.ts";
import type { ChatState } from "./state.ts";
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
  getSessionPreview,
  getMessagesBySession,
} from "../db/queries.ts";
import {
  splitMessage,
  formatCost,
  formatJobSummary,
  formatRunMeta,
  formatToolLine,
  formatToolsSummary,
} from "./format.ts";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("telegram:commands");

interface CommandDeps {
  agent: AgentService;
  memory: MemorySystem;
  scheduler: Scheduler;
  state: ChatState;
}

export function registerCommands(deps: CommandDeps) {
  const { agent, memory, scheduler, state } = deps;
  const { resetChats, bootedChats, resumeOverrides, modelOverrides } = state;

  async function handleStart(ctx: Context): Promise<void> {
    await ctx.reply(
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
        "/model <name> - Switch model (opus/sonnet/haiku)\n" +
        "/status - Agent status"
    );
  }

  async function handleAsk(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const prompt = text.replace(/^\/ask\s*/i, "").trim();
    if (!prompt) {
      await ctx.reply("Usage: /ask <your question>");
      return;
    }
    await runAgent(ctx, prompt);
  }

  async function handlePlainText(ctx: Context): Promise<void> {
    const prompt = ctx.message?.text?.trim();
    if (!prompt) return;
    await runAgent(ctx, prompt);
  }

  async function runAgent(ctx: Context, prompt: string): Promise<void> {
    const config = getConfig();
    const thinkingMsg = await ctx.reply("Thinking...");
    const chatId = String(ctx.chat?.id ?? "");

    const toolLines: string[] = [];
    let lastEditAt = 0;

    try {
      // Start fresh session on boot or after /new, then resume normally
      let sessionId: string | undefined;
      if (resetChats.has(chatId) || !bootedChats.has(chatId)) {
        resetChats.delete(chatId);
        bootedChats.add(chatId);
        sessionId = undefined;
        log.info("Starting fresh session", { chatId, reason: resetChats.has(chatId) ? "reset" : "boot" });
      } else if (resumeOverrides.has(chatId)) {
        sessionId = resumeOverrides.get(chatId);
        log.info("Resuming overridden session", { chatId, sessionId });
      } else {
        sessionId = getLatestSessionId("telegram", chatId) ?? undefined;
      }

      const model = modelOverrides.get(chatId);

      const result = await agent.run({
        prompt,
        source: "telegram",
        sourceId: chatId,
        sessionId,
        useBrowser: true,
        ...(model ? { model } : {}),
        onToolUse: (toolName, input, subagent) => {
          if (!config.VERBOSE_FEEDBACK) return;
          toolLines.push(formatToolLine(toolName, input, subagent));
          const now = Date.now();
          if (now - lastEditAt >= 3000) {
            lastEditAt = now;
            ctx.api.editMessageText(
              ctx.chat!.id,
              thinkingMsg.message_id,
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

      // Edit the first thinking message
      if (chunks.length === 1) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          chunks[0],
          { reply_markup: agentResponseKeyboard(result.sessionId) }
        );
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          chunks[0]
        );
        // Send remaining chunks, keyboard on last
        for (let i = 1; i < chunks.length; i++) {
          const opts = i === chunks.length - 1
            ? { reply_markup: agentResponseKeyboard(result.sessionId) }
            : {};
          await ctx.reply(chunks[i], opts);
        }
      }
    } catch (err) {
      log.error("Telegram agent error", { error: String(err) });
      await ctx.api.editMessageText(
        ctx.chat!.id,
        thinkingMsg.message_id,
        `Error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleJobs(ctx: Context): Promise<void> {
    const jobs = getAllJobs();
    if (jobs.length === 0) {
      await ctx.reply("No jobs configured. Use /newjob to create one.");
      return;
    }

    const lines = jobs.map(
      (j, i) => `${i + 1}. ${formatJobSummary(j)}`
    );
    await ctx.reply(lines.join("\n"), {
      reply_markup: jobListKeyboard(jobs),
    });
  }

  async function handleNewJob(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/newjob\s*/i, "").trim();

    if (!args) {
      await ctx.reply(
        "Usage: /newjob <name> | <cron_expression> | <prompt>\n\nExample:\n/newjob Daily Summary | 0 9 * * * | Summarize my latest notes"
      );
      return;
    }

    const parts = args.split("|").map((s) => s.trim());
    if (parts.length < 3) {
      await ctx.reply("Format: /newjob <name> | <schedule> | <prompt>");
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
    await ctx.reply(`Job created: ${job.name} (ID: ${job.id})\nSchedule: ${schedule}`);
  }

  async function handleMemory(ctx: Context): Promise<void> {
    const content = memory.readMemory();
    if (!content.trim()) {
      await ctx.reply("Memory is empty.");
      return;
    }
    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }

  async function handleRemember(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const fact = text.replace(/^\/remember\s*/i, "").trim();
    if (!fact) {
      await ctx.reply("Usage: /remember <fact to store>");
      return;
    }

    memory.appendToSection("Key Facts", `- ${fact}`);
    await ctx.reply(`Remembered: ${fact}`);
  }

  async function handleSearch(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const query = text.replace(/^\/search\s*/i, "").trim();
    if (!query) {
      await ctx.reply("Usage: /search <query>");
      return;
    }

    const results = memory.search(query);
    if (results.length === 0) {
      await ctx.reply("No results found.");
      return;
    }

    const lines = results.map(
      (r) => `${r.path}: ${r.title}\n${r.snippet}`
    );
    const response = lines.join("\n\n");
    const chunks = splitMessage(response);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  }

  async function handleBrowse(ctx: Context): Promise<void> {
    const text = ctx.message?.text ?? "";
    const url = text.replace(/^\/browse\s*/i, "").trim();
    if (!url) {
      await ctx.reply("Usage: /browse <url>");
      return;
    }

    const msg = await ctx.reply("Taking screenshot...");

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
        await ctx.api.editMessageText(
          ctx.chat!.id,
          msg.message_id,
          `Screenshot failed: ${shotStderr.slice(0, 500) || "unknown error"}`
        );
        return;
      }

      const fileData = await Bun.file(tmpPath).arrayBuffer();
      await ctx.replyWithPhoto(new InputFile(new Uint8Array(fileData), "screenshot.png"));
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msg.message_id,
        `Screenshot error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleNew(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id ?? "");
    resetChats.add(chatId);
    bootedChats.delete(chatId);
    resumeOverrides.delete(chatId);
    await ctx.reply("Session cleared. Next message starts a fresh conversation.");
  }

  const MODEL_ALIASES: Record<string, string> = {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-5-20250929",
    haiku: "claude-haiku-4-5-20251001",
  };

  async function handleModel(ctx: Context): Promise<void> {
    const config = getConfig();
    const chatId = String(ctx.chat?.id ?? "");
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/model\s*/i, "").trim().toLowerCase();

    if (!arg) {
      const current = modelOverrides.get(chatId) ?? config.DEFAULT_MODEL;
      modelOverrides.delete(chatId);
      const aliases = Object.entries(MODEL_ALIASES)
        .map(([k, v]) => `  ${k} -> ${v}`)
        .join("\n");
      await ctx.reply(
        `Model reset to default: ${config.DEFAULT_MODEL}\n\nAliases:\n${aliases}\n\nUsage: /model <name or alias>`,
        { reply_markup: modelPickerKeyboard() }
      );
      return;
    }

    const resolved = MODEL_ALIASES[arg] ?? arg;
    modelOverrides.set(chatId, resolved);
    await ctx.reply(`Model set to: ${resolved}\nUse /model with no args to reset to default.`);
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

    await ctx.reply(status);
  }

  function formatSessionList(
    sessions: { session_id: string; label: string | null; message_count: number; total_cost_usd: number; updated_at: string }[],
    chatId: string
  ): string {
    if (sessions.length === 0) return "No sessions found.";
    const lines = sessions.map((s, i) => {
      const preview = s.label ?? getSessionPreview(s.session_id) ?? "(empty)";
      const shortId = s.session_id.slice(0, 8);
      const cost = formatCost(s.total_cost_usd);
      const date = s.updated_at.split(" ")[0];
      const active = resumeOverrides.get(chatId) === s.session_id ? " [active]" : "";
      return `${i + 1}. ${shortId} - ${preview}\n   ${date} | ${s.message_count} msgs | ${cost}${active}`;
    });
    return lines.join("\n\n");
  }

  function resolveSessionArg(
    arg: string,
    chatId: string
  ): { sessionId: string } | { error: string } {
    const sessions = getRecentSessions("telegram", chatId, 10);
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
    const chatId = String(ctx.chat?.id ?? "");
    const sessions = getRecentSessions("telegram", chatId, 10);
    const header = "Recent sessions:\n\n";
    await ctx.reply(header + formatSessionList(sessions, chatId), {
      reply_markup: sessionListKeyboard(sessions),
    });
  }

  async function handleResume(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id ?? "");
    const text = ctx.message?.text ?? "";
    const arg = text.replace(/^\/resume\s*/i, "").trim();

    if (!arg) {
      const sessions = getRecentSessions("telegram", chatId, 10);
      await ctx.reply(
        "Usage: /resume <number or session id prefix>\n\n" +
        formatSessionList(sessions, chatId)
      );
      return;
    }

    const result = resolveSessionArg(arg, chatId);
    if ("error" in result) {
      await ctx.reply(result.error);
      return;
    }

    resumeOverrides.set(chatId, result.sessionId);
    bootedChats.add(chatId);
    resetChats.delete(chatId);
    const preview = getSessionPreview(result.sessionId) ?? "(empty)";
    await ctx.reply(`Resumed session ${result.sessionId.slice(0, 8)}: ${preview}\n\nNext messages will continue in this session. Use /new to start fresh.`);
  }

  async function handleFork(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id ?? "");
    const text = ctx.message?.text ?? "";
    const args = text.replace(/^\/fork\s*/i, "").trim();

    if (!args) {
      const sessions = getRecentSessions("telegram", chatId, 10);
      await ctx.reply(
        "Usage: /fork <number or id> [prompt]\n\n" +
        "Starts a new session with the prior conversation as context.\n\n" +
        formatSessionList(sessions, chatId)
      );
      return;
    }

    // Split: first token is session ref, rest is prompt
    const parts = args.split(/\s+/);
    const sessionArg = parts[0];
    const forkPrompt = parts.slice(1).join(" ") || "Continue from where this conversation left off.";

    const result = resolveSessionArg(sessionArg, chatId);
    if ("error" in result) {
      await ctx.reply(result.error);
      return;
    }

    const messages = getMessagesBySession(result.sessionId);
    if (messages.length === 0) {
      await ctx.reply("That session has no messages to fork from.");
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
    resetChats.add(chatId);
    bootedChats.delete(chatId);
    resumeOverrides.delete(chatId);

    await runAgent(ctx, fullPrompt);
  }

  const INBOUND_MEDIA_DIR = resolve(process.cwd(), "data", "media", "inbound");

  async function handlePhoto(ctx: Context): Promise<void> {
    const config = getConfig();
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    const thinkingMsg = await ctx.reply("Thinking...");
    const chatId = String(ctx.chat?.id ?? "");
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

      const sessionId = getLatestSessionId("telegram", chatId) ?? undefined;
      const captionPart = caption ? `\n\nThe user included this caption: ${caption}` : "";
      const prompt = `The user sent a photo. The image file is saved at: ${localPath}${captionPart}\n\nAcknowledge receipt and respond to any caption or context.`;

      const result = await agent.run({
        prompt,
        source: "telegram",
        sourceId: chatId,
        sessionId,
        useBrowser: true,
        onToolUse: (toolName, input, subagent) => {
          if (!config.VERBOSE_FEEDBACK) return;
          toolLines.push(formatToolLine(toolName, input, subagent));
          const now = Date.now();
          if (now - lastEditAt >= 3000) {
            lastEditAt = now;
            ctx.api.editMessageText(
              ctx.chat!.id,
              thinkingMsg.message_id,
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
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          chunks[0],
          { reply_markup: agentResponseKeyboard(result.sessionId) }
        );
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          chunks[0]
        );
        for (let i = 1; i < chunks.length; i++) {
          const opts = i === chunks.length - 1
            ? { reply_markup: agentResponseKeyboard(result.sessionId) }
            : {};
          await ctx.reply(chunks[i], opts);
        }
      }
    } catch (err) {
      log.error("Photo message error", { error: String(err) });
      await ctx.api.editMessageText(
        ctx.chat!.id,
        thinkingMsg.message_id,
        `Photo error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleVoice(ctx: Context): Promise<void> {
    const config = getConfig();
    const voice = ctx.message?.voice ?? ctx.message?.audio;
    if (!voice) return;

    const thinkingMsg = await ctx.reply("Transcribing voice message...");
    const chatId = String(ctx.chat?.id ?? "");

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

      const sessionId = getLatestSessionId("telegram", chatId) ?? undefined;
      const prompt = `The user sent a voice message. The audio file is at: ${localPath}\n\nPlease transcribe it using the audio_transcribe tool, then respond to whatever they said.`;

      const result = await agent.run({
        prompt,
        source: "telegram",
        sourceId: chatId,
        sessionId,
        useBrowser: false,
      });

      const meta = formatRunMeta(result, config.VERBOSE_FEEDBACK);
      const responseText = `${result.result}\n\n${meta}`;
      const chunks = splitMessage(responseText);

      if (chunks.length === 1) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          chunks[0],
          { reply_markup: agentResponseKeyboard(result.sessionId) }
        );
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          thinkingMsg.message_id,
          chunks[0]
        );
        for (let i = 1; i < chunks.length; i++) {
          const opts = i === chunks.length - 1
            ? { reply_markup: agentResponseKeyboard(result.sessionId) }
            : {};
          await ctx.reply(chunks[i], opts);
        }
      }
    } catch (err) {
      log.error("Voice message error", { error: String(err) });
      await ctx.api.editMessageText(
        ctx.chat!.id,
        thinkingMsg.message_id,
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
    runAgent,
  };
}