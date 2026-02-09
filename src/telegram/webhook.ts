import { Hono } from "hono";
import { webhookCallback } from "grammy";
import type { Bot } from "grammy";
import type { Config } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import type { Server } from "bun";

const log = createLogger("webhook");

// Telegram's server IP ranges (IPv4 CIDR blocks)
const TELEGRAM_CIDRS = [
  { base: ipToNum("149.154.160.0"), mask: 0xfffff000 }, // /20
  { base: ipToNum("91.108.4.0"), mask: 0xfffffc00 }, // /22
];

function ipToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isTelegramIp(ip: string): boolean {
  // Allow localhost and Tailscale IPs (Funnel proxy delivers from tailscaled)
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("100.")) return true;

  const num = ipToNum(ip);
  return TELEGRAM_CIDRS.some((cidr) => (num & cidr.mask) === cidr.base);
}

export async function startWebhookServer(
  bot: Bot,
  config: Config,
): Promise<Server<undefined>> {
  if (!config.TELEGRAM_WEBHOOK_HOST) {
    throw new Error(
      "TELEGRAM_WEBHOOK_HOST is required when TELEGRAM_WEBHOOK_ENABLED=true",
    );
  }

  const webhookPath = `/webhook/${config.TELEGRAM_WEBHOOK_PATH_SECRET}`;
  // Tailscale Funnel exposes on port 443 externally, proxying to our local port
  const webhookUrl = `https://${config.TELEGRAM_WEBHOOK_HOST}${webhookPath}`;

  const app = new Hono();

  // IP allowlist middleware
  // When behind Tailscale Funnel, requests arrive from the local tailscaled proxy (127.0.0.1).
  // X-Forwarded-For contains the original client IP from Tailscale's DERP infrastructure.
  app.use("*", async (c, next) => {
    const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = forwardedFor ?? c.req.header("x-real-ip") ?? "127.0.0.1";

    // Allow localhost (Tailscale Funnel proxy) and Telegram's IP ranges
    if (!isTelegramIp(ip)) {
      log.warn("Blocked webhook request from non-Telegram IP", { ip });
      return c.notFound();
    }

    await next();
  });

  // Webhook endpoint -- grammy validates the secret token header
  const handler = webhookCallback(bot, "hono", {
    secretToken: config.TELEGRAM_WEBHOOK_SECRET,
  });
  app.post(webhookPath, handler);

  // Everything else returns 404
  app.all("*", (c) => c.notFound());

  const server = Bun.serve({
    port: config.TELEGRAM_WEBHOOK_PORT,
    hostname: "0.0.0.0",
    fetch: app.fetch,
  });

  // Register webhook with Telegram (retry for DNS propagation / transient failures)
  const maxAttempts = 10;
  const baseDelayMs = 5_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await bot.api.setWebhook(webhookUrl, {
        secret_token: config.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [
          "message",
          "edited_message",
          "callback_query",
        ],
      });
      break;
    } catch (err) {
      const isLastAttempt = attempt === maxAttempts;
      const delay = baseDelayMs * attempt;
      log.warn(`setWebhook attempt ${attempt}/${maxAttempts} failed`, {
        error: String(err),
        ...(isLastAttempt ? {} : { retryInMs: delay }),
      });
      if (isLastAttempt) throw err;
      await Bun.sleep(delay);
    }
  }

  log.info("Webhook server started", {
    port: config.TELEGRAM_WEBHOOK_PORT,
    path: webhookPath,
    url: webhookUrl,
  });

  return server;
}

export async function stopWebhookServer(
  bot: Bot,
  server: Server<undefined>,
): Promise<void> {
  try {
    await bot.api.deleteWebhook();
    log.info("Webhook deregistered from Telegram");
  } catch (err) {
    log.error("Failed to deregister webhook", { error: String(err) });
  }
  server.stop(true);
  log.info("Webhook server stopped");
}
