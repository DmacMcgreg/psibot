export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('web', 'telegram', 'job')),
    source_id TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK(source IN ('web', 'telegram', 'job')),
    source_id TEXT,
    model TEXT NOT NULL,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('cron', 'once')),
    schedule TEXT,
    run_at TEXT,
    max_budget_usd REAL NOT NULL DEFAULT 1.0,
    allowed_tools TEXT,
    use_browser INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'enabled' CHECK(status IN ('enabled', 'disabled', 'completed', 'failed')),
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'error', 'budget_exceeded')),
    result TEXT,
    error TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_source ON chat_messages(source, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_entries_path ON memory_entries(file_path)`,

  // --- YouTube video summaries ---
  `CREATE TABLE IF NOT EXISTS youtube_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    channel_title TEXT NOT NULL,
    url TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    markdown_summary TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    transcript_text TEXT NOT NULL,
    processed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_youtube_videos_video_id ON youtube_videos(video_id)`,

  // sqlite-vec virtual table for vector search (768-dim Gemini text-embedding-004)
  `CREATE VIRTUAL TABLE IF NOT EXISTS youtube_vec USING vec0(
    embedding float[768]
  )`,

  // Mapping table: vec rowid -> video chunk metadata
  `CREATE TABLE IF NOT EXISTS youtube_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
    chunk_type TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_youtube_chunks_video ON youtube_chunks(video_id)`,

  // Session resume & fork support
  `ALTER TABLE agent_sessions ADD COLUMN label TEXT`,
  `ALTER TABLE agent_sessions ADD COLUMN forked_from TEXT`,

  // YouTube playlist processing support
  `ALTER TABLE youtube_videos ADD COLUMN processing_status TEXT DEFAULT 'complete'`,
  `ALTER TABLE youtube_videos ADD COLUMN playlist_item_id TEXT`,
  `ALTER TABLE youtube_videos ADD COLUMN marking_attempts INTEGER DEFAULT 0`,
  `ALTER TABLE youtube_videos ADD COLUMN last_mark_attempt_at TEXT`,
];
