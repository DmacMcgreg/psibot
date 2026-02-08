import { Bot } from "grammy";
import { getConfig } from "../config.ts";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { Scheduler } from "../scheduler/index.ts";
import { registerCommands } from "./commands.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("telegram");

interface TelegramDeps {
  agent: AgentService;
  memory: MemorySystem;
  scheduler: Scheduler;
}

export function createTelegramBot(deps: TelegramDeps) {
  const config = getConfig();
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

  // Auth middleware: only allow configured user IDs
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.ALLOWED_TELEGRAM_USER_IDS.includes(userId)) {
      log.warn("Unauthorized Telegram user", { userId });
      await ctx.reply("Unauthorized.");
      return;
    }
    await next();
  });

  const commands = registerCommands(deps);

  bot.command("start", commands.handleStart);
  bot.command("ask", commands.handleAsk);
  bot.command("jobs", commands.handleJobs);
  bot.command("newjob", commands.handleNewJob);
  bot.command("memory", commands.handleMemory);
  bot.command("remember", commands.handleRemember);
  bot.command("search", commands.handleSearch);
  bot.command("browse", commands.handleBrowse);
  bot.command("status", commands.handleStatus);

  // Voice and audio messages
  bot.on("message:voice", commands.handleVoice);
  bot.on("message:audio", commands.handleVoice);

  // Plain text messages go to agent
  bot.on("message:text", commands.handlePlainText);

  bot.catch((err) => {
    log.error("Telegram bot error", { error: String(err.error) });
  });

  return bot;
}
