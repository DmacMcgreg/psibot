import { Bot } from "grammy";
import { getConfig } from "../config.ts";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { Scheduler } from "../scheduler/index.ts";
import { ChatState } from "./state.ts";
import { registerCommands } from "./commands.ts";
import { createCallbackHandler } from "./keyboards.ts";
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

  // Shared chat state between commands and callback handler
  const state = new ChatState();

  const commands = registerCommands({ ...deps, state });

  // Callback query handler (inline keyboard buttons) - must be registered before message handlers
  const callbackHandler = createCallbackHandler({
    agent: deps.agent,
    scheduler: deps.scheduler,
    state,
    runAgent: commands.runAgent,
  });
  bot.on("callback_query:data", callbackHandler);

  bot.command("start", commands.handleStart);
  bot.command("ask", commands.handleAsk);
  bot.command("jobs", commands.handleJobs);
  bot.command("newjob", commands.handleNewJob);
  bot.command("memory", commands.handleMemory);
  bot.command("remember", commands.handleRemember);
  bot.command("search", commands.handleSearch);
  bot.command("browse", commands.handleBrowse);
  bot.command("new", commands.handleNew);
  bot.command("clear", commands.handleNew);
  bot.command("sessions", commands.handleSessions);
  bot.command("resume", commands.handleResume);
  bot.command("fork", commands.handleFork);
  bot.command("status", commands.handleStatus);
  bot.command("model", commands.handleModel);

  // Voice and audio messages
  bot.on("message:voice", commands.handleVoice);
  bot.on("message:audio", commands.handleVoice);

  // Photo messages
  bot.on("message:photo", commands.handlePhoto);

  // Plain text messages go to agent
  bot.on("message:text", commands.handlePlainText);

  bot.catch((err) => {
    log.error("Telegram bot error", { error: String(err.error) });
  });

  // Register command menu (shown when user types "/" in chat)
  bot.api.setMyCommands([
    { command: "ask", description: "Ask the agent a question" },
    { command: "new", description: "Start a fresh session" },
    { command: "sessions", description: "List recent sessions" },
    { command: "resume", description: "Resume an older session" },
    { command: "fork", description: "Fork a session with new context" },
    { command: "jobs", description: "List scheduled jobs" },
    { command: "newjob", description: "Create a new job" },
    { command: "memory", description: "View agent memory" },
    { command: "remember", description: "Store a fact in memory" },
    { command: "search", description: "Search knowledge base" },
    { command: "browse", description: "Screenshot a URL" },
    { command: "model", description: "Switch model (opus/sonnet/haiku)" },
    { command: "status", description: "Agent status" },
  ]).catch((err) => log.error("Failed to set bot commands", { error: String(err) }));

  // Set Mini App menu button (Dashboard in Telegram)
  if (config.MINI_APP_ENABLED && config.TELEGRAM_WEBHOOK_HOST) {
    const miniAppUrl = `https://${config.TELEGRAM_WEBHOOK_HOST}/tma`;
    bot.api.setChatMenuButton({
      menu_button: { type: "web_app", text: "Dashboard", web_app: { url: miniAppUrl } },
    }).catch((err) => log.error("Failed to set menu button", { error: String(err) }));
  }

  return bot;
}
