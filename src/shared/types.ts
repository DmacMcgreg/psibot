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
  paused_until: string | null;
  skip_runs: number;
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
  started_at: string;
  completed_at: string | null;
}

export interface MemoryEntry {
  id: number;
  file_path: string;
  title: string;
  content: string;
  updated_at: string;
}

export interface AgentRunOptions {
  prompt: string;
  source: MessageSource;
  sourceId?: string;
  sessionId?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  allowedTools?: string[];
  useBrowser?: boolean;
  model?: string;
  onText?: (text: string) => void;
  onToolUse?: (toolName: string, input?: Record<string, unknown>, subagent?: boolean) => void;
  onComplete?: (result: AgentRunResult) => void;
}

export type StopReason =
  | "end_turn"
  | "max_turns"
  | "budget_exceeded"
  | "interrupted"
  | "stale_timeout"
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
