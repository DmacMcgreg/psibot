import { getDb } from "./index.ts";
import type {
  ChatMessage,
  AgentSession,
  Job,
  JobRun,
  MemoryEntry,
  MessageSource,
  JobStatus,
  RunStatus,
  ToolUse,
  PortfolioConfig,
  PortfolioPosition,
  PortfolioDailySnapshot,
  PendingItem,
  PendingItemStatus,
  CaptureSource,
  Reminder,
  Theme,
  ThemeStatus,
  FeedbackLogEntry,
  AutonomyRule,
  AutonomyLevel,
  TradingSignal,
  TradingSignalDirection,
  SignalCluster,
  Agent,
  AgentNotifyPolicy,
  AgentBackend,
} from "../shared/types.ts";

// --- Chat Messages ---

export function insertChatMessage(params: {
  session_id: string;
  role: "user" | "assistant";
  content: string;
  source: MessageSource;
  source_id?: string | null;
  cost_usd?: number | null;
  duration_ms?: number | null;
}): ChatMessage {
  const db = getDb();
  return db
    .prepare<ChatMessage, [string, string, string, string, string | null, number | null, number | null]>(
      `INSERT INTO chat_messages (session_id, role, content, source, source_id, cost_usd, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      params.session_id,
      params.role,
      params.content,
      params.source,
      params.source_id ?? null,
      params.cost_usd ?? null,
      params.duration_ms ?? null
    )!;
}

export function getMessagesBySession(sessionId: string): ChatMessage[] {
  const db = getDb();
  return db
    .prepare<ChatMessage, [string]>(
      `SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC`
    )
    .all(sessionId);
}

export function getRecentMessages(
  source: MessageSource,
  sourceId: string | null,
  limit: number = 50,
  beforeId?: number
): ChatMessage[] {
  const db = getDb();
  if (sourceId) {
    if (beforeId) {
      return db
        .prepare<ChatMessage, [string, string, number, number]>(
          `SELECT * FROM chat_messages WHERE source = ? AND source_id = ? AND id < ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(source, sourceId, beforeId, limit)
        .reverse();
    }
    return db
      .prepare<ChatMessage, [string, string, number]>(
        `SELECT * FROM chat_messages WHERE source = ? AND source_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(source, sourceId, limit)
      .reverse();
  }
  if (beforeId) {
    return db
      .prepare<ChatMessage, [string, number, number]>(
        `SELECT * FROM chat_messages WHERE source = ? AND id < ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(source, beforeId, limit)
      .reverse();
  }
  return db
    .prepare<ChatMessage, [string, number]>(
      `SELECT * FROM chat_messages WHERE source = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(source, limit)
    .reverse();
}

// --- Agent Sessions ---

export function upsertSession(params: {
  session_id: string;
  source: MessageSource;
  source_id?: string | null;
  model: string;
  cost_usd: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_sessions (session_id, source, source_id, model, total_cost_usd, message_count)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       message_count = message_count + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).run(
    params.session_id,
    params.source,
    params.source_id ?? null,
    params.model,
    params.cost_usd
  );
}

export function getSession(sessionId: string): AgentSession | null {
  const db = getDb();
  return (
    db
      .prepare<AgentSession, [string]>(
        `SELECT * FROM agent_sessions WHERE session_id = ?`
      )
      .get(sessionId) ?? null
  );
}

export function getLatestSessionId(
  source: MessageSource,
  sourceId: string | null
): string | null {
  const db = getDb();
  if (sourceId) {
    const row = db
      .prepare<Pick<AgentSession, "session_id">, [string, string]>(
        `SELECT session_id FROM agent_sessions WHERE source = ? AND source_id = ? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(source, sourceId);
    return row?.session_id ?? null;
  }
  const row = db
    .prepare<Pick<AgentSession, "session_id">, [string]>(
      `SELECT session_id FROM agent_sessions WHERE source = ? AND source_id IS NULL ORDER BY updated_at DESC LIMIT 1`
    )
    .get(source);
  return row?.session_id ?? null;
}

export function getRecentSessions(
  source: MessageSource,
  sourceId: string | null,
  limit: number = 10
): AgentSession[] {
  const db = getDb();
  if (sourceId) {
    return db
      .prepare<AgentSession, [string, string, number]>(
        `SELECT * FROM agent_sessions WHERE source = ? AND source_id = ? ORDER BY updated_at DESC LIMIT ?`
      )
      .all(source, sourceId, limit);
  }
  return db
    .prepare<AgentSession, [string, number]>(
      `SELECT * FROM agent_sessions WHERE source = ? AND source_id IS NULL ORDER BY updated_at DESC LIMIT ?`
    )
    .all(source, limit);
}

export function getRecentSessionsBySourcePrefix(
  source: MessageSource,
  sourceIdPrefix: string,
  limit: number = 10
): AgentSession[] {
  const db = getDb();
  return db
    .prepare<AgentSession, [string, string, string, number]>(
      `SELECT * FROM agent_sessions WHERE source = ? AND (source_id = ? OR source_id LIKE ? || ':%') ORDER BY updated_at DESC LIMIT ?`
    )
    .all(source, sourceIdPrefix, sourceIdPrefix, limit);
}

export function getSessionPreview(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare<Pick<ChatMessage, "content">, [string]>(
      `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1`
    )
    .get(sessionId);
  if (!row) return null;
  return row.content.length > 80 ? row.content.slice(0, 80) + "..." : row.content;
}

export function getSessionPreviews(sessionIds: string[]): Map<string, string> {
  if (sessionIds.length === 0) return new Map();
  const db = getDb();
  const placeholders = sessionIds.map(() => "?").join(",");
  const rows = db
    .prepare<{ session_id: string; content: string }, string[]>(
      `WITH first_msgs AS (
        SELECT session_id, content,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC) as rn
        FROM chat_messages WHERE role = 'user' AND session_id IN (${placeholders})
      )
      SELECT session_id, content FROM first_msgs WHERE rn = 1`
    )
    .all(...sessionIds);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(
      row.session_id,
      row.content.length > 80 ? row.content.slice(0, 80) + "..." : row.content
    );
  }
  return map;
}

// --- Jobs ---

export function createJob(params: {
  name: string;
  prompt: string;
  type: "cron" | "once";
  schedule?: string | null;
  run_at?: string | null;
  max_budget_usd?: number;
  allowed_tools?: string | null;
  use_browser?: boolean;
  model?: string | null;
  backend?: string | null;
  agent_name?: string | null;
  agent_prompt?: string | null;
  subagents?: string | null;
  next_job_id?: number | null;
}): Job {
  const db = getDb();
  return db
    .prepare<Job, [string, string, string, string | null, string | null, number, string | null, number, string | null, string | null, string | null, string | null, string | null, number | null]>(
      `INSERT INTO jobs (name, prompt, type, schedule, run_at, max_budget_usd, allowed_tools, use_browser, model, backend, agent_name, agent_prompt, subagents, next_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      params.name,
      params.prompt,
      params.type,
      params.schedule ?? null,
      params.run_at ?? null,
      params.max_budget_usd ?? 1.0,
      params.allowed_tools ?? null,
      params.use_browser ? 1 : 0,
      params.model ?? null,
      params.backend ?? "claude",
      params.agent_name ?? null,
      params.agent_prompt ?? null,
      params.subagents ?? null,
      params.next_job_id ?? null
    )!;
}

export function getJob(id: number): Job | null {
  const db = getDb();
  return db.prepare<Job, [number]>(`SELECT * FROM jobs WHERE id = ?`).get(id) ?? null;
}

export function getAllJobs(): Job[] {
  const db = getDb();
  return db.prepare<Job, []>(`SELECT * FROM jobs ORDER BY created_at DESC`).all();
}

export function getEnabledJobs(): Job[] {
  const db = getDb();
  return db
    .prepare<Job, []>(`SELECT * FROM jobs WHERE status = 'enabled' ORDER BY id`)
    .all();
}

export function updateJob(
  id: number,
  params: Partial<
    Pick<
      Job,
      | "name"
      | "prompt"
      | "schedule"
      | "run_at"
      | "max_budget_usd"
      | "allowed_tools"
      | "use_browser"
      | "model"
      | "backend"
      | "paused_until"
      | "skip_runs"
      | "status"
      | "last_run_at"
      | "next_run_at"
      | "notify_chat_id"
      | "notify_topic_id"
      | "agent_name"
      | "agent_prompt"
      | "subagents"
      | "next_job_id"
      | "notify_policy"
      | "output_template"
      | "last_output_hash"
    >
  >
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      const v = key === "use_browser" ? (value ? 1 : 0) : value;
      values.push(v as string | number | null);
    }
  }
  if (sets.length === 0) return;

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  values.push(id);

  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteJob(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
}

// --- Job Runs ---

export function createJobRun(jobId: number, triggeredByRunId?: number): JobRun {
  const db = getDb();
  if (triggeredByRunId != null) {
    return db
      .prepare<JobRun, [number, number]>(
        `INSERT INTO job_runs (job_id, triggered_by_run_id) VALUES (?, ?) RETURNING *`
      )
      .get(jobId, triggeredByRunId)!;
  }
  return db
    .prepare<JobRun, [number]>(
      `INSERT INTO job_runs (job_id) VALUES (?) RETURNING *`
    )
    .get(jobId)!;
}

export function completeJobRun(
  id: number,
  params: {
    status: RunStatus;
    result?: string | null;
    error?: string | null;
    cost_usd?: number | null;
    duration_ms?: number | null;
    session_id?: string | null;
  }
): void {
  const db = getDb();
  db.prepare(
    `UPDATE job_runs SET status = ?, result = ?, error = ?, cost_usd = ?, duration_ms = ?, session_id = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ?`
  ).run(
    params.status,
    params.result ?? null,
    params.error ?? null,
    params.cost_usd ?? null,
    params.duration_ms ?? null,
    params.session_id ?? null,
    id
  );
}

export function getJobRuns(jobId: number, limit: number = 20): JobRun[] {
  const db = getDb();
  return db
    .prepare<JobRun, [number, number]>(
      `SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`
    )
    .all(jobId, limit);
}

export function getRecentRuns(limit: number = 50): JobRun[] {
  const db = getDb();
  return db
    .prepare<JobRun, [number]>(
      `SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit);
}

// --- Memory Entries ---

export function upsertMemoryEntry(params: {
  file_path: string;
  title: string;
  content: string;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO memory_entries (file_path, title, content)
     VALUES (?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).run(params.file_path, params.title, params.content);
}

export function searchMemory(query: string): MemoryEntry[] {
  const db = getDb();
  const pattern = `%${query}%`;
  return db
    .prepare<MemoryEntry, [string, string]>(
      `SELECT * FROM memory_entries WHERE content LIKE ? OR title LIKE ? ORDER BY updated_at DESC LIMIT 20`
    )
    .all(pattern, pattern);
}

export function getAllMemoryEntries(limit: number = 200): MemoryEntry[] {
  const db = getDb();
  return db
    .prepare<MemoryEntry, [number]>(`SELECT * FROM memory_entries ORDER BY file_path LIMIT ?`)
    .all(limit);
}

export function deleteMemoryEntry(file_path: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM memory_entries WHERE file_path = ?`).run(file_path);
}

// --- Session Lookup ---

export function resolveSessionByPrefix(prefix: string): AgentSession | null {
  const db = getDb();
  return db
    .prepare<AgentSession, [string]>(
      `SELECT * FROM agent_sessions WHERE session_id LIKE ? || '%' ORDER BY updated_at DESC LIMIT 1`
    )
    .get(prefix) ?? null;
}

export function getLastUserMessage(sessionId: string): string | null {
  const db = getDb();
  const row = db
    .prepare<Pick<ChatMessage, "content">, [string]>(
      `SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1`
    )
    .get(sessionId);
  return row?.content ?? null;
}

// --- Tool Uses ---

export function insertToolUse(params: {
  session_id: string;
  tool_name: string;
  input_summary?: string | null;
  is_subagent?: boolean;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO tool_uses (session_id, tool_name, input_summary, is_subagent) VALUES (?, ?, ?, ?)`
  ).run(
    params.session_id,
    params.tool_name,
    params.input_summary ?? null,
    params.is_subagent ? 1 : 0
  );
}

export function getToolUsesBySession(sessionId: string): ToolUse[] {
  const db = getDb();
  return db
    .prepare<ToolUse, [string]>(
      `SELECT * FROM tool_uses WHERE session_id = ? ORDER BY created_at ASC`
    )
    .all(sessionId);
}

// --- Activity Feed ---

interface ActivityRow {
  type: string;
  session_id: string;
  source: string;
  role: string | null;
  content: string;
  tool_name: string | null;
  input_summary: string | null;
  is_subagent: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  created_at: string;
}

export function getRecentActivity(limit: number = 100): ActivityRow[] {
  const db = getDb();
  return db.prepare<ActivityRow, [number]>(`
    SELECT
      'message' as type,
      cm.session_id,
      cm.source,
      cm.role,
      cm.content,
      NULL as tool_name,
      NULL as input_summary,
      NULL as is_subagent,
      cm.cost_usd,
      cm.duration_ms,
      cm.created_at
    FROM chat_messages cm
    WHERE cm.created_at > datetime('now', '-7 days')

    UNION ALL

    SELECT
      'tool' as type,
      tu.session_id,
      COALESCE(s.source, 'unknown') as source,
      NULL as role,
      '' as content,
      tu.tool_name,
      tu.input_summary,
      tu.is_subagent,
      NULL as cost_usd,
      NULL as duration_ms,
      tu.created_at
    FROM tool_uses tu
    LEFT JOIN agent_sessions s ON tu.session_id = s.session_id
    WHERE tu.created_at > datetime('now', '-7 days')

    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

export type { ActivityRow };

interface SessionLogWithPromptRow {
  session_id: string;
  source: string;
  model: string;
  total_cost_usd: number;
  message_count: number;
  updated_at: string;
  first_prompt: string | null;
}

export function getRecentSessionLogs(limit: number = 50): {
  session_id: string;
  source: string;
  model: string;
  total_cost_usd: number;
  message_count: number;
  first_prompt: string | null;
  updated_at: string;
  tools: ToolUse[];
}[] {
  const db = getDb();

  // Single query: sessions joined with first user message via CTE
  const sessions = db
    .prepare<SessionLogWithPromptRow, [number]>(
      `WITH first_msgs AS (
        SELECT session_id, content,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at ASC) as rn
        FROM chat_messages WHERE role = 'user'
      )
      SELECT s.session_id, s.source, s.model, s.total_cost_usd, s.message_count, s.updated_at,
        fm.content as first_prompt
      FROM agent_sessions s
      LEFT JOIN first_msgs fm ON fm.session_id = s.session_id AND fm.rn = 1
      WHERE s.updated_at > datetime('now', '-7 days')
      ORDER BY s.updated_at DESC
      LIMIT ?`
    )
    .all(limit);

  if (sessions.length === 0) return [];

  // Batch tool_uses query for all sessions at once
  const sessionIds = sessions.map((s) => s.session_id);
  const placeholders = sessionIds.map(() => "?").join(",");
  const allTools = db
    .prepare<ToolUse, string[]>(
      `SELECT * FROM tool_uses WHERE session_id IN (${placeholders}) ORDER BY created_at ASC`
    )
    .all(...sessionIds);

  // Group tools by session_id
  const toolsBySession = new Map<string, ToolUse[]>();
  for (const tool of allTools) {
    const list = toolsBySession.get(tool.session_id);
    if (list) {
      list.push(tool);
    } else {
      toolsBySession.set(tool.session_id, [tool]);
    }
  }

  return sessions.map((s) => ({
    ...s,
    tools: toolsBySession.get(s.session_id) ?? [],
  }));
}

// --- Portfolio ---

export function getPortfolioConfig(): PortfolioConfig {
  const db = getDb();
  let config = db
    .prepare<PortfolioConfig, []>(`SELECT * FROM portfolio_config WHERE id = 1`)
    .get();
  if (!config) {
    db.prepare(`INSERT OR IGNORE INTO portfolio_config (id) VALUES (1)`).run();
    config = db
      .prepare<PortfolioConfig, []>(`SELECT * FROM portfolio_config WHERE id = 1`)
      .get()!;
  }
  return config;
}

export function updatePortfolioConfig(
  params: Partial<
    Pick<
      PortfolioConfig,
      | "current_cash"
      | "max_position_pct"
      | "max_positions"
      | "default_take_profit_pct"
      | "rsi_exit_threshold"
    >
  >
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }
  if (sets.length === 0) return;

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  values.push(1); // WHERE id = 1

  db.prepare(`UPDATE portfolio_config SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values
  );
}

export function openPosition(params: {
  ticker: string;
  sector: string;
  shares: number;
  entry_price: number;
  entry_date: string;
  entry_signal: string;
  entry_reasons: string;
  entry_atr: number;
  stop_loss_price: number;
  take_profit_price: number;
  screener_date: string;
}): PortfolioPosition {
  const db = getDb();
  const cost = params.shares * params.entry_price;

  const position = db
    .prepare<
      PortfolioPosition,
      [string, string, number, number, string, string, string, number, number, number, number, string]
    >(
      `INSERT INTO portfolio_positions
        (ticker, sector, shares, entry_price, entry_date, entry_signal, entry_reasons, entry_atr, stop_loss_price, take_profit_price, current_price, screener_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      params.ticker,
      params.sector,
      params.shares,
      params.entry_price,
      params.entry_date,
      params.entry_signal,
      params.entry_reasons,
      params.entry_atr,
      params.stop_loss_price,
      params.take_profit_price,
      params.entry_price,
      params.screener_date
    )!;

  // Deduct cash
  db.prepare(
    `UPDATE portfolio_config SET current_cash = current_cash - ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`
  ).run(cost);

  return position;
}

export function closePosition(params: {
  id: number;
  exit_price: number;
  exit_date: string;
  exit_signal: string;
  exit_reasons: string;
}): PortfolioPosition {
  const db = getDb();

  // Get the position first
  const pos = db
    .prepare<PortfolioPosition, [number]>(
      `SELECT * FROM portfolio_positions WHERE id = ? AND status = 'open'`
    )
    .get(params.id);

  if (!pos) {
    throw new Error(`No open position with id ${params.id}`);
  }

  const proceeds = pos.shares * params.exit_price;
  const realizedPnl = (params.exit_price - pos.entry_price) * pos.shares;

  const updated = db
    .prepare<PortfolioPosition, [number, string, string, string, number, number, number, number]>(
      `UPDATE portfolio_positions SET
        status = 'closed',
        exit_price = ?,
        exit_date = ?,
        exit_signal = ?,
        exit_reasons = ?,
        realized_pnl = ?,
        current_price = ?,
        current_pnl_pct = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?
       RETURNING *`
    )
    .get(
      params.exit_price,
      params.exit_date,
      params.exit_signal,
      params.exit_reasons,
      realizedPnl,
      params.exit_price,
      ((params.exit_price - pos.entry_price) / pos.entry_price) * 100,
      params.id
    )!;

  // Add proceeds back to cash
  db.prepare(
    `UPDATE portfolio_config SET current_cash = current_cash + ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`
  ).run(proceeds);

  return updated;
}

export function updatePositionPrice(id: number, price: number): void {
  const db = getDb();
  db.prepare(
    `UPDATE portfolio_positions SET
      current_price = ?,
      current_pnl_pct = ((? - entry_price) / entry_price) * 100,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ? AND status = 'open'`
  ).run(price, price, id);
}

export function getOpenPositions(): PortfolioPosition[] {
  const db = getDb();
  return db
    .prepare<PortfolioPosition, []>(
      `SELECT * FROM portfolio_positions WHERE status = 'open' ORDER BY ticker`
    )
    .all();
}

export function getClosedPositions(limit: number = 50): PortfolioPosition[] {
  const db = getDb();
  return db
    .prepare<PortfolioPosition, [number]>(
      `SELECT * FROM portfolio_positions WHERE status = 'closed' ORDER BY exit_date DESC LIMIT ?`
    )
    .all(limit);
}

export function getPositionByTicker(ticker: string): PortfolioPosition | null {
  const db = getDb();
  return (
    db
      .prepare<PortfolioPosition, [string]>(
        `SELECT * FROM portfolio_positions WHERE ticker = ? AND status = 'open'`
      )
      .get(ticker) ?? null
  );
}

export function insertDailySnapshot(params: {
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
}): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO portfolio_daily_snapshots
      (snapshot_date, total_value, cash, invested, open_positions, day_pnl, day_pnl_pct, total_pnl, total_pnl_pct, positions_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.snapshot_date,
    params.total_value,
    params.cash,
    params.invested,
    params.open_positions,
    params.day_pnl,
    params.day_pnl_pct,
    params.total_pnl,
    params.total_pnl_pct,
    params.positions_json
  );
}

// --- Pending Items (Inbox Capture) ---

export function insertPendingItem(params: {
  url: string;
  title?: string | null;
  description?: string | null;
  source?: CaptureSource;
  platform?: string | null;
  profile?: string | null;
  captured_at?: string | null;
}): PendingItem | null {
  const db = getDb();
  return db
    .prepare<PendingItem, [string, string | null, string | null, string, string | null, string | null, string | null]>(
      `INSERT INTO pending_items (url, title, description, source, platform, profile, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET
         title = COALESCE(excluded.title, pending_items.title),
         description = COALESCE(excluded.description, pending_items.description)
       RETURNING *`
    )
    .get(
      params.url,
      params.title ?? null,
      params.description ?? null,
      params.source ?? "manual",
      params.platform ?? null,
      params.profile ?? null,
      params.captured_at ?? new Date().toISOString()
    );
}

export function getPendingItems(status?: PendingItemStatus, limit: number = 50): PendingItem[] {
  const db = getDb();
  if (status) {
    return db
      .prepare<PendingItem, [string, number]>(
        `SELECT * FROM pending_items WHERE status = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(status, limit);
  }
  return db
    .prepare<PendingItem, [number]>(
      `SELECT * FROM pending_items ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit);
}

export function getPendingItemById(id: number): PendingItem | null {
  const db = getDb();
  return db
    .prepare<PendingItem, [number]>(
      `SELECT * FROM pending_items WHERE id = ?`
    )
    .get(id) ?? null;
}

export function getPendingItemByUrl(url: string): PendingItem | null {
  const db = getDb();
  return db
    .prepare<PendingItem, [string]>(
      `SELECT * FROM pending_items WHERE url = ?`
    )
    .get(url) ?? null;
}

export function updatePendingItem(
  id: number,
  params: Partial<Pick<PendingItem, "status" | "priority" | "category" | "triage_summary" | "noteplan_path" | "title" | "description" | "quick_scan_summary" | "theme_id" | "relevance_window" | "watch_status" | "auto_decision" | "signal_score" | "value_type" | "extracted_value" | "surfaced_at">>
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }
  if (sets.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE pending_items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function getPendingItemCount(status?: PendingItemStatus): number {
  const db = getDb();
  if (status) {
    return (db.prepare<{ cnt: number }, [string]>(
      `SELECT COUNT(*) as cnt FROM pending_items WHERE status = ?`
    ).get(status))?.cnt ?? 0;
  }
  return (db.prepare<{ cnt: number }, []>(
    `SELECT COUNT(*) as cnt FROM pending_items`
  ).get())?.cnt ?? 0;
}

export function getQueuedResearchItems(limit: number = 3): PendingItem[] {
  const db = getDb();
  return db
    .prepare<PendingItem, [number]>(
      `SELECT * FROM pending_items
       WHERE auto_decision IN ('quick_research_queued', 'deep_research_queued')
       ORDER BY
         CASE WHEN priority IS NOT NULL THEN priority ELSE 99 END ASC,
         created_at ASC
       LIMIT ?`
    )
    .all(limit);
}

export function getUnsurfacedTriagedItems(limit: number = 5): PendingItem[] {
  const db = getDb();
  return db
    .prepare<PendingItem, [number]>(
      `SELECT * FROM pending_items
       WHERE status = 'triaged' AND surfaced_at IS NULL
       ORDER BY
         CASE WHEN priority IS NOT NULL THEN priority ELSE 99 END ASC,
         COALESCE(signal_score, 0) DESC,
         created_at DESC
       LIMIT ?`
    )
    .all(limit);
}

export function markItemsSurfaced(ids: number[]): void {
  if (ids.length === 0) return;
  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE pending_items SET surfaced_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id IN (${placeholders})`
  ).run(...ids);
}

// --- Topic Muting ---

export function muteTopic(chatId: string, topicId: number | null, mutedUntil: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO muted_topics (chat_id, topic_id, muted_until)
     VALUES (?, ?, ?)
     ON CONFLICT(chat_id, topic_id) DO UPDATE SET muted_until = excluded.muted_until`
  ).run(chatId, topicId, mutedUntil);
}

export function unmuteTopic(chatId: string, topicId: number | null): void {
  const db = getDb();
  db.prepare(
    `DELETE FROM muted_topics WHERE chat_id = ? AND topic_id IS ?`
  ).run(chatId, topicId);
}

export function isTopicMuted(chatId: string, topicId: number | null): boolean {
  const db = getDb();
  const row = db.prepare<{ muted_until: string }, [string, number | null]>(
    `SELECT muted_until FROM muted_topics WHERE chat_id = ? AND topic_id IS ?`
  ).get(chatId, topicId);
  if (!row) return false;
  const until = new Date(row.muted_until.endsWith("Z") ? row.muted_until : row.muted_until + "Z");
  if (until <= new Date()) {
    // Expired — clean up
    unmuteTopic(chatId, topicId);
    return false;
  }
  return true;
}

interface MutedTopicRow {
  chat_id: string;
  topic_id: number | null;
  muted_until: string;
}

export function getMutedTopics(): MutedTopicRow[] {
  const db = getDb();
  return db.prepare<MutedTopicRow, []>(
    `SELECT chat_id, topic_id, muted_until FROM muted_topics ORDER BY muted_until`
  ).all();
}

export function getRecentSnapshots(
  limit: number = 30
): PortfolioDailySnapshot[] {
  const db = getDb();
  return db
    .prepare<PortfolioDailySnapshot, [number]>(
      `SELECT * FROM portfolio_daily_snapshots ORDER BY snapshot_date DESC LIMIT ?`
    )
    .all(limit);
}

export function getPortfolioSummary(): {
  config: PortfolioConfig;
  positions: PortfolioPosition[];
  totalValue: number;
  investedValue: number;
  totalPnl: number;
  totalPnlPct: number;
} {
  const config = getPortfolioConfig();
  const positions = getOpenPositions();

  const investedValue = positions.reduce(
    (sum, p) => sum + (p.current_price ?? p.entry_price) * p.shares,
    0
  );
  const totalValue = config.current_cash + investedValue;
  const totalPnl = totalValue - config.starting_cash;
  const totalPnlPct = (totalPnl / config.starting_cash) * 100;

  return { config, positions, totalValue, investedValue, totalPnl, totalPnlPct };
}

// --- Reminders ---

export function insertReminder(params: {
  type: string;
  title: string;
  description?: string;
  source_id?: string;
  priority?: number;
  max_reminds?: number;
}): Reminder {
  const db = getDb();
  return db
    .prepare<Reminder, [string, string, string | null, string | null, number, number]>(
      `INSERT INTO reminders (type, title, description, source_id, priority, max_reminds)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      params.type,
      params.title,
      params.description ?? null,
      params.source_id ?? null,
      params.priority ?? 3,
      params.max_reminds ?? 5
    )!;
}

export function getActiveReminders(): Reminder[] {
  const db = getDb();
  return db
    .prepare<Reminder, []>(
      `SELECT * FROM reminders WHERE status = 'active' ORDER BY priority ASC, created_at ASC`
    )
    .all();
}

export function getReminder(id: number): Reminder | null {
  const db = getDb();
  return (
    db
      .prepare<Reminder, [number]>(`SELECT * FROM reminders WHERE id = ?`)
      .get(id) ?? null
  );
}

export function getReminderBySourceId(sourceId: string): Reminder | null {
  const db = getDb();
  return (
    db
      .prepare<Reminder, [string]>(
        `SELECT * FROM reminders WHERE source_id = ? AND status IN ('active', 'snoozed', 'completed') ORDER BY created_at DESC LIMIT 1`
      )
      .get(sourceId) ?? null
  );
}

export function updateReminder(
  id: number,
  params: Partial<Pick<Reminder, "status" | "snooze_until" | "remind_count">>
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }
  if (sets.length === 0) return;

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  values.push(id);

  db.prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values
  );
}

export function snoozeReminder(id: number, durationMs: number): void {
  const snoozeUntil = new Date(Date.now() + durationMs).toISOString();
  updateReminder(id, { status: "snoozed", snooze_until: snoozeUntil });
}

export function completeReminder(id: number): void {
  updateReminder(id, { status: "completed" });
}

export function dismissReminder(id: number): void {
  updateReminder(id, { status: "dismissed" });
}

export function getDueReminders(): Reminder[] {
  const db = getDb();
  return db
    .prepare<Reminder, []>(
      `SELECT * FROM reminders
       WHERE status IN ('active', 'snoozed')
         AND remind_count < max_reminds
         AND (snooze_until IS NULL OR snooze_until <= strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ORDER BY priority ASC, created_at ASC`
    )
    .all();
}

// --- Themes ---

export function createTheme(params: {
  name: string;
  description?: string;
}): Theme {
  const db = getDb();
  return db
    .prepare<Theme, [string, string]>(
      `INSERT INTO themes (name, description) VALUES (?, ?) RETURNING *`
    )
    .get(params.name, params.description ?? "")!;
}

export function getTheme(id: number): Theme | null {
  const db = getDb();
  return db
    .prepare<Theme, [number]>(`SELECT * FROM themes WHERE id = ?`)
    .get(id) ?? null;
}

export function getThemeByName(name: string): Theme | null {
  const db = getDb();
  return db
    .prepare<Theme, [string]>(`SELECT * FROM themes WHERE name = ?`)
    .get(name) ?? null;
}

export function getThemes(status?: ThemeStatus): Theme[] {
  const db = getDb();
  if (status) {
    return db
      .prepare<Theme, [string]>(`SELECT * FROM themes WHERE status = ? ORDER BY last_activity_at DESC`)
      .all(status);
  }
  return db
    .prepare<Theme, []>(`SELECT * FROM themes ORDER BY last_activity_at DESC`)
    .all();
}

export function updateTheme(
  id: number,
  params: Partial<Pick<Theme, "name" | "description" | "status" | "item_count" | "last_activity_at" | "next_report_at" | "report_interval">>
): void {
  const db = getDb();
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }
  if (sets.length === 0) return;

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
  values.push(id);
  db.prepare(`UPDATE themes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function addThemeItem(themeId: number, itemId: number): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO theme_items (theme_id, item_id) VALUES (?, ?)`
  ).run(themeId, itemId);
}

export function getThemeItems(themeId: number): PendingItem[] {
  const db = getDb();
  return db
    .prepare<PendingItem, [number]>(
      `SELECT p.* FROM pending_items p
       JOIN theme_items ti ON ti.item_id = p.id
       WHERE ti.theme_id = ?
       ORDER BY p.created_at DESC`
    )
    .all(themeId);
}

export function getItemThemes(itemId: number): Theme[] {
  const db = getDb();
  return db
    .prepare<Theme, [number]>(
      `SELECT t.* FROM themes t
       JOIN theme_items ti ON ti.theme_id = t.id
       WHERE ti.item_id = ?`
    )
    .all(itemId);
}

// --- Feedback Log ---

export function insertFeedbackLog(params: {
  item_id?: number | null;
  theme_id?: number | null;
  content_type?: string | null;
  source?: string | null;
  system_recommendation?: string | null;
  user_action: string;
  signal_snapshot?: string | null;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO feedback_log (item_id, theme_id, content_type, source, system_recommendation, user_action, signal_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.item_id ?? null,
    params.theme_id ?? null,
    params.content_type ?? null,
    params.source ?? null,
    params.system_recommendation ?? null,
    params.user_action,
    params.signal_snapshot ?? null
  );
}

export function getFeedbackForSignal(
  signalType: string,
  signalValue: string,
  limit: number = 50
): FeedbackLogEntry[] {
  const db = getDb();
  return db
    .prepare<FeedbackLogEntry, [string, string, number]>(
      `SELECT * FROM feedback_log
       WHERE content_type = ? AND source = ?
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(signalType, signalValue, limit);
}

// --- Autonomy Rules ---

export function getAutonomyRule(
  signalType: string,
  signalValue: string
): AutonomyRule | null {
  const db = getDb();
  return db
    .prepare<AutonomyRule, [string, string]>(
      `SELECT * FROM autonomy_rules WHERE signal_type = ? AND signal_value = ?`
    )
    .get(signalType, signalValue) ?? null;
}

export function upsertAutonomyRule(params: {
  signal_type: string;
  signal_value: string;
  learned_action: string;
  confidence: number;
  decision_count: number;
  level: AutonomyLevel;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO autonomy_rules (signal_type, signal_value, learned_action, confidence, decision_count, level)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(signal_type, signal_value) DO UPDATE SET
       learned_action = excluded.learned_action,
       confidence = excluded.confidence,
       decision_count = excluded.decision_count,
       level = excluded.level,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
  ).run(
    params.signal_type,
    params.signal_value,
    params.learned_action,
    params.confidence,
    params.decision_count,
    params.level
  );
}

// --- Trading Signals ---

export function insertTradingSignal(params: {
  source: string;
  ticker: string;
  direction: TradingSignalDirection;
  strength?: number;
  reason?: string | null;
  payload_json?: string | null;
  source_url?: string | null;
}): TradingSignal {
  const db = getDb();
  return db
    .prepare<TradingSignal, [string, string, string, number, string | null, string | null, string | null]>(
      `INSERT INTO trading_signals (source, ticker, direction, strength, reason, payload_json, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`
    )
    .get(
      params.source,
      params.ticker.toUpperCase(),
      params.direction,
      params.strength ?? 0.5,
      params.reason ?? null,
      params.payload_json ?? null,
      params.source_url ?? null
    )!;
}

export function getTradingSignalByUrl(sourceUrl: string): TradingSignal | null {
  const db = getDb();
  return db
    .prepare<TradingSignal, [string]>(
      `SELECT * FROM trading_signals WHERE source_url = ? LIMIT 1`
    )
    .get(sourceUrl) ?? null;
}

export function listTradingSignals(params: {
  ticker?: string;
  source?: string;
  since_hours?: number;
  min_strength?: number;
  limit?: number;
}): TradingSignal[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  if (params.ticker) {
    conditions.push("ticker = ?");
    values.push(params.ticker.toUpperCase());
  }
  if (params.source) {
    conditions.push("source = ?");
    values.push(params.source);
  }
  if (params.since_hours && params.since_hours > 0) {
    conditions.push("captured_at >= datetime('now', ?)");
    values.push(`-${params.since_hours} hours`);
  }
  if (typeof params.min_strength === "number") {
    conditions.push("strength >= ?");
    values.push(params.min_strength);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 500;
  values.push(limit);
  return db
    .prepare<TradingSignal, (string | number)[]>(
      `SELECT * FROM trading_signals ${where} ORDER BY captured_at DESC LIMIT ?`
    )
    .all(...values);
}

export function getSignalClusters(params: {
  since_hours?: number;
  min_sources?: number;
  direction?: TradingSignalDirection;
}): SignalCluster[] {
  const sinceHours = params.since_hours ?? 24;
  const minSources = params.min_sources ?? 2;
  const signals = listTradingSignals({
    since_hours: sinceHours,
    limit: 2000,
    ...(params.direction ? { min_strength: 0 } : {}),
  });
  const groups = new Map<string, TradingSignal[]>();
  for (const sig of signals) {
    if (params.direction && sig.direction !== params.direction) continue;
    const key = `${sig.ticker}::${sig.direction}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(sig);
    groups.set(key, bucket);
  }
  const clusters: SignalCluster[] = [];
  for (const [key, bucket] of groups.entries()) {
    const uniqueSources = new Set(bucket.map((s) => s.source));
    if (uniqueSources.size < minSources) continue;
    const [ticker, direction] = key.split("::") as [string, TradingSignalDirection];
    const totalStrength = bucket.reduce((acc, s) => acc + s.strength, 0);
    const sorted = [...bucket].sort(
      (a, b) => b.captured_at.localeCompare(a.captured_at)
    );
    clusters.push({
      ticker,
      direction,
      sources: Array.from(uniqueSources),
      source_count: uniqueSources.size,
      total_strength: totalStrength,
      avg_strength: totalStrength / bucket.length,
      signal_ids: bucket.map((s) => s.id),
      latest_captured_at: sorted[0]?.captured_at ?? "",
      top_reasons: sorted
        .slice(0, 3)
        .map((s) => s.reason)
        .filter((r): r is string => Boolean(r)),
    });
  }
  clusters.sort((a, b) => {
    if (b.source_count !== a.source_count) return b.source_count - a.source_count;
    return b.total_strength - a.total_strength;
  });
  return clusters;
}

export function markSignalActed(params: {
  ticker: string;
  trade_id: number;
  since_hours?: number;
}): number {
  const db = getDb();
  const sinceHours = params.since_hours ?? 24;
  const result = db
    .prepare<unknown, [number, string, string]>(
      `UPDATE trading_signals
       SET acted_on = 1, trade_id = ?
       WHERE ticker = ? AND acted_on = 0 AND captured_at >= datetime('now', ?)`
    )
    .run(params.trade_id, params.ticker.toUpperCase(), `-${sinceHours} hours`);
  return result.changes;
}

export function getRecentTradingSignalCount(sourceUrl: string): number {
  const db = getDb();
  const row = db
    .prepare<{ c: number }, [string]>(
      `SELECT COUNT(*) as c FROM trading_signals WHERE source_url = ?`
    )
    .get(sourceUrl);
  return row?.c ?? 0;
}

// --- Declarative Agents (orchestration framework Phase 1) ---

export function listAgents(): Agent[] {
  const db = getDb();
  return db.prepare<Agent, []>(`SELECT * FROM agents ORDER BY is_builtin DESC, slug ASC`).all();
}

export function getAgentBySlug(slug: string): Agent | null {
  const db = getDb();
  return db.prepare<Agent, [string]>(`SELECT * FROM agents WHERE slug = ?`).get(slug) ?? null;
}

export function getAgentById(id: number): Agent | null {
  const db = getDb();
  return db.prepare<Agent, [number]>(`SELECT * FROM agents WHERE id = ?`).get(id) ?? null;
}

export interface CreateAgentParams {
  slug: string;
  name: string;
  role?: string;
  goal?: string;
  backstory?: string;
  description?: string;
  prompt: string;
  model?: string;
  max_turns?: number;
  allowed_tools?: string | null;
  allowed_subagents?: string | null;
  critic_agent_slug?: string | null;
  memory_dir: string;
  notify_chat_id?: string | null;
  notify_topic_id?: number | null;
  notify_policy?: AgentNotifyPolicy;
  output_template?: string | null;
  backend?: AgentBackend | null;
  is_builtin?: boolean;
}

export function createAgent(params: CreateAgentParams): Agent {
  const db = getDb();
  return db
    .prepare<Agent, [string, string, string, string, string, string, string, string, number, string | null, string | null, string | null, string, string | null, number | null, string, string | null, string | null, number]>(
      `INSERT INTO agents (
        slug, name, role, goal, backstory, description, prompt, model, max_turns,
        allowed_tools, allowed_subagents, critic_agent_slug, memory_dir,
        notify_chat_id, notify_topic_id, notify_policy, output_template, backend, is_builtin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`
    )
    .get(
      params.slug,
      params.name,
      params.role ?? "",
      params.goal ?? "",
      params.backstory ?? "",
      params.description ?? "",
      params.prompt,
      params.model ?? "sonnet",
      params.max_turns ?? 99999,
      params.allowed_tools ?? null,
      params.allowed_subagents ?? null,
      params.critic_agent_slug ?? null,
      params.memory_dir,
      params.notify_chat_id ?? null,
      params.notify_topic_id ?? null,
      params.notify_policy ?? "always",
      params.output_template ?? null,
      params.backend ?? null,
      params.is_builtin ? 1 : 0,
    )!;
}

export function updateAgent(
  slug: string,
  patch: Partial<Omit<Agent, "id" | "slug" | "is_builtin" | "created_at">>,
): Agent | null {
  const db = getDb();
  const existing = getAgentBySlug(slug);
  if (!existing) return null;

  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === "updated_at") continue;
    fields.push(`${key} = ?`);
    values.push(value as string | number | null);
  }
  if (fields.length === 0) return existing;
  fields.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`);
  values.push(slug);

  return db
    .prepare<Agent, Array<string | number | null>>(
      `UPDATE agents SET ${fields.join(", ")} WHERE slug = ? RETURNING *`
    )
    .get(...values) ?? null;
}

export function deleteAgent(slug: string): void {
  const db = getDb();
  const existing = getAgentBySlug(slug);
  if (!existing) return;
  if (existing.is_builtin) {
    throw new Error(`Cannot delete built-in agent: ${slug}`);
  }
  db.prepare<unknown, [string]>(`DELETE FROM agents WHERE slug = ?`).run(slug);
}

/**
 * Idempotent seed for built-in agents. Inserts if missing; updates only the
 * code-owned fields (prompt, description, model, max_turns, name) so user
 * edits to goal/role/backstory/notify_policy/memory_dir/critic_agent_slug
 * survive across restarts.
 */
export function upsertBuiltinAgent(params: CreateAgentParams): Agent {
  const db = getDb();
  const existing = getAgentBySlug(params.slug);
  if (!existing) {
    return createAgent({ ...params, is_builtin: true });
  }
  // Update code-owned fields unconditionally. For notify_policy and
  // critic_agent_slug, only upgrade from the *schema defaults* — this migrates
  // existing built-ins to the new seed values on first boot after the seed
  // changed, but leaves any user-edited value intact.
  const notifyPolicy = existing.notify_policy === "always" && params.notify_policy
    ? params.notify_policy
    : existing.notify_policy;
  const criticSlug = existing.critic_agent_slug === null && params.critic_agent_slug
    ? params.critic_agent_slug
    : existing.critic_agent_slug;
  const backend = existing.backend === null && params.backend
    ? params.backend
    : existing.backend;

  return db
    .prepare<Agent, [string, string, string, number, string, string, string | null, string | null, string]>(
      `UPDATE agents
       SET name = ?, description = ?, prompt = ?, max_turns = ?, model = ?,
           notify_policy = ?, critic_agent_slug = ?, backend = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE slug = ?
       RETURNING *`
    )
    .get(
      params.name,
      params.description ?? existing.description,
      params.prompt,
      params.max_turns ?? existing.max_turns,
      params.model ?? existing.model,
      notifyPolicy,
      criticSlug,
      backend,
      params.slug,
    )!;
}

export function countJobsUsingAgent(slug: string): number {
  const db = getDb();
  const row = db
    .prepare<{ c: number }, [string]>(`SELECT COUNT(*) as c FROM jobs WHERE agent_name = ?`)
    .get(slug);
  return row?.c ?? 0;
}

export function getJobsUsingAgent(slug: string): Job[] {
  const db = getDb();
  return db
    .prepare<Job, [string]>(`SELECT * FROM jobs WHERE agent_name = ? ORDER BY name`)
    .all(slug);
}
