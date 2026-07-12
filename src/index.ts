import { loadConfig, getConfig } from "./config.ts";
import { initDb, closeDb } from "./db/index.ts";
import { MemorySystem } from "./memory/index.ts";
import { AgentService } from "./agent/index.ts";
import { seedBuiltinAgents } from "./agent/subagents.ts";
import { JobExecutor } from "./scheduler/executor.ts";
import { Scheduler } from "./scheduler/index.ts";
import { HeartbeatRunner } from "./heartbeat/index.ts";
import { SynthesisRunner } from "./atlas/runner.ts";
import { DiscoveryRunner } from "./discovery/index.ts";
import { DigestRunner } from "./digest/index.ts";
import { createWebApp } from "./web/index.ts";
import { createTelegramBot } from "./telegram/index.ts";
import { startWebhookServer, stopWebhookServer } from "./telegram/webhook.ts";
import { TaskQueue } from "./shared/task-queue.ts";
import { createLogger } from "./shared/logger.ts";
import { writePid, removePid } from "./cli/pid.ts";
import type { Bot } from "grammy";
import type { Server } from "bun";

const log = createLogger("main");

async function main() {
  // Load config and initialize database
  loadConfig();
  const config = getConfig();
  initDb();

  // Initialize core services
  const memory = new MemorySystem();
  memory.indexAll();

  // Seed built-in agent rows (idempotent — updates code-owned fields, preserves user edits)
  seedBuiltinAgents();

  // Use late-binding closures to break circular dependency:
  // agent needs scheduler callbacks + bot reference, scheduler needs agent
  let scheduler: Scheduler;
  let bot: Bot;
  let discovery: DiscoveryRunner | null = null;
  const agent = new AgentService({
    memory,
    reloadScheduler: () => scheduler.reload(),
    triggerJob: (jobId) => scheduler.trigger(jobId),
    getBot: () => bot ?? null,
    defaultChatIds: config.ALLOWED_TELEGRAM_USER_IDS,
    groupChatIds: config.TELEGRAM_GROUP_CHAT_IDS,
    psibotDir: config.PSIBOT_DIR,
    scheduleRestart: () => agent.scheduleRestart(),
    getDiscoveryRunner: () => discovery,
  });
  const executor = new JobExecutor(agent);
  scheduler = new Scheduler(executor);
  const taskQueue = new TaskQueue(10);

  // Create web app
  const app = createWebApp({
    agent,
    memory,
    triggerJob: (jobId) => scheduler.trigger(jobId),
    reloadScheduler: () => scheduler.reload(),
  });

  // Start web server
  const server = Bun.serve({
    port: config.PORT,
    hostname: config.HOST,
    idleTimeout: 255,
    fetch: app.fetch,
  });

  writePid(process.pid);
  log.info(`Web server listening on http://${config.HOST}:${config.PORT}`);

  // Start scheduler
  scheduler.start();

  // Start Telegram bot
  bot = createTelegramBot({ agent, memory, scheduler, taskQueue });

  // Wire up job completion notifications to Telegram
  executor.setNotifier(bot, config.ALLOWED_TELEGRAM_USER_IDS);

  let webhookServer: Server<undefined> | undefined;
  if (config.TELEGRAM_WEBHOOK_ENABLED) {
    // Webhook mode: initialize bot info without polling, start webhook server
    await bot.init();
    webhookServer = await startWebhookServer(bot, config);
    log.info("Telegram bot started (webhook mode)");
  } else {
    // Polling mode: blocking long-poll connection to Telegram
    bot.start({
      onStart: () => {
        log.info("Telegram bot started (polling mode)");
      },
    });
  }

  // Start heartbeat system
  let heartbeat: HeartbeatRunner | null = null;
  if (config.HEARTBEAT_ENABLED) {
    heartbeat = new HeartbeatRunner({
      getBot: () => bot ?? null,
      defaultChatIds: config.ALLOWED_TELEGRAM_USER_IDS,
      digestChatId: config.TELEGRAM_GROUP_CHAT_IDS.length > 0
        ? String(config.TELEGRAM_GROUP_CHAT_IDS[0])
        : undefined,
      digestTopicId: 49, // News topic
      memory,
      agent,
      config: {
        intervalMinutes: config.HEARTBEAT_INTERVAL_MINUTES,
        fleetPreludeIntervalMinutes: config.FLEET_PRELUDE_INTERVAL_MINUTES,
        quietStart: config.HEARTBEAT_QUIET_START,
        quietEnd: config.HEARTBEAT_QUIET_END,
      },
    });
    heartbeat.start();
    log.info("Heartbeat system started", {
      intervalMinutes: config.HEARTBEAT_INTERVAL_MINUTES,
      fleetPreludeIntervalMinutes: config.FLEET_PRELUDE_INTERVAL_MINUTES,
      quietHours: `${config.HEARTBEAT_QUIET_START}:00-${config.HEARTBEAT_QUIET_END}:00`,
    });
  }

  // Start Atlas synthesis runner (daily / weekly / monthly)
  const groupChatId = config.TELEGRAM_GROUP_CHAT_IDS.length > 0
    ? String(config.TELEGRAM_GROUP_CHAT_IDS[0])
    : undefined;
  const synthesis = new SynthesisRunner({
    getBot: () => bot ?? null,
    defaultChatIds: config.ALLOWED_TELEGRAM_USER_IDS,
    memory,
    newsChatId: groupChatId,
    newsTopicId: 49,
    tradingChatId: groupChatId,
    tradingTopicId: 103,
  });
  synthesis.start();
  log.info("Atlas synthesis runner started");

  // Start weekly digest runner (reuses the same group-chat / News-topic config)
  const digest = new DigestRunner({
    getBot: () => bot ?? null,
    defaultChatIds: config.ALLOWED_TELEGRAM_USER_IDS,
    digestChatId: groupChatId,
    digestTopicId: 49, // News topic
  });
  digest.start();
  log.info("Weekly digest runner started");

  // Start proactive YouTube discovery runner (RSS fan-out + scoring + processing + news digest)
  if (config.DISCOVERY_ENABLED) {
    discovery = new DiscoveryRunner({
      getBot: () => bot ?? null,
      defaultChatIds: config.ALLOWED_TELEGRAM_USER_IDS,
      groupChatId,
      topicId: config.DISCOVERY_NEWS_TOPIC_ID || undefined,
    });
    discovery.start();
    log.info("Discovery runner started", { intervalHours: config.DISCOVERY_INTERVAL_HOURS });
  }

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");

    discovery?.stop();
    digest.stop();
    synthesis.stop();
    heartbeat?.stop();
    scheduler.stop();
    if (webhookServer) {
      await stopWebhookServer(bot, webhookServer);
    } else {
      await bot.stop();
    }
    server.stop(true);
    closeDb();

    removePid();
    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  removePid();
  process.exit(1);
});
