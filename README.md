<div align="center">
  <img src="psibot_logo.jpg" alt="psibot" width="500">
  <h1>🦉 psibot: Always-On AI Agent for Telegram</h1>
  <p><strong>Your own personal AI assistant that runs 24/7 on your Mac. Powered by Claude Agent SDK + your Max subscription. $0 API costs.</strong></p>
  <p>
    <img src="https://img.shields.io/badge/Claude_Agent_SDK-Opus_4.6-d4a574" alt="Claude Agent SDK">
    <img src="https://img.shields.io/badge/cost-$0_API_fees-brightgreen" alt="$0 API costs">
    <img src="https://img.shields.io/badge/Telegram-bot-26A5E4?logo=telegram&logoColor=white" alt="Telegram bot">
    <img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun" alt="Bun">
    <img src="https://img.shields.io/badge/TypeScript-5.7+-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  </p>
</div>

A persistent, multimodal AI assistant that runs on your own hardware as a macOS daemon. Chat through Telegram with voice, images, and text. Manage scheduled tasks through a web dashboard. Let it work autonomously while you sleep.

**Built on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)** &mdash; authenticates via OAuth with your existing Claude Max subscription. No API keys, no per-token billing, no surprise costs. If you're already paying for Max, psibot is effectively free to run.

> **How is this different from [OpenClaw](https://github.com/openclaw/openclaw)?** OpenClaw is a general-purpose AI assistant framework. psibot is purpose-built for a single user running Claude on their own Mac &mdash; optimized for Telegram, designed as an always-on daemon, and requires zero API spend beyond your existing Max plan.

## ✨ Key Features

**$0 API Costs** &mdash; Uses your Claude Max subscription via OAuth. No API keys, no per-token billing. Run Opus, Sonnet, and Haiku across all agents at no additional cost.

**Always-On Daemon** &mdash; Runs as a macOS LaunchAgent. Survives reboots, handles wake/sleep cycles, stays connected to Telegram 24/7, and runs autonomous tasks on a schedule.

**Telegram-Native** &mdash; First-class Telegram bot with voice messages, photo understanding, text-to-speech replies, and inline command menus. Not a web wrapper &mdash; a real bot experience.

**Multimodal AI** &mdash; Generates and edits images (Gemini), speaks with a neural voice (Edge TTS), transcribes voice messages (parakeet STT), and analyzes YouTube videos with semantic search.

**Persistent Memory** &mdash; Maintains knowledge files, daily logs, and structured memory across sessions. Learns about you over time and remembers context between conversations.

**Autonomous Subagents** &mdash; Spawns specialized agents: a coder (isolated git worktrees), a researcher (browser automation), an image generator, and an audio processor &mdash; each on the optimal model.

**Scheduled Tasks** &mdash; Cron-based job scheduling with budget controls. Periodic maintenance, reminders, or any recurring prompt with configurable quiet hours.

**MCP Tool Ecosystem** &mdash; Extensible via Model Context Protocol servers. Built-in tools for memory, browser automation, Telegram media, git worktrees, YouTube analysis, and more.

**Web Dashboard** &mdash; HTMX + SSE streaming interface for real-time chat, job management, memory browsing, and log viewing.

<table align="center">
  <tr align="center">
    <th><p align="center">🎨 Image Editing</p></th>
    <th><p align="center">🌐 Browser Automation</p></th>
    <th><p align="center">🔊 Agentic Audio</p></th>
  </tr>
  <tr>
    <td align="center"><p align="center"><img src="image_editing.gif" width="300"></p></td>
    <td align="center"><p align="center"><img src="agent_browser.gif" width="300"></p></td>
    <td align="center"><p align="center"><img src="agentic_audio.gif" width="300"></p></td>
  </tr>
  <tr>
    <td align="center">Generate &bull; Edit &bull; Send</td>
    <td align="center">Navigate &bull; Read &bull; Research</td>
    <td align="center">Transcribe &bull; Speak &bull; Listen</td>
  </tr>
</table>

## 💡 Why Claude Agent SDK + Max?

Most AI agent frameworks (OpenClaw, nanobot, etc.) require API keys and charge per-token. If you're already paying for Claude Max, that's wasted money. psibot takes a different approach:

| | API-based agents | psibot (Max subscription) |
|---|---|---|
| **Authentication** | API key management | OAuth via `claude` CLI |
| **Cost model** | Pay per token | Fixed monthly subscription |
| **Bill risk** | Uncapped, usage-dependent | Zero additional cost |
| **Model access** | Depends on tier/budget | Opus, Sonnet, Haiku &mdash; all included |
| **Setup** | Generate keys, set budgets, monitor spend | `claude login` and go |

## 🏗️ Architecture

<p align="center">
  <img src="architecture.png" alt="psibot architecture" width="800">
</p>

## 🚀 Quick Start

### Prerequisites

- macOS (Apple Silicon or Intel)
- Xcode Command Line Tools (`xcode-select --install`)
- [Claude CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`) &mdash; authenticated with `claude login`
- A [Telegram bot token](https://core.telegram.org/bots#botfather)

### Automated Setup

The setup script handles everything from a fresh clone: Homebrew, Bun, dependencies, `.env` configuration, CLI linking, and daemon installation.

```bash
git clone https://github.com/DmacMcgreg/psibot.git
cd psibot
bash scripts/setup.sh
```

The script will:
1. Install Homebrew (if missing), then `bun`, `sqlite`, and `yt-dlp`
2. Install `uv` (Python tool runner)
3. Run `bun install` for node packages
4. Create `.env` from template and prompt for your Telegram bot token and user IDs
5. Link the `psibot` CLI and install the macOS LaunchAgent daemon
6. Optionally install `edge-tts`, `mlx-audio`, and `tailscale`

After setup, start the daemon:

```bash
psibot start
```

### Uninstall

To fully remove psibot (daemon, CLI, and optionally data/dependencies):

```bash
bash scripts/uninstall.sh
```

### Manual Setup

<details>
<summary>If you prefer to set things up manually</summary>

#### 1. Clone and install

```bash
git clone https://github.com/DmacMcgreg/psibot.git
cd psibot
bun install
bun link          # Makes the 'psibot' command available globally
```

#### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
ALLOWED_TELEGRAM_USER_IDS=123456789
PORT=3141
DEFAULT_MODEL=claude-opus-4-6
```

#### 3. Run

```bash
# Development (with hot reload)
bun run dev

# Production
bun run start
```

#### 4. Deploy as daemon (macOS)

```bash
psibot install   # Install LaunchAgent
psibot start     # Start the daemon
psibot status    # Check status
psibot logs      # Tail logs
```

</details>

### Optional Dependencies

| Tool | Purpose | Install |
|------|---------|---------|
| [uv](https://github.com/astral-sh/uv) | Python tool runner for audio tools | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| [mlx-audio](https://github.com/lucasnewman/mlx-audio) | STT (parakeet) on Apple Silicon | `uv tool install mlx-audio` |
| [edge-tts](https://github.com/rany2/edge-tts) | Text-to-speech via Microsoft Edge neural voices | `pip install edge-tts` |
| [Gemini API key](https://ai.google.dev) | Image generation via Gemini | Set `GEMINI_API_KEY` in `.env` |
| [Tailscale](https://tailscale.com) | Remote access to web dashboard + Funnel for webhooks + Wake-on-LAN packets | Install from [tailscale.com/download](https://tailscale.com/download) |

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | (required) | Telegram bot API token |
| `ALLOWED_TELEGRAM_USER_IDS` | (required) | Comma-separated authorized user IDs |
| `PORT` | `3141` | Web dashboard port |
| `DEFAULT_MODEL` | `claude-opus-4-6` | Model for the main agent |
| `DEFAULT_MAX_BUDGET_USD` | `1.00` | Max cost per agent run |
| `HEARTBEAT_ENABLED` | `true` | Enable periodic autonomous heartbeat |
| `HEARTBEAT_INTERVAL_MINUTES` | `30` | Minutes between heartbeats |
| `HEARTBEAT_QUIET_START` | `23` | Quiet hours start (hour, 24h) |
| `HEARTBEAT_QUIET_END` | `8` | Quiet hours end (hour, 24h) |
| `HEARTBEAT_MAX_BUDGET_USD` | `0.50` | Max cost per heartbeat run |
| `PSIBOT_DIR` | `~/.psibot` | Worktree and repo storage |
| `YOUTUBE_CLIENT_ID` | (optional) | Google OAuth client ID for YouTube |
| `YOUTUBE_CLIENT_SECRET` | (optional) | Google OAuth client secret |
| `YOUTUBE_SOURCE_PLAYLIST_ID` | (optional) | Playlist to process videos from |
| `YOUTUBE_DESTINATION_PLAYLIST_ID` | (optional) | Playlist to move processed videos to |
| `GEMINI_API_KEY` | (optional) | Gemini API key for image gen + video embeddings |

### Webhook Mode (Optional)

For reliable message delivery through network changes and sleep/wake cycles, enable webhook mode via Tailscale Funnel:

```env
TELEGRAM_WEBHOOK_ENABLED=true
TELEGRAM_WEBHOOK_HOST=your-machine.tailnet-name.ts.net
TELEGRAM_WEBHOOK_PORT=8443
```

### YouTube Video Processing (Optional)

psibot can analyze YouTube videos &mdash; extracting transcripts, generating structured summaries with Claude, and storing vector embeddings for semantic search. Transcripts are pulled via `yt-dlp` (no API quota), while playlist management uses the YouTube Data API via OAuth.

#### 1. Create Google OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a project (or select an existing one)
3. Enable the **YouTube Data API v3** under APIs & Services > Library
4. Go to APIs & Services > Credentials > **Create Credentials** > OAuth client ID
5. Application type: **Web application**
6. Add an authorized redirect URI:
   - With Tailscale Funnel: `https://your-machine.tailnet-name.ts.net/auth/youtube/callback`
   - Local only: `http://127.0.0.1:3141/auth/youtube/callback` (use your `PORT` value)
7. Copy the **Client ID** and **Client Secret**

If your app is in "Testing" mode on the OAuth consent screen, add your Google account as a test user.

#### 2. Add credentials to `.env`

```env
YOUTUBE_CLIENT_ID=your-client-id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=your-client-secret
GEMINI_API_KEY=your-gemini-key   # Required for vector embeddings
```

#### 3. Authorize the app

With psibot running, ask the agent to start YouTube OAuth setup (or use the `youtube_oauth_setup` tool). It will return a Google authorization URL. Open it in your browser, grant access, and the callback saves tokens to `~/.psibot/youtube-oauth.json`. Tokens auto-refresh; you only need to do this once.

#### 4. Get playlist IDs

Playlist IDs are the string after `list=` in a YouTube playlist URL:

```
https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
                                      ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                      This is the playlist ID
```

Add them to `.env`:

```env
YOUTUBE_SOURCE_PLAYLIST_ID=PLxxxxx      # Videos to process (e.g. "Watch Later")
YOUTUBE_DESTINATION_PLAYLIST_ID=PLyyyyy  # Where processed videos are moved
```

The agent processes videos from the source playlist, analyzes them, and moves them to the destination. You can also analyze individual videos by URL without any playlist configuration.

#### Agent tools

| Tool | Description |
|------|-------------|
| `youtube_summarize` | Analyze a single video by URL or ID |
| `youtube_search` | Semantic search across all stored video analyses |
| `youtube_list` | List stored videos with keyword/channel filters |
| `youtube_get` | Get full analysis for a specific video |
| `youtube_process_playlist` | Batch-process videos from source playlist |
| `youtube_playlist_status` | Show processing stats and pending videos |

## 💬 Telegram Commands

| Command | Description |
|---------|-------------|
| `/ask <prompt>` | Send a message to the agent |
| `/jobs` | List scheduled jobs |
| `/memory` | Browse agent memory |
| `/status` | Show system status |
| `/verbose` | Toggle tool call feedback |

Send **voice messages** for automatic transcription and response. Send **photos** with optional captions for image-aware conversations.

## 📁 Project Structure

```
src/
  index.ts                  # Entry point
  config.ts                 # Zod-validated env config
  agent/
    index.ts                # AgentService (query with MCP + subagents)
    tools.ts                # agent-tools MCP server
    media-tools.ts          # media-tools MCP server
    subagents.ts            # Subagent definitions
    prompts.ts              # System prompt builder
  telegram/
    index.ts                # Bot setup + auth middleware
    commands.ts             # Command & media handlers
    format.ts               # Message formatting
    webhook.ts              # Webhook mode (Tailscale Funnel)
  web/
    index.ts                # Hono app + IP allowlist
    routes/                 # Chat, jobs, memory, logs
    views/                  # HTMX templates
  heartbeat/
    index.ts                # Periodic autonomous tasks
  scheduler/
    index.ts                # Cron + one-off job scheduling
    executor.ts             # Job execution via agent
  memory/
    index.ts                # Knowledge files, search, daily logs
  browser/
    index.ts                # Browser automation wrapper
  db/
    index.ts                # SQLite (WAL mode)
    schema.ts               # Migrations
    queries.ts              # Prepared statements
  shared/
    types.ts                # Type definitions
    logger.ts               # Timestamped logging
knowledge/
  IDENTITY.md               # Agent persona
  USER.md                   # Learned user context
  TOOLS.md                  # Tool documentation
  HEARTBEAT.md              # Maintenance task definitions
  memory.md                 # Persistent memory
  memory/                   # Daily logs
data/
  app.db                    # SQLite database
  images/                   # Generated images
  audio/                    # TTS output
  media/                    # Inbound Telegram media
```

## 🧱 Stack

| Component | Technology |
|-----------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Agent | [@anthropic-ai/claude-agent-sdk](https://github.com/anthropics/claude-agent-sdk) |
| Bot | [grammy](https://grammy.dev) |
| Web | [Hono](https://hono.dev) + HTMX + SSE |
| Database | SQLite (bun:sqlite, WAL mode, FTS) |
| Scheduling | [croner](https://github.com/hexagon/croner) |
| Validation | [Zod](https://zod.dev) |
| Image Gen | [Gemini API](https://ai.google.dev) |
| TTS | [Edge TTS](https://github.com/rany2/edge-tts) (Sonia British neural voice) |
| STT | [parakeet](https://docs.nvidia.com/nemo-framework/user-guide/latest/nemotoolkit/asr/models.html#parakeet) (via mlx-audio) |
| Browser | [agent-browser](https://github.com/anthropics/agent-browser) |

## Notes

- **macOS Full Disk Access**: If the project lives in `~/Documents` (or `~/Desktop`, `~/Downloads`), Bun needs Full Disk Access. Grant it in **System Settings > Privacy & Security > Full Disk Access**, then add the Bun binary (typically `/opt/homebrew/bin/bun`). Without this, the daemon will fail with TCC permission errors.
- **mlx-audio PATH**: `uv tool install mlx-audio` places commands in `~/.local/bin/`. The launcher script includes this in PATH automatically, but your interactive shell also needs it &mdash; `uv` adds it to your shell profile during installation.
- **LaunchAgent quirk**: The launcher script uses `bun --cwd` instead of plist `WorkingDirectory` to avoid a Bun `getcwd()` deadlock under launchd
- **PATH for launchd**: The launcher exports `~/.local/bin` and `/opt/homebrew/bin` &mdash; needed for mlx-audio commands and the `claude` CLI (Agent SDK OAuth)

## Acknowledgments

Inspired by [OpenClaw](https://github.com/openclaw/openclaw) and [nanobot](https://github.com/HKUDS/nanobot). psibot started as an experiment to see how far you could push the Claude Agent SDK with just a Telegram bot and a Max subscription.

## License

MIT
