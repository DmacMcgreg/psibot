import { InputFile, type Context } from "grammy";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { Scheduler } from "../scheduler/index.ts";
import {
  getAllJobs,
  createJob,
  getRecentRuns,
  getJob,
  getLatestSessionId,
} from "../db/queries.ts";
import {
  splitMessage,
  formatCost,
  formatDuration,
  formatJobSummary,
} from "./format.ts";
import { takeScreenshot } from "../browser/index.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("telegram:commands");

interface CommandDeps {
  agent: AgentService;
  memory: MemorySystem;
  scheduler: Scheduler;
}

export function registerCommands(deps: CommandDeps) {
  const { agent, memory, scheduler } = deps;

  async function handleStart(ctx: Context): Promise<void> {
    await ctx.reply(
      "Agent ready. Send me any message or use commands:\n\n" +
        "/ask <question> - Ask the agent\n" +
        "/jobs - List scheduled jobs\n" +
        "/newjob - Create a new job\n" +
        "/memory - View memory\n" +
        "/remember <fact> - Store a fact\n" +
        "/search <query> - Search knowledge\n" +
        "/browse <url> - Screenshot a URL\n" +
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
    const thinkingMsg = await ctx.reply("Thinking...");
    const chatId = String(ctx.chat?.id ?? "");

    try {
      const sessionId = getLatestSessionId("telegram", chatId) ?? undefined;
      const result = await agent.run({
        prompt,
        source: "telegram",
        sourceId: chatId,
        sessionId,
        useBrowser: true,
      });

      const response = `${result.result}\n\n${formatCost(result.costUsd)} / ${formatDuration(result.durationMs)}`;
      const chunks = splitMessage(response);

      // Edit the first thinking message
      await ctx.api.editMessageText(
        ctx.chat!.id,
        thinkingMsg.message_id,
        chunks[0]
      );

      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i]);
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
    await ctx.reply(lines.join("\n"));
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
      const screenshot = await takeScreenshot(url);
      if (screenshot) {
        await ctx.replyWithPhoto(new InputFile(new Uint8Array(screenshot), "screenshot.png"));
      } else {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          msg.message_id,
          "Could not take screenshot. The browser task may have failed."
        );
      }
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        msg.message_id,
        `Screenshot error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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

  const INBOUND_MEDIA_DIR = resolve(process.cwd(), "data", "media", "inbound");

  async function handleVoice(ctx: Context): Promise<void> {
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

      const responseText = `${result.result}\n\n${formatCost(result.costUsd)} / ${formatDuration(result.durationMs)}`;
      const chunks = splitMessage(responseText);

      await ctx.api.editMessageText(
        ctx.chat!.id,
        thinkingMsg.message_id,
        chunks[0]
      );

      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i]);
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
    handleStatus,
    handleVoice,
  };
}