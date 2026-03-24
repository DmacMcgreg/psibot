# telegram-claude-code

Personal AI assistant: Telegram bot + web dashboard, powered by Claude Agent SDK.

## Stack

- **Runtime**: Bun
- **Web**: Hono + HTMX + SSE streaming
- **Bot**: grammy (Telegram)
- **Agent**: @anthropic-ai/claude-agent-sdk (query API with MCP servers + subagents)
- **DB**: SQLite via bun:sqlite (WAL mode, FTS for search)
- **Scheduling**: croner (cron + one-off jobs)
- **Validation**: Zod (config, tool schemas)

## Commands

- `bun run dev` - Start with --watch
- `bun run start` - Production start
- `bun run tsc --noEmit` - Typecheck
- `psibot install|start|stop|restart|status|logs` - Daemon management

## Important Notes

- The Claude Agent SDK uses OAuth automatically (no ANTHROPIC_API_KEY needed)
- The daemon runs as a macOS LaunchAgent (`com.psibot.daemon`)
- `bun` needs Full Disk Access in macOS settings (project is in ~/Documents which is TCC-protected)
- The launcher script uses `bun --cwd` instead of launchd WorkingDirectory to avoid a Bun getcwd() deadlock under launchd
- The launcher script must export PATH with `/opt/homebrew/bin` - the Agent SDK needs `claude` CLI in PATH for OAuth, and launchd's default PATH is only `/usr/bin:/bin:/usr/sbin:/sbin`

## Project Structure

```
src/
  index.ts                  # Entry point, wires services with late-binding closures
  config.ts                 # Zod env schema (telegram, heartbeat, psibot config)
  agent/
    index.ts                # AgentService - runs query() with MCP servers + subagents
    tools.ts                # "agent-tools" MCP server (memory, knowledge, browser, jobs, telegram media, worktrees)
    media-tools.ts          # "media-tools" MCP server (image gen, Edge TTS, parakeet STT)
    subagents.ts            # AgentDefinition records (image-generator, audio-processor, coder, researcher)
    prompts.ts              # System prompt builder (loads IDENTITY/USER/TOOLS + memory)
  heartbeat/
    index.ts                # HeartbeatRunner - periodic maintenance cron with quiet hours
  scheduler/
    index.ts                # Scheduler - croner-based job scheduling
    executor.ts             # JobExecutor - runs agent for scheduled jobs
  telegram/
    index.ts                # Bot creation, auth middleware, handler registration
    commands.ts             # Command handlers (/ask, /jobs, /memory, etc.) + voice handler
    format.ts               # Message formatting (splitMessage, formatCost, etc.)
  memory/
    index.ts                # MemorySystem - knowledge file I/O, search, daily logs
  browser/
    index.ts                # agent-browser subprocess wrapper
  db/
    index.ts                # SQLite init + singleton
    schema.ts               # Migration SQL statements
    queries.ts              # Prepared statement wrappers
  web/
    index.ts                # Hono app setup + IP allowlist middleware
    routes/
      chat.ts               # SSE-based agent chat streaming
      jobs.ts               # Job CRUD routes
      memory.ts             # Memory viewer routes
      logs.ts               # Log viewer routes
    views/
      layout.ts             # HTML shell
      chat.ts               # Chat UI
      jobs.ts               # Jobs UI
      memory.ts             # Memory UI
      logs.ts               # Logs UI
      components.ts         # Shared HTML components
  shared/
    types.ts                # MessageSource, AgentRunOptions, Job, etc.
    logger.ts               # createLogger(module) -> timestamped console output
    html.ts                 # HTML utilities
knowledge/
  IDENTITY.md               # Agent persona definition
  USER.md                   # Learned user context (updated by agent)
  TOOLS.md                  # Available infrastructure (audio, image, browser, coding)
  HEARTBEAT.md              # Periodic maintenance task definitions
  memory.md                 # Agent persistent memory (sections managed by tools)
  memory/                   # Daily log files (YYYY-MM-DD.md)
data/
  app.db                    # SQLite database
  images/                   # Generated images (Gemini API)
  audio/tts/                # Generated speech audio (Edge TTS)
  stt/                      # Transcription output files (parakeet)
  media/inbound/            # Downloaded telegram voice messages
public/
  htmx.min.js              # HTMX client
  sse.js                   # SSE client extension
```

## Architecture Patterns

### Late-Binding Closures
Agent, Scheduler, and Bot form a circular dependency. Resolved by declaring `let scheduler` / `let bot` before constructing AgentService, passing closures `() => scheduler.reload()` and `() => bot ?? null` that capture future references.

### MCP Server Pattern
Tools are defined with `createSdkMcpServer` + `tool()` from the SDK. Each tool returns `{ content: [{ type: "text", text }] }` or `{ ..., isError: true }`. Dependencies captured via closure.

### Subagent Spawning
`query()` accepts `agents: Record<string, AgentDefinition>`. The main agent spawns subagents via the built-in `Task` tool. Subagents inherit MCP servers from parent.

### Subprocess Pattern
External tools (agent-browser, mlx_audio.stt.generate, edge-tts) run via `Bun.spawn()` with piped stdout/stderr, captured via `new Response(proc.stdout).text()`. STT installed via `uv tool install mlx-audio`, TTS via `pip install edge-tts`.

### Network Access
The daemon uses **Tailscale serve** (not funnel) to expose `/tma` (Mini App) over HTTPS within the tailnet only. No public internet exposure. The web dashboard (`/chat`, `/jobs`, `/memory`, `/logs`) is protected by an IP allowlist (localhost + Tailscale IPs). Mini App API routes (`/tma/api/*`) require Telegram HMAC-SHA256 auth.

### Shared User Context
`knowledge/USER.md` is a symlink to `~/Documents/NotePlan-Notes/Notes/20 - Areas/personal-ai-context.md`. This file is the single source of truth for user context, shared across PsiBot, Claude Code, and Claude Desktop (via MCP filesystem server).

## Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot API token |
| `ALLOWED_TELEGRAM_USER_IDS` | (required) | Comma-separated user IDs |
| `TELEGRAM_GROUP_CHAT_IDS` | "" | Comma-separated group chat IDs (negative numbers) |
| `PORT` | 3000 | Web server port |
| `DEFAULT_MODEL` | claude-opus-4-6 | Model for agent |
| `HEARTBEAT_ENABLED` | true | Enable periodic heartbeat |
| `HEARTBEAT_INTERVAL_MINUTES` | 30 | Heartbeat frequency |
| `HEARTBEAT_QUIET_START` | 23 | Quiet hours start (hour) |
| `HEARTBEAT_QUIET_END` | 8 | Quiet hours end (hour) |
| `HEARTBEAT_MAX_BUDGET_USD` | 0.50 | Max cost per heartbeat run |
| `PSIBOT_DIR` | ~/.psibot | Worktree + repo storage |

## Instance Config

See @INSTANCE.md for deployment-specific configuration (Telegram group/topic IDs, job routing, Tailscale hostname, NotePlan paths). This file is gitignored.

## Telegram Group Topic Routing

Jobs can route notifications to specific group chat topics via `notify_chat_id` and `notify_topic_id` columns in the `jobs` table. If unset, notifications go to the user's DM. The heartbeat digest also supports topic routing via `digestChatId` and `digestTopicId` on `HeartbeatRunner`.

If the group topic send fails, notifications fall back to DM.

## Inbox Triage & NotePlan Tag Flow

Items flow: **captured** → `pending` → **triaged** → `triaged` → **surfaced in digest** → **user action** → `archived`/`deleted`

User actions come from two sources — Telegram inline buttons and manual NotePlan tags. Both must stay in sync:

| Tag | Telegram Button | DB Effect | NotePlan Effect |
|-----|----------------|-----------|-----------------|
| `research` | Research | `status: archived`, `auto_decision: deep_research_queued` | Tag added to frontmatter |
| `watch` | Watch | `status: archived`, `watch_status: watching` | Tag added to frontmatter |
| `archived` | Archive | `status: archived` | Tag added to frontmatter |
| `dropped` | Drop | `status: deleted` | Tag added to frontmatter |

The **inbox watcher** (`src/heartbeat/inbox-watcher.ts`) runs each heartbeat tick and scans all items with `noteplan_path`. It reads frontmatter tags and syncs DB status, so manually adding a `research` or `watch` tag in NotePlan triggers the same pipeline as pressing the Telegram button.

Key constraint: items must leave `triaged` status after user action, otherwise they resurface in the next digest.

## Database Tables

- **chat_messages** - Individual messages (session_id, role, content, source, cost)
- **agent_sessions** - Conversation sessions (source, model, total_cost)
- **jobs** - Scheduled tasks (cron/once, prompt, budget, status, notify_chat_id, notify_topic_id)
- **job_runs** - Execution records (status, result, cost, duration)
- **memory_entries** - Indexed knowledge files (file_path, title, content for FTS)
- **pending_items** - Captured URLs from Reddit/GitHub/manual (status, priority, tags, noteplan_path, watch_status, auto_decision)
