import { z } from "zod";
import { join } from "node:path";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z
    .string()
    .transform((s) => s.split(",").map(Number))
    .pipe(z.array(z.number().int().positive())),
  PORT: z
    .string()
    .default("3141")
    .transform(Number)
    .pipe(z.number().int().positive()),
  HOST: z.string().default("0.0.0.0"),
  DEFAULT_MAX_BUDGET_USD: z
    .string()
    .default("20.00")
    .transform(Number)
    .pipe(z.number().positive()),
  DEFAULT_MODEL: z.string().default("claude-opus-4-6"),
  TAILSCALE_IP_PREFIX: z.string().default("100."),
  DB_PATH: z.string().default("./data/app.db"),
  HEARTBEAT_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s === "true"),
  HEARTBEAT_INTERVAL_MINUTES: z
    .string()
    .default("30")
    .transform(Number)
    .pipe(z.number().int().positive()),
  HEARTBEAT_QUIET_START: z
    .string()
    .default("23")
    .transform(Number)
    .pipe(z.number().int().min(0).max(23)),
  HEARTBEAT_QUIET_END: z
    .string()
    .default("8")
    .transform(Number)
    .pipe(z.number().int().min(0).max(23)),
  HEARTBEAT_MAX_BUDGET_USD: z
    .string()
    .default("0.50")
    .transform(Number)
    .pipe(z.number().positive()),
  PSIBOT_DIR: z
    .string()
    .default(join(process.env.HOME ?? "/tmp", ".psibot")),
  TELEGRAM_WEBHOOK_ENABLED: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  TELEGRAM_WEBHOOK_HOST: z.string().default(""),
  TELEGRAM_WEBHOOK_PORT: z
    .string()
    .default("8443")
    .transform(Number)
    .pipe(z.number().int().positive()),
  TELEGRAM_WEBHOOK_SECRET: z
    .string()
    .default("")
    .transform((s) =>
      s || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
    ),
  TELEGRAM_WEBHOOK_PATH_SECRET: z
    .string()
    .default("")
    .transform((s) =>
      s || crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
    ),
  VERBOSE_FEEDBACK: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
  YOUTUBE_CLIENT_ID: z.string().default(""),
  YOUTUBE_CLIENT_SECRET: z.string().default(""),
  YOUTUBE_SOURCE_PLAYLIST_ID: z.string().default(""),
  YOUTUBE_DESTINATION_PLAYLIST_ID: z.string().default(""),
  YOUTUBE_ANALYSIS_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
});

export type Config = z.infer<typeof envSchema>;

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${missing}`);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
