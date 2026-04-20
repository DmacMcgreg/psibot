export type MessageSource = "web" | "telegram" | "mini-app" | "job" | "heartbeat";

export interface ChatMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  source: MessageSource;
  source_id: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AgentSession {
  id: number;
  session_id: string;
  source: MessageSource;
  source_id: string | null;
  model: string;
  total_cost_usd: number;
  message_count: number;
  label: string | null;
  forked_from: string | null;
  created_at: string;
  updated_at: string;
}

export type JobType = "cron" | "once";
export type JobStatus = "enabled" | "disabled" | "completed" | "failed";

export interface Job {
  id: number;
  name: string;
  prompt: string;
  type: JobType;
  schedule: string | null;
  run_at: string | null;
  max_budget_usd: number;
  allowed_tools: string | null;
  use_browser: boolean;
  model: string | null;
  backend: AgentBackend | null;
  paused_until: string | null;
  skip_runs: number;
  notify_chat_id: string | null;
  notify_topic_id: number | null;
  agent_name: string | null;
  agent_prompt: string | null;
  subagents: string | null;       // JSON array of subagent names
  next_job_id: number | null;
  notify_policy: AgentNotifyPolicy | null; // Job-level override (null = use agent default)
  output_template: string | null;          // Job-level template override
  last_output_hash: string | null;         // Last result hash (for on_change policy)
  status: JobStatus;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RunStatus = "running" | "success" | "error" | "budget_exceeded";

export interface JobRun {
  id: number;
  job_id: number;
  status: RunStatus;
  result: string | null;
  error: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  session_id: string | null;
  started_at: string;
  completed_at: string | null;
  triggered_by_run_id: number | null;
}

// --- Declarative agents ---

export type AgentNotifyPolicy = "always" | "on_error" | "on_change" | "silent" | "dynamic";

export interface Agent {
  id: number;
  slug: string;
  name: string;
  role: string;
  goal: string;
  backstory: string;
  description: string;
  prompt: string;
  model: string;
  max_turns: number;
  allowed_tools: string | null;        // JSON array of tool names, NULL = all
  allowed_subagents: string | null;    // JSON array of agent slugs
  critic_agent_slug: string | null;    // Phase 4: preferred reviewer
  memory_dir: string;                  // e.g. 'agents/researcher'
  notify_chat_id: string | null;
  notify_topic_id: number | null;
  notify_policy: AgentNotifyPolicy;
  output_template: string | null;      // Phase 3: markdown w/ {{placeholders}}
  last_output_hash: string | null;     // Phase 3: for on_change
  backend: AgentBackend | null;        // Phase 6: per-agent provider (NULL = job/global default)
  is_builtin: number;                  // 0 or 1
  created_at: string;
  updated_at: string;
}

export interface MemoryEntry {
  id: number;
  file_path: string;
  title: string;
  content: string;
  updated_at: string;
}

export interface ToolUse {
  id: number;
  session_id: string;
  tool_name: string;
  input_summary: string | null;
  is_subagent: number;
  created_at: string;
}

/** Context about the originating Telegram chat/topic for routing responses. */
export interface ChatContext {
  chatId: string;
  topicId?: number;
  chatType: "private" | "group" | "supergroup" | "channel";
}

export type AgentBackend = "claude" | "glm";

export interface AgentRunOptions {
  prompt: string;
  source: MessageSource;
  sourceId?: string;
  sessionId?: string;
  chatContext?: ChatContext;
  maxBudgetUsd?: number;
  maxTurns?: number;
  allowedTools?: string[];
  useBrowser?: boolean;
  model?: string;
  /** Which AI backend to use. "claude" = Claude Max plan (default), "glm" = GLM models via api.z.ai */
  backend?: AgentBackend;
  agentName?: string;
  agentPrompt?: string;
  subagentNames?: string[];
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, input?: Record<string, unknown>, subagent?: boolean) => void;
  onComplete?: (result: AgentRunResult) => void;
}

// --- Portfolio ---

export interface PortfolioConfig {
  id: number;
  starting_cash: number;
  current_cash: number;
  max_position_pct: number;
  max_positions: number;
  default_take_profit_pct: number;
  rsi_exit_threshold: number;
  created_at: string;
  updated_at: string;
}

export type PositionStatus = "open" | "closed";

export type ExitSignal =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "RSI_OVERBOUGHT"
  | "TREND_REVERSAL"
  | "MACD_BEAR_CROSS"
  | "BB_UPPER_TOUCH"
  | "VOLUME_SPIKE_DECLINE"
  | "NEWS_EXIT"
  | "MANUAL";

export interface PortfolioPosition {
  id: number;
  ticker: string;
  sector: string;
  status: PositionStatus;
  shares: number;
  entry_price: number;
  entry_date: string;
  entry_signal: string;
  entry_reasons: string;
  entry_atr: number;
  stop_loss_price: number;
  take_profit_price: number;
  current_price: number | null;
  current_pnl_pct: number | null;
  exit_price: number | null;
  exit_date: string | null;
  exit_signal: string | null;
  exit_reasons: string | null;
  realized_pnl: number | null;
  screener_date: string;
  created_at: string;
  updated_at: string;
}

export interface PortfolioDailySnapshot {
  id: number;
  snapshot_date: string;
  total_value: number;
  cash: number;
  invested: number;
  open_positions: number;
  day_pnl: number;
  day_pnl_pct: number;
  total_pnl: number;
  total_pnl_pct: number;
  positions_json: string;
  created_at: string;
}

// --- Inbox / Pending Items ---

export type PendingItemStatus = "pending" | "triaged" | "archived" | "deleted";
export type CaptureSource = "chrome-extension" | "reddit" | "github" | "telegram" | "youtube" | "manual";

export interface PendingItem {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  source: CaptureSource;
  platform: string | null;
  profile: string | null;
  captured_at: string | null;
  status: PendingItemStatus;
  priority: number | null;
  category: string | null;
  triage_summary: string | null;
  noteplan_path: string | null;
  // New heartbeat orchestrator fields
  quick_scan_summary: string | null;
  theme_id: number | null;
  relevance_window: string | null;
  watch_status: WatchStatus | null;
  auto_decision: string | null;
  signal_score: number | null;
  value_type: ValueType | null;
  extracted_value: string | null;
  surfaced_at: string | null;
  created_at: string;
}

// --- Reminders ---

export type ReminderType = "bill" | "action" | "research" | "follow_up";
export type ReminderStatus = "active" | "snoozed" | "dismissed" | "completed";

export interface Reminder {
  id: number;
  type: ReminderType;
  title: string;
  description: string | null;
  source_id: string | null;
  status: ReminderStatus;
  priority: number;
  snooze_until: string | null;
  remind_count: number;
  max_reminds: number;
  created_at: string;
  updated_at: string;
}

// --- Themes ---

export type ThemeStatus = "active" | "watching" | "archived";
export type ThemeReportInterval = "weekly" | "biweekly" | "monthly";

export interface Theme {
  id: number;
  name: string;
  description: string;
  status: ThemeStatus;
  item_count: number;
  last_activity_at: string | null;
  next_report_at: string | null;
  report_interval: ThemeReportInterval;
  created_at: string;
  updated_at: string;
}

export interface ThemeItem {
  id: number;
  theme_id: number;
  item_id: number;
  created_at: string;
}

// --- Feedback & Autonomy ---

export interface FeedbackLogEntry {
  id: number;
  item_id: number | null;
  theme_id: number | null;
  content_type: string | null;
  source: string | null;
  system_recommendation: string | null;
  user_action: string;
  signal_snapshot: string | null;
  created_at: string;
}

export type AutonomyLevel = "manual" | "suggest" | "auto_report" | "silent";

export interface AutonomyRule {
  id: number;
  signal_type: string;
  signal_value: string;
  learned_action: string;
  confidence: number;
  decision_count: number;
  level: AutonomyLevel;
  created_at: string;
  updated_at: string;
}

// --- Extended PendingItem fields (new columns) ---

export type WatchStatus = "watching" | "expired";

export type ValueType = "technique" | "tool" | "actionable" | "no_value";

export type StopReason =
  | "end_turn"
  | "max_turns"
  | "budget_exceeded"
  | "interrupted"
  | "stale_timeout"
  | "first_response_timeout"
  | "message_limit"
  | "error"
  | "unknown";

export interface AgentRunResult {
  sessionId: string;
  result: string;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  contextWindow: number;
  numTurns: number;
  stopReason: StopReason;
}

export type TradingSignalDirection = "long" | "short" | "neutral";

export type TradingSignalSource =
  | "wsb"
  | "reddit-stocks"
  | "reddit-options"
  | "reddit-investing"
  | "reddit-pennystocks"
  | "reddit-securityanalysis"
  | "openinsider"
  | "benzinga-analyst"
  | "finviz-analyst"
  | "shadow-tipranks"
  | "shadow-c2zulu"
  | "shadow-afterhour"
  | "shadow-autopilot"
  | "shadow-quiver";

export interface TradingSignal {
  id: number;
  source: string;
  ticker: string;
  direction: TradingSignalDirection;
  strength: number;
  reason: string | null;
  payload_json: string | null;
  source_url: string | null;
  captured_at: string;
  acted_on: number;
  trade_id: number | null;
}

export interface SignalCluster {
  ticker: string;
  direction: TradingSignalDirection;
  sources: string[];
  source_count: number;
  total_strength: number;
  avg_strength: number;
  signal_ids: number[];
  latest_captured_at: string;
  top_reasons: string[];
}
