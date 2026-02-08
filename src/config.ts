import { z } from "zod";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z
    .string()
    .transform((s) => s.split(",").map(Number))
    .pipe(z.array(z.number().int().positive())),
  PORT: z
    .string()
    .default("3000")
    .transform(Number)
    .pipe(z.number().int().positive()),
  HOST: z.string().default("0.0.0.0"),
  DEFAULT_MAX_BUDGET_USD: z
    .string()
    .default("1.00")
    .transform(Number)
    .pipe(z.number().positive()),
  DEFAULT_MODEL: z.string().default("claude-opus-4-6"),
  TAILSCALE_IP_PREFIX: z.string().default("100."),
  DB_PATH: z.string().default("./data/app.db"),
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
