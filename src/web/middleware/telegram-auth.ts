import type { MiddlewareHandler } from "hono";
import { getConfig } from "../../config.ts";
import { createLogger } from "../../shared/logger.ts";

const log = createLogger("web:telegram-auth");

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramAuthContext {
  telegramUser: TelegramUser;
}

/**
 * Validates Telegram Mini App initData per spec:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export async function validateInitData(
  raw: string,
  botToken: string,
  maxAgeMs: number = 3_600_000
): Promise<TelegramUser | null> {
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");
    // Sort params alphabetically by key
    const sorted = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // HMAC-SHA256 validation
    const encoder = new TextEncoder();
    const secretKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode("WebAppData"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));
    const dataKey = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", dataKey, encoder.encode(sorted));
    const computed = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    if (computed !== hash) {
      log.warn("Invalid initData hash");
      return null;
    }

    // Check auth_date expiry
    const authDate = params.get("auth_date");
    if (authDate) {
      const age = Date.now() - parseInt(authDate, 10) * 1000;
      if (age > maxAgeMs) {
        log.warn("Expired initData", { age });
        return null;
      }
    }

    // Parse user data
    const userStr = params.get("user");
    if (!userStr) return null;
    return JSON.parse(userStr) as TelegramUser;
  } catch (err) {
    log.error("initData validation error", { error: String(err) });
    return null;
  }
}

export function telegramAuthMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const config = getConfig();
    const initData = c.req.header("x-telegram-init-data");

    if (!initData) {
      return c.text("Missing Telegram auth", 401);
    }

    const user = await validateInitData(initData, config.TELEGRAM_BOT_TOKEN);
    if (!user) {
      return c.text("Invalid Telegram auth", 401);
    }

    // Check against allowed user IDs
    if (!config.ALLOWED_TELEGRAM_USER_IDS.includes(user.id)) {
      log.warn("Unauthorized Mini App user", { userId: user.id });
      return c.text("Unauthorized", 403);
    }

    c.set("telegramUser" as never, user);
    await next();
  };
}
