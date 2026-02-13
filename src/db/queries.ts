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
       updated_at = datetime('now')`
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
}): Job {
  const db = getDb();
  return db
    .prepare<Job, [string, string, string, string | null, string | null, number, string | null, number, string | null]>(
      `INSERT INTO jobs (name, prompt, type, schedule, run_at, max_budget_usd, allowed_tools, use_browser, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      params.model ?? null
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
      | "paused_until"
      | "skip_runs"
      | "status"
      | "last_run_at"
      | "next_run_at"
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

  sets.push(`updated_at = datetime('now')`);
  values.push(id);

  db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteJob(id: number): void {
  const db = getDb();
  db.prepare(`DELETE FROM jobs WHERE id = ?`).run(id);
}

// --- Job Runs ---

export function createJobRun(jobId: number): JobRun {
  const db = getDb();
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
  }
): void {
  const db = getDb();
  db.prepare(
    `UPDATE job_runs SET status = ?, result = ?, error = ?, cost_usd = ?, duration_ms = ?, completed_at = datetime('now')
     WHERE id = ?`
  ).run(
    params.status,
    params.result ?? null,
    params.error ?? null,
    params.cost_usd ?? null,
    params.duration_ms ?? null,
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
       updated_at = datetime('now')`
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

export function getAllMemoryEntries(): MemoryEntry[] {
  const db = getDb();
  return db
    .prepare<MemoryEntry, []>(`SELECT * FROM memory_entries ORDER BY file_path`)
    .all();
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
