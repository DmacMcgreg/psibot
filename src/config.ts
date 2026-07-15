import { z } from "zod";
import { join } from "node:path";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  ALLOWED_TELEGRAM_USER_IDS: z
    .string()
    .transform((s) => s.split(",").map(Number))
    .pipe(z.array(z.number().int().positive())),
  TELEGRAM_GROUP_CHAT_IDS: z
    .string()
    .default("")
    .transform((s) => (s ? s.split(",").map(Number) : []))
    .pipe(z.array(z.number().int())),
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
  DEFAULT_BACKEND: z.string().default("claude"),
  DEFAULT_MAX_TURNS: z
    .string()
    .default("300")
    .transform(Number)
    .pipe(z.number().int().positive()),
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
  FLEET_PRELUDE_INTERVAL_MINUTES: z
    .string()
    .default("3")
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
  HUB_FLEET_DB: z
    .string()
    .default(join(process.env.HOME ?? "/tmp", ".config/hub/fleet.db")),
  FLEET_POLL_MS_FALLBACK: z
    .string()
    .default("15000")
    .transform(Number)
    .pipe(z.number().int().positive()),
  FLEET_STALE_FACTOR: z
    .string()
    .default("2.5")
    .transform(Number)
    .pipe(z.number().positive()),
  FLEET_STALE_CONSECUTIVE: z
    .string()
    .default("3")
    .transform(Number)
    .pipe(z.number().int().positive()),
  FLEET_HUB_DOCTOR_TIMEOUT_MS: z
    .string()
    .default("5000")
    .transform(Number)
    .pipe(z.number().int().positive()),
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
  MINI_APP_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s === "true"),
  OAUTH_VAULT_URL: z.string().default(""),
  OAUTH_VAULT_API_KEY: z.string().default(""),
  YOUTUBE_SOURCE_PLAYLIST_ID: z.string().default(""),
  YOUTUBE_DESTINATION_PLAYLIST_ID: z.string().default(""),
  YOUTUBE_ANALYSIS_MODEL: z.string().default("sonnet"),
  REDDIT_FEED_TOKEN: z.string().default(""),
  REDDIT_USERNAME: z.string().default("FunnyRocker"),
  GITHUB_TOKEN: z.string().default(""),
  // GLM backend (separate AI plan for spreading workload off Claude Max quota)
  GLM_BASE_URL: z.string().default("https://api.z.ai/api/anthropic"),
  GLM_AUTH_TOKEN: z.string().default(""),
  GLM_HAIKU_MODEL: z.string().default("glm-4.7"),
  GLM_SONNET_MODEL: z.string().default("glm-5.2"),
  GLM_OPUS_MODEL: z.string().default("glm-5.1"),
  // Trading agents dashboard — endpoint that receives agent-run envelopes
  // from completed scheduled jobs. Empty string disables publishing.
  TRADING_BOT_URL: z.string().default("http://localhost:8000"),
  // Skill curator — periodic consolidation pass over agent-created skills.
  // See docs/plans/2026-05-04-hermes-port.md.
  CURATOR_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s === "true"),
  CURATOR_INTERVAL_HOURS: z
    .string()
    .default("168")
    .transform(Number)
    .pipe(z.number().int().positive()),
  CURATOR_MIN_IDLE_HOURS: z
    .string()
    .default("2")
    .transform(Number)
    .pipe(z.number().nonnegative()),
  CURATOR_STALE_AFTER_DAYS: z
    .string()
    .default("30")
    .transform(Number)
    .pipe(z.number().int().positive()),
  CURATOR_ARCHIVE_AFTER_DAYS: z
    .string()
    .default("90")
    .transform(Number)
    .pipe(z.number().int().positive()),
  CURATOR_MODEL: z.string().default("sonnet"),
  // Skill lifecycle — freshness score + HOT/COLD tiers + export seam.
  // See docs/plans/2026-07-03-skill-lifecycle-hub-integration.md.
  SKILL_SCORE_HALF_LIFE_DAYS: z
    .string()
    .default("21")
    .transform(Number)
    .pipe(z.number().positive()),
  // How many skills (beyond pinned) are listed in the system prompt.
  SKILL_HOT_SET_SIZE: z
    .string()
    .default("8")
    .transform(Number)
    .pipe(z.number().int().nonnegative()),
  // Promote to HOT at this score; demote below 0.7x (hysteresis, no flapping).
  SKILL_HOT_THRESHOLD: z
    .string()
    .default("0.3")
    .transform(Number)
    .pipe(z.number().positive()),
  // Auto-archive requires score below this AND >= CURATOR_ARCHIVE_AFTER_DAYS
  // idle since exposure (agent-created skills only).
  SKILL_ARCHIVE_SCORE_THRESHOLD: z
    .string()
    .default("0.05")
    .transform(Number)
    .pipe(z.number().positive()),
  // Export seam — where curator-approved skills sync to. The hub's
  // seed-paths script wraps this exact directory into provenance:"auto"
  // GoldenPaths, so anything placed here gets ingested with zero hub changes.
  SKILL_EXPORT_DIR: z.string().default("~/.claude/skills"),
  // Read-only cross-harness usage signal (local-mcp-hub telemetry sink).
  // Empty string disables. Never written, drift-checked, fail-soft.
  HUB_TELEMETRY_DB: z.string().default("~/.config/hub/telemetry.db"),
  // local-mcp-hub tool integration — wires the hub-edge binary as an external
  // stdio MCP server so the agent gets hub_search/hub_describe/hub_call,
  // vault_*, golden paths and mac_status. Off disables the wiring entirely;
  // if the binary is missing the wiring is silently skipped (fail-soft).
  HUB_MCP_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s === "true"),
  HUB_EDGE_BIN: z.string().default("~/.local/bin/hub-edge"),
  // --- Proactive YouTube Discovery ---
  // A self-contained runner that fans out from watch history to find + fully
  // process new videos and surface an interesting news/info digest. See
  // src/discovery/.
  DISCOVERY_ENABLED: z
    .string()
    .default("true")
    .transform((s) => s === "true"),
  DISCOVERY_INTERVAL_HOURS: z
    .string()
    .default("6")
    .transform(Number)
    .pipe(z.number().int().positive()),
  // Max videos to fully process (transcript -> analyze -> embed -> graph) per run.
  // Each costs one yt-dlp + one LLM analysis pass, so keep small.
  DISCOVERY_MAX_PROCESS_PER_RUN: z
    .string()
    .default("3")
    .transform(Number)
    .pipe(z.number().int().positive()),
  // Max search.list calls per run. Each search.list costs 100 quota units AND
  // consumes one of the ~100/day search bucket — keep tight.
  DISCOVERY_MAX_SEARCH_CALLS_PER_RUN: z
    .string()
    .default("5")
    .transform(Number)
    .pipe(z.number().int().positive()),
  // Telegram topic id for the discovery/news digest. If unset, the topic is
  // lazily created in the group chat on first run and its id persisted in
  // discovery_state. Empty/0 forces DM delivery.
  DISCOVERY_NEWS_TOPIC_ID: z
    .string()
    .default("")
    .transform((s) => (s ? Number(s) : 0))
    .pipe(z.number().int().nonnegative()),
  DISCOVERY_QUIET_START: z
    .string()
    .default("0")
    .transform(Number)
    .pipe(z.number().int().min(0).max(23)),
  DISCOVERY_QUIET_END: z
    .string()
    .default("8")
    .transform(Number)
    .pipe(z.number().int().min(0).max(23)),
  // Whether the discovery runner posts its digest to Telegram. Default OFF:
  // content is browsed in the Mini App (/tma/discover), and the channel stays
  // silent for content processing. Candidates are still marked `surfaced` and
  // news persisted regardless, so the Mini App always has fresh data.
  DISCOVERY_SURFACE_TELEGRAM: z
    .string()
    .default("false")
    .transform((s) => s === "true"),
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

/**
 * Returns env overrides for the GLM backend when DEFAULT_BACKEND is "glm",
 * or undefined when using Claude. Use with the SDK's `query({ options: { env } })`.
 */
export function getBackendEnv(): Record<string, string> | undefined {
  const config = getConfig();
  if (config.DEFAULT_BACKEND !== "glm" || !config.GLM_AUTH_TOKEN) return undefined;
  return {
    ...process.env as Record<string, string>,
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.GLM_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.GLM_OPUS_MODEL,
  };
}
