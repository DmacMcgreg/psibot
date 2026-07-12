export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('web', 'telegram', 'job', 'mini-app', 'heartbeat', 'review')),
    source_id TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS agent_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL CHECK(source IN ('web', 'telegram', 'job', 'mini-app', 'heartbeat')),
    source_id TEXT,
    model TEXT NOT NULL,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'success', 'error', 'budget_exceeded')),
    result TEXT,
    error TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    completed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
    processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
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

  // Per-job model selection
  `ALTER TABLE jobs ADD COLUMN model TEXT`,

  // Job pause support
  `ALTER TABLE jobs ADD COLUMN paused_until TEXT`,
  `ALTER TABLE jobs ADD COLUMN skip_runs INTEGER DEFAULT 0`,

  // Link job runs to agent sessions
  `ALTER TABLE job_runs ADD COLUMN session_id TEXT`,

  // Tool call logging
  `CREATE TABLE IF NOT EXISTS tool_uses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_summary TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_uses_session ON tool_uses(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_uses_created ON tool_uses(created_at)`,

  // Agent session lookup indexes
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_sessions_source ON agent_sessions(source, source_id)`,

  // --- YouTube Knowledge Graph ---
  `CREATE TABLE IF NOT EXISTS youtube_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    video_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_youtube_topics_name ON youtube_topics(name)`,

  `CREATE TABLE IF NOT EXISTS youtube_topic_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
    theme_summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(topic_id, video_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_youtube_topic_links_topic ON youtube_topic_links(topic_id)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_topic_links_video ON youtube_topic_links(video_id)`,

  `CREATE TABLE IF NOT EXISTS youtube_topic_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_a_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
    topic_b_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
    co_occurrence_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(topic_a_id, topic_b_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_youtube_topic_relations_a ON youtube_topic_relations(topic_a_id)`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_topic_relations_b ON youtube_topic_relations(topic_b_id)`,

  // --- Paper Trading Portfolio ---
  `CREATE TABLE IF NOT EXISTS portfolio_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    starting_cash REAL NOT NULL DEFAULT 100000.0,
    current_cash REAL NOT NULL DEFAULT 100000.0,
    max_position_pct REAL NOT NULL DEFAULT 5.0,
    max_positions INTEGER NOT NULL DEFAULT 15,
    default_take_profit_pct REAL NOT NULL DEFAULT 10.0,
    rsi_exit_threshold REAL NOT NULL DEFAULT 70.0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS portfolio_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker TEXT NOT NULL,
    sector TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
    shares REAL NOT NULL,
    entry_price REAL NOT NULL,
    entry_date TEXT NOT NULL,
    entry_signal TEXT NOT NULL,
    entry_reasons TEXT NOT NULL,
    entry_atr REAL NOT NULL,
    stop_loss_price REAL NOT NULL,
    take_profit_price REAL NOT NULL,
    current_price REAL,
    current_pnl_pct REAL,
    exit_price REAL,
    exit_date TEXT,
    exit_signal TEXT,
    exit_reasons TEXT,
    realized_pnl REAL,
    screener_date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS portfolio_daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL UNIQUE,
    total_value REAL NOT NULL,
    cash REAL NOT NULL,
    invested REAL NOT NULL,
    open_positions INTEGER NOT NULL,
    day_pnl REAL NOT NULL DEFAULT 0,
    day_pnl_pct REAL NOT NULL DEFAULT 0,
    total_pnl REAL NOT NULL DEFAULT 0,
    total_pnl_pct REAL NOT NULL DEFAULT 0,
    positions_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_portfolio_positions_status ON portfolio_positions(status)`,
  `CREATE INDEX IF NOT EXISTS idx_portfolio_positions_ticker ON portfolio_positions(ticker)`,
  `CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_date ON portfolio_daily_snapshots(snapshot_date)`,
  // Per-job backend selection (claude or glm)
  `ALTER TABLE jobs ADD COLUMN backend TEXT DEFAULT 'claude'`,

  // --- Inbox Capture Pipeline ---
  `CREATE TABLE IF NOT EXISTS pending_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    description TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    platform TEXT,
    profile TEXT,
    captured_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'triaged', 'archived', 'deleted')),
    priority INTEGER,
    category TEXT,
    triage_summary TEXT,
    noteplan_path TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_items_status ON pending_items(status)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_items_url ON pending_items(url)`,

  // --- Reminders ---
  `CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    source_id TEXT,
    status TEXT DEFAULT 'active',
    priority INTEGER DEFAULT 3,
    snooze_until TEXT,
    remind_count INTEGER DEFAULT 0,
    max_reminds INTEGER DEFAULT 5,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status)`,

  // --- Heartbeat Orchestrator: Phase 1 ---

  // Themes (must be created before pending_items references it)
  `CREATE TABLE IF NOT EXISTS themes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'watching', 'archived')),
    item_count INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT,
    next_report_at TEXT,
    report_interval TEXT DEFAULT 'biweekly'
      CHECK(report_interval IN ('weekly', 'biweekly', 'monthly')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_themes_status ON themes(status)`,

  // Extended pending_items columns
  `ALTER TABLE pending_items ADD COLUMN quick_scan_summary TEXT`,
  `ALTER TABLE pending_items ADD COLUMN theme_id INTEGER REFERENCES themes(id)`,
  `ALTER TABLE pending_items ADD COLUMN relevance_window TEXT`,
  `ALTER TABLE pending_items ADD COLUMN watch_status TEXT CHECK(watch_status IN ('watching', 'expired'))`,
  `ALTER TABLE pending_items ADD COLUMN auto_decision TEXT`,
  `ALTER TABLE pending_items ADD COLUMN signal_score REAL`,
  `ALTER TABLE pending_items ADD COLUMN value_type TEXT CHECK(value_type IN ('technique', 'tool', 'actionable', 'no_value'))`,
  `ALTER TABLE pending_items ADD COLUMN extracted_value TEXT`,

  // Theme-Item junction
  `CREATE TABLE IF NOT EXISTS theme_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES pending_items(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(theme_id, item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_theme_items_theme ON theme_items(theme_id)`,
  `CREATE INDEX IF NOT EXISTS idx_theme_items_item ON theme_items(item_id)`,

  // Feedback log
  `CREATE TABLE IF NOT EXISTS feedback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER REFERENCES pending_items(id),
    theme_id INTEGER REFERENCES themes(id),
    content_type TEXT,
    source TEXT,
    system_recommendation TEXT,
    user_action TEXT NOT NULL,
    signal_snapshot TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_log_item ON feedback_log(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_log_created ON feedback_log(created_at)`,

  // Autonomy rules
  `CREATE TABLE IF NOT EXISTS autonomy_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type TEXT NOT NULL,
    signal_value TEXT NOT NULL,
    learned_action TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    decision_count INTEGER NOT NULL DEFAULT 0,
    level TEXT NOT NULL DEFAULT 'manual'
      CHECK(level IN ('manual', 'suggest', 'auto_report', 'silent')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(signal_type, signal_value)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_autonomy_rules_signal ON autonomy_rules(signal_type, signal_value)`,

  // Job notification routing to group chat topics
  `ALTER TABLE jobs ADD COLUMN notify_chat_id TEXT`,
  `ALTER TABLE jobs ADD COLUMN notify_topic_id INTEGER`,

  // Append 'Z' to all existing UTC timestamps so they're unambiguous ISO 8601
  // Safe: WHERE NOT LIKE '%Z' prevents double-append; || 'Z' only appends a single character
  `UPDATE chat_messages SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE agent_sessions SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE jobs SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE jobs SET paused_until = paused_until || 'Z' WHERE paused_until IS NOT NULL AND paused_until NOT LIKE '%Z'`,
  `UPDATE jobs SET run_at = run_at || 'Z' WHERE run_at IS NOT NULL AND run_at NOT LIKE '%Z'`,
  `UPDATE jobs SET last_run_at = last_run_at || 'Z' WHERE last_run_at IS NOT NULL AND last_run_at NOT LIKE '%Z'`,
  `UPDATE jobs SET next_run_at = next_run_at || 'Z' WHERE next_run_at IS NOT NULL AND next_run_at NOT LIKE '%Z'`,
  `UPDATE job_runs SET started_at = started_at || 'Z' WHERE started_at NOT LIKE '%Z'`,
  `UPDATE job_runs SET completed_at = completed_at || 'Z' WHERE completed_at IS NOT NULL AND completed_at NOT LIKE '%Z'`,
  `UPDATE memory_entries SET updated_at = updated_at || 'Z' WHERE updated_at NOT LIKE '%Z'`,
  `UPDATE tool_uses SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE portfolio_config SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE portfolio_positions SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE portfolio_daily_snapshots SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE pending_items SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE reminders SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE reminders SET snooze_until = snooze_until || 'Z' WHERE snooze_until IS NOT NULL AND snooze_until NOT LIKE '%Z'`,

  // Add due_date column to reminders for tiered reminder frequency
  `ALTER TABLE reminders ADD COLUMN due_date TEXT`,

  `UPDATE themes SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE theme_items SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE feedback_log SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE autonomy_rules SET created_at = created_at || 'Z', updated_at = updated_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE youtube_videos SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE youtube_videos SET processed_at = processed_at || 'Z' WHERE processed_at IS NOT NULL AND processed_at NOT LIKE '%Z'`,
  `UPDATE youtube_chunks SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE youtube_topics SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE youtube_topic_links SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,
  `UPDATE youtube_topic_relations SET created_at = created_at || 'Z' WHERE created_at NOT LIKE '%Z'`,

  // Track when triaged items are surfaced to the user
  `ALTER TABLE pending_items ADD COLUMN surfaced_at TEXT`,

  // Topic-level notification muting
  `CREATE TABLE IF NOT EXISTS muted_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    topic_id INTEGER,
    muted_until TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(chat_id, topic_id)
  )`,

  // Job agent assignment and pipeline support
  `ALTER TABLE jobs ADD COLUMN agent_name TEXT`,
  `ALTER TABLE jobs ADD COLUMN agent_prompt TEXT`,
  `ALTER TABLE jobs ADD COLUMN subagents TEXT`,
  `ALTER TABLE jobs ADD COLUMN next_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL`,
  `ALTER TABLE job_runs ADD COLUMN triggered_by_run_id INTEGER REFERENCES job_runs(id)`,

  // Trading signals: unified table for WSB/Reddit firehose, insider filings, analyst ratings, social shadow
  `CREATE TABLE IF NOT EXISTS trading_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('long','short','neutral')),
    strength REAL NOT NULL DEFAULT 0.5,
    reason TEXT,
    payload_json TEXT,
    source_url TEXT,
    captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    acted_on INTEGER NOT NULL DEFAULT 0,
    trade_id INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trading_signals_ticker_captured ON trading_signals(ticker, captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_trading_signals_source_captured ON trading_signals(source, captured_at)`,
  `CREATE INDEX IF NOT EXISTS idx_trading_signals_url ON trading_signals(source_url)`,

  // Declarative agent orchestration: agents table (Phase 1 of orchestration framework)
  `CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    backstory TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'sonnet',
    max_turns INTEGER NOT NULL DEFAULT 99999,
    allowed_tools TEXT,
    allowed_subagents TEXT,
    critic_agent_slug TEXT,
    memory_dir TEXT NOT NULL,
    notify_chat_id TEXT,
    notify_topic_id INTEGER,
    notify_policy TEXT NOT NULL DEFAULT 'always' CHECK(notify_policy IN ('always','on_error','on_change','silent','dynamic')),
    output_template TEXT,
    last_output_hash TEXT,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug)`,

  // Phase 3: per-job overrides for notify policy, output template, change detection
  `ALTER TABLE jobs ADD COLUMN notify_policy TEXT CHECK(notify_policy IN ('always','on_error','on_change','silent','dynamic'))`,
  `ALTER TABLE jobs ADD COLUMN output_template TEXT`,
  `ALTER TABLE jobs ADD COLUMN last_output_hash TEXT`,

  // Phase 6: per-agent backend selection (claude vs glm). NULL = fall back to
  // the job's backend, which in turn defaults to the global DEFAULT_BACKEND.
  `ALTER TABLE agents ADD COLUMN backend TEXT CHECK(backend IN ('claude','glm'))`,

  // Topic embeddings for semantic matching during ingestion (hybrid C).
  // rowid = youtube_topics.id so lookups join cleanly.
  `CREATE VIRTUAL TABLE IF NOT EXISTS youtube_topic_vec USING vec0(
    embedding float[768]
  )`,

  // --- Atlas unified knowledge index (Phase 1) ---
  // Physical projection of every captured item across all source tables.
  // Not a view: FTS5 and vec0 are virtual tables and require concrete rowids.
  // source_id is TEXT to accommodate file paths (scans, memory) as well as
  // the unique keys from pending_items / youtube_videos / trading_signals.
  // metadata_json carries per-kind extras (priority, platform, ticker, etc.).
  `CREATE TABLE IF NOT EXISTS atlas_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT,
    captured_at TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    entity_extracted_at TEXT,
    embedded_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(source_table, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_items_kind_captured ON atlas_items(kind, captured_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_items_captured ON atlas_items(captured_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_items_needs_entities ON atlas_items(id) WHERE entity_extracted_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_items_needs_embedding ON atlas_items(id) WHERE embedded_at IS NULL`,

  // Contentless FTS5 with contentless_delete=1 (SQLite 3.43+).
  // Tokens only — no data duplication — but single-row DELETE by rowid works,
  // so syncFts() can update a row's tokens when its body changes.
  // Rebuilds still replay rows from atlas_items via rebuildFtsAll().
  `CREATE VIRTUAL TABLE IF NOT EXISTS atlas_items_fts USING fts5(title, body, content='', contentless_delete=1)`,

  // Vector store — rowid matches atlas_items.id (managed explicitly in code).
  `CREATE VIRTUAL TABLE IF NOT EXISTS atlas_items_vec USING vec0(embedding float[768])`,

  // --- Atlas entities (Phase 3) ---
  // Canonical entity table. kind is 'ticker' | 'name' | 'topic'; start narrow, expand only when data demands.
  // name_norm is the deterministic normalized key (tickers uppercase stripped of $, names/topics lowercase).
  `CREATE TABLE IF NOT EXISTS atlas_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    name_norm TEXT NOT NULL,
    display_name TEXT NOT NULL,
    mention_count INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(kind, name_norm)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entities_last_seen ON atlas_entities(last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entities_mention_count ON atlas_entities(mention_count DESC)`,

  // Aliases for entity merging. Populated from a seed YAML + weekly Haiku merge proposals.
  `CREATE TABLE IF NOT EXISTS atlas_entity_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES atlas_entities(id) ON DELETE CASCADE,
    alias_norm TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'seed',
    UNIQUE(entity_id, alias_norm)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entity_aliases_norm ON atlas_entity_aliases(alias_norm)`,

  // Item -> entity mentions with per-mention confidence + surrounding context.
  `CREATE TABLE IF NOT EXISTS atlas_entity_mentions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES atlas_items(id) ON DELETE CASCADE,
    entity_id INTEGER NOT NULL REFERENCES atlas_entities(id) ON DELETE CASCADE,
    confidence REAL NOT NULL DEFAULT 0.8,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(item_id, entity_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entity_mentions_item ON atlas_entity_mentions(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entity_mentions_entity ON atlas_entity_mentions(entity_id)`,

  // Entity co-occurrence edges. entity_a < entity_b invariant (sorted-pair insert, template from youtube/graph.ts).
  `CREATE TABLE IF NOT EXISTS atlas_entity_cooccur (
    entity_a INTEGER NOT NULL REFERENCES atlas_entities(id) ON DELETE CASCADE,
    entity_b INTEGER NOT NULL REFERENCES atlas_entities(id) ON DELETE CASCADE,
    weight INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    PRIMARY KEY (entity_a, entity_b),
    CHECK (entity_a < entity_b)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entity_cooccur_a ON atlas_entity_cooccur(entity_a, weight DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_entity_cooccur_b ON atlas_entity_cooccur(entity_b, weight DESC)`,

  // Alias proposal queue — weekly Haiku review, awaiting user approval.
  `CREATE TABLE IF NOT EXISTS atlas_alias_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL REFERENCES atlas_entities(id) ON DELETE CASCADE,
    alias_norm TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    decided_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_atlas_alias_proposals_pending ON atlas_alias_proposals(status) WHERE status='pending'`,

  // --- Atlas synthesis — scan extractions (Phase 4 map-reduce) ---
  `CREATE TABLE IF NOT EXISTS atlas_scan_extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_path TEXT NOT NULL UNIQUE,
    setups_json TEXT NOT NULL DEFAULT '[]',
    indicators_json TEXT NOT NULL DEFAULT '[]',
    regime TEXT,
    hypotheses_json TEXT NOT NULL DEFAULT '[]',
    extracted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  // --- YouTube tag canonical vocabulary (regrowth prevention) ---
  // Mirrors youtube_topics: canonical tag names + embeddings, matched against
  // incoming tags at ingestion time to prevent vocabulary drift.
  `CREATE TABLE IF NOT EXISTS youtube_tag_canonicals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_youtube_tag_canonicals_name ON youtube_tag_canonicals(name)`,

  // rowid = youtube_tag_canonicals.id
  `CREATE VIRTUAL TABLE IF NOT EXISTS youtube_tag_vec USING vec0(
    embedding float[768]
  )`,

  // --- Chat-message FTS for cross-session recall (Hermes port — Phase 7) ---
  // Contentless FTS5 keyed by chat_messages.id. Synced from insertChatMessage
  // (see src/db/queries.ts). Backfilled lazily on first search if empty.
  `CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
    content,
    content='',
    contentless_delete=1
  )`,

  // --- Proactive YouTube Discovery ---
  // Channels to monitor. Seeded from the user's existing youtube_videos history
  // (GROUP BY channel), then extended with manually-added and auto-discovered
  // channels. channel_id is the UC... id required for RSS polling.
  `CREATE TABLE IF NOT EXISTS discovery_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,
    channel_title TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'history'
      CHECK(origin IN ('history','manual','discovered')),
    watch_count INTEGER NOT NULL DEFAULT 0,
    last_polled_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discovery_channels_origin ON discovery_channels(origin)`,

  // Candidate pool: every discovered video, pre- and post-scoring. A video can
  // arrive via multiple sources (UNIQUE(video_id, source)) so we can attribute
  // reach. status tracks it through candidate -> processing -> processed -> surfaced.
  `CREATE TABLE IF NOT EXISTS discovery_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    channel_id TEXT,
    title TEXT,
    published_at TEXT,
    source TEXT NOT NULL CHECK(source IN ('rss','search','related','channel','manual')),
    source_detail TEXT,
    view_count INTEGER,
    duration_seconds INTEGER,
    score REAL,
    score_breakdown_json TEXT,
    status TEXT NOT NULL DEFAULT 'candidate'
      CHECK(status IN ('candidate','processing','processed','rejected','surfaced','dismissed')),
    reason TEXT,
    discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    processed_at TEXT,
    surfaced_at TEXT,
    UNIQUE(video_id, source)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_discovery_candidates_status ON discovery_candidates(status)`,
  `CREATE INDEX IF NOT EXISTS idx_discovery_candidates_score ON discovery_candidates(status, score DESC)`,

  // User interest profile: weighted topics derived from the knowledge graph
  // (recent videos + temporal decay) and feedback_log (positive/negative).
  // The centroid over topic embeddings is computed/cached by profile.ts.
  `CREATE TABLE IF NOT EXISTS discovery_interest_weights (
    topic_id INTEGER PRIMARY KEY REFERENCES youtube_topics(id) ON DELETE CASCADE,
    weight REAL NOT NULL DEFAULT 0,
    last_bumped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  )`,

  // Small key/value store for persisted run state (the lazily-created Telegram
  // topic id, last profile-build timestamp, cached centroid, quota counters).
  `CREATE TABLE IF NOT EXISTS discovery_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // Per-run bookkeeping for observability and rate limiting.
  `CREATE TABLE IF NOT EXISTS discovery_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    channels_polled INTEGER DEFAULT 0,
    searches_run INTEGER DEFAULT 0,
    quota_units_used INTEGER DEFAULT 0,
    candidates_found INTEGER DEFAULT 0,
    processed INTEGER DEFAULT 0,
    surfaced INTEGER DEFAULT 0,
    error TEXT
  )`,

  // Skill lifecycle: jobs can pin skills (comma-separated slugs) whose full
  // bodies are inlined into the job prompt by the executor — deterministic
  // injection at the job seam, no discovery needed.
  `ALTER TABLE jobs ADD COLUMN skills TEXT`,

  // Small key/value store for persisted fleet-integration run state.
  `CREATE TABLE IF NOT EXISTS fleet_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];
