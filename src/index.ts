import { loadConfig, getConfig } from "./config.ts";
import { initDb, closeDb } from "./db/index.ts";
import { MemorySystem } from "./memory/index.ts";
import { AgentService } from "./agent/index.ts";
import { JobExecutor } from "./scheduler/executor.ts";
import { Scheduler } from "./scheduler/index.ts";
import { createWebApp } from "./web/index.ts";
import { createTelegramBot } from "./telegram/index.ts";
import { createLogger } from "./shared/logger.ts";

const log = createLogger("main");

async function main() {
  // Load config and initialize database
  loadConfig();
  const config = getConfig();
  initDb();

  // Initialize core services
  const memory = new MemorySystem();
  memory.indexAll();

  // Use late-binding closures to break circular dependency:
  // agent needs scheduler callbacks, scheduler needs agent
  let scheduler: Scheduler;
  const agent = new AgentService({
    memory,
    reloadScheduler: () => scheduler.reload(),
    triggerJob: (jobId) => scheduler.trigger(jobId),
  });
  const executor = new JobExecutor(agent);
  scheduler = new Scheduler(executor);

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

  log.info(`Web server listening on http://${config.HOST}:${config.PORT}`);

  // Start scheduler
  scheduler.start();

  // Start Telegram bot
  const bot = createTelegramBot({ agent, memory, scheduler });

  // Wire up job completion notifications to Telegram
  executor.setNotifier(bot, config.ALLOWED_TELEGRAM_USER_IDS);

  bot.start({
    onStart: () => {
      log.info("Telegram bot started");
    },
  });

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");

    scheduler.stop();
    await bot.stop();
    server.stop(true);
    closeDb();

    log.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
