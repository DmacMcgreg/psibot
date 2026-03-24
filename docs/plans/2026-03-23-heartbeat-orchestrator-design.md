# Heartbeat Orchestrator: Autonomous Inbox Processing & Knowledge Building

**Date:** 2026-03-23
**Status:** Design Complete — Ready for Implementation Planning

## Overview

Transform the PsiBot heartbeat from a single maintenance agent into an autonomous inbox processing orchestrator that triages, researches, clusters, and surfaces knowledge — with progressive autonomy earned through user feedback.

The system processes captured items (Reddit saves, GitHub stars, YouTube video summaries, Chrome extension captures) through a multi-phase pipeline, builds interconnected research notes in NotePlan, detects thematic trends, and surfaces only what matters via concise Telegram digests. Deep research spawns parallel subagents with full web and browser tooling. Over time, the system learns user preferences and acts autonomously on routine decisions while always surfacing novel or ambiguous items for human judgment.

## Design Principles

1. **Progressive autonomy** — Start manual, earn trust through consistent feedback. Never assume.
2. **Compress knowledge upward** — Full notes exist but users interact at the shallowest sufficient layer.
3. **No notification spam** — Batch digests, not per-item messages.
4. **Contextual intelligence** — Connect items to active codebases, workflow manifest, and existing research to make smart decisions without accumulated feedback.
5. **Flexible research depth** — The orchestrator decides which research threads to spawn based on the item, not a rigid template.
6. **Autonomous but auditable** — Every auto-decision is logged with the signals that triggered it.
7. **Extract value, don't categorize** — The default assumption is "there's something useful here, since I saved it." Triage extracts the transferable nugget (technique, tool, method, actionable info), not just a surface-level category.
8. **Knowledge must be useful** — Don't accumulate inert reference notes. Every stored item must connect to a theme, feed into a workflow, or be actionable. If it can't, drop it.

## Architecture

### Heartbeat Tick Pipeline

Each heartbeat tick (every 30 minutes) runs this deterministic pipeline. The heartbeat is TypeScript code that calls specific functions — agents are tools it uses, not the orchestrator.

```
tick()
  |-- Phase 1: Intake
  |   |-- Pull new pending_items (status = 'pending')
  |   |-- Tier 0: metadata extraction (free, no LLM)
  |   |-- Tier 1: GLM value-extraction triage
  |   |     -> technique/method, tool/resource, actionable, or no value
  |   |-- Drop no-value items, route rest to Phase 2
  |
  |-- Phase 2: Research
  |   |-- Quick scan all Investigate items (GLM + web search)
  |   |-- Check contextual intelligence signals against each item
  |   |-- Auto deep dive on strong-signal items (parallel subagents)
  |   |-- Cluster detection: group related items into themes
  |
  |-- Phase 3: Knowledge Integration
  |   |-- Write/update NotePlan research notes with [[wikilinks]]
  |   |-- Update theme clusters in database
  |   |-- Check watched themes for new activity
  |   |-- Check time-sensitive items for approaching deadlines
  |
  |-- Phase 4: Surfacing
      |-- Compose single Telegram digest message
      |-- Include: items processed count, top findings, trend alerts
      |-- Attach inline keyboards for items needing decisions
      |-- Skip sending if nothing noteworthy this tick
```

### Separation of Concerns

The current heartbeat maintenance tasks (worktree checks, trading bot monitoring, memory maintenance) move to **separate scheduled cron jobs**. The heartbeat becomes purely the inbox processing orchestrator.

The current `knowledge/HEARTBEAT.md` agent-prompt-driven approach is replaced by deterministic code.

### Concurrency

Quick scans and deep dives run in parallel via `Promise.all()` — items are independent and don't need sequential processing.

## Triage: Value Extraction Model

The previous 5-category system (research/reference/actionable/entertainment/not_worth_keeping) categorized items by surface framing. A post about AI-generated profile pictures got tagged "entertainment" when the real value was the image generation technique. A productivity tip from a meme subreddit got missed because the source looked casual.

The new model asks **"what can be extracted from this that's useful?"** instead of "what type of content is this?"

### How Triage Works

Triage uses GLM with **rich content extraction** (already implemented — fetches Reddit post text + top comments, strips HTML for other URLs, up to 3000 chars of clean text). The triage prompt analyzes actual content against the workflow manifest.

For each item, triage extracts:

1. **Transferable value** — the technique, method, tool, pattern, or insight that exists regardless of how the content is framed
2. **Relevance signal** — how this connects to active projects, workflow gaps, or existing themes
3. **Recommended action** — what should happen next

### Triage Outcomes

| Extracted Value | Action | Example |
|---|---|---|
| **Technique or method** (prompting pattern, CLI workflow, config trick, image/video generation method) | Extract the technique, file under relevant theme, quick scan for more context | Reddit meme post that demonstrates a novel JSON prompting technique |
| **Tool or resource to evaluate** (new framework, library, CLI tool, service) | Route to research pipeline for investigation | GitHub repo for a new agent orchestration framework |
| **Actionable information** (needs response, time-sensitive, requires a decision) | Create task/reminder, surface in digest | Security advisory for a dependency in your stack |
| **No extractable value** (genuinely just a meme, joke, or content with nothing transferable) | Drop | A funny cat picture with no underlying technique |

Key changes from the previous system:
- **No "reference" category** — a reference that never gets used is dead weight. Items either have extractable value that connects to themes/workflows, or they don't.
- **No "entertainment" category** — the system tries to extract value first. Only if there's genuinely nothing transferable does it drop. "Entertainment" framing doesn't disqualify useful content.
- **NotePlan notes are NOT created at triage time** (already implemented). Notes only come from the research pipeline after actual investigation.
- **Triage always explains what it extracted** — the summary field contains the transferable nugget, not just "this is about X."

### Compatibility with Existing Implementation

The current triage codebase (improved in the March 23 session with rich content extraction, Reddit JSON API fetching, and better prompts) is preserved. Changes:
- Triage prompt is updated to use value-extraction framing
- Category field stores the extracted value type instead of the old categories
- Priority scoring uses the workflow manifest for relevance
- YouTube videos (now auto-inserted into pending_items after processing) flow through the same pipeline

## Workflow Manifest

A living document that gives agents context about what the user is actively building and what gaps exist.

**Canonical location:** `~/Documents/NotePlan-Notes/Notes/10 - Projects/00-workflow-manifest.md`

**Contents:**
- Active projects and their current phase (PsiBot, ScanAI, trading bot, etc.)
- Current toolchain and workflow (how code is managed, deployed, communicated)
- Known gaps and pain points ("this part of my workflow is manual")
- Things actively being evaluated or built toward
- Criteria for "revolutionary" — what makes something worth immediate attention

**Access:**
- PsiBot: `knowledge/WORKFLOW.md` symlinked to the NotePlan file
- Claude Code: Referenced via CLAUDE.md path
- Claude Desktop: MCP filesystem server with instructions to read for background context on generic tasks

## Contextual Intelligence Signals

Beyond learned feedback, the system uses real-time signals to make autonomous decisions without accumulated training data.

### Direct Relevance Signals (auto deep dive, no feedback needed)

- Item references a package/tool in active codebases (`package.json`, `bun.lock`, imports)
- Item is a new release of something previously researched
- Item author/source has been consistently valued in past feedback
- Item directly addresses a gap listed in the workflow manifest

### Momentum Signals (auto deep dive above threshold)

- Rapid community growth (stars, forks, mentions)
- Multiple independent sources covering the same thing in a short window
- User's own saves clustering around the same topic within days

### Decay Signals (auto-archive or escalate)

- Time-sensitive items approaching their relevance window
- Watched themes with no new activity for extended periods
- Items snoozed multiple times without action

A strong enough signal overrides conservative feedback thresholds — a critical Bun security patch doesn't need 15 accumulated decisions to warrant attention.

## Progressive Autonomy

### Feedback Ledger

Every user decision on a surfaced item is logged:

```
feedback_log:
  item_id, theme_id, content_type, source,
  system_recommendation, user_action,
  signal_snapshot, created_at
```

### Autonomy Levels (per content signal)

| Level | Behavior | How it's earned |
|---|---|---|
| **Manual** | Always surface for decision | Default for everything |
| **Suggest** | System recommends, user confirms | ~5+ consistent decisions on similar items |
| **Auto with report** | Acts autonomously, reports in digest | ~15+ consistent decisions, >90% agreement |
| **Silent auto** | Acts, only mentions exceptions | ~30+ decisions, >95% agreement |

Progression is per signal type (content type, source, theme) — not global. The system might be autonomous on meme detection after 10 items but still asking about AI framework comparisons after 30.

**Any user override immediately drops that signal back to Manual.** Trust is rebuilt from scratch.

**Feedback also refines the workflow manifest.** If the user consistently goes deep on unlisted topics, the system suggests adding them. If listed interests consistently get archived, it suggests removing them.

### Cold Start

When the system has insufficient feedback, it **waits for user input** before acting autonomously. The digest presents items for decision. No autonomous actions until confidence is earned. This prevents the system from making bad decisions early that erode trust.

## Deep Research: Multi-Agent Architecture

When "Go Deep" is triggered (by user tap or auto-signal), the system spawns parallel subagents. **Which agents run depends on the item** — not all are needed every time.

### Available Research Threads

```
Deep Research Orchestrator
  |-- Usage Agent (GLM + web search + web reader)
  |   "How do you use this? Examples, CLI, configuration"
  |
  |-- Community Agent (GLM + web search + agent-browser)
  |   "What are people saying? GitHub issues, Reddit, HN, Twitter"
  |
  |-- Integration Agent (GLM + filesystem access)
  |   "Read active codebases + workflow manifest,
  |    how would this fit in? What would change?"
  |
  |-- Knowledge Agent (GLM + NotePlan access)
      "Search existing research notes, find related topics,
       prepare [[wikilinks]] and theme connections"
```

The orchestrator examines the item and decides which threads to run:
- Brand new tool with no community? Skip Community Agent.
- Pure news/information? Skip Integration Agent.
- Not related to any existing research? Knowledge Agent still runs but focuses on where to file it.

Additional research threads can be added over time as patterns emerge.

### Deep Research Output

1. **NotePlan research note** — Structured markdown with `[[wikilinks]]`, tagged, filed in `70 - Research/queued`. Full findings, examples, diagrams.
2. **Telegram brief** — Concise summary (max ~500 words) with mermaid diagram if the topic involves architecture or workflows. Not overwhelming.
3. **Action buttons:** `[Action Now]` `[Remind Me]` `[Watch]` `[Archive]`

### Post-Research User Actions

| Action | What happens |
|---|---|
| **Action Now** | Creates tasks in NotePlan calendar note, starts implementation workflow |
| **Remind Me** | Snooze with timer — resurfaces after the specified period |
| **Watch** | Item/theme enters monitoring state — heartbeat periodically checks for updates, resurfaces when something material changes |
| **Archive** | Full note in NotePlan with links, no further notifications |

## Thematic Clustering

The system auto-detects themes by comparing items against each other and existing research notes. Users never manually manage themes.

### How Themes Work

- Items are automatically grouped by content similarity and workflow manifest mapping
- When a cluster reaches 3+ items, it becomes a named theme
- Themes have a status: `active` (accumulating items), `watching` (monitoring for updates), `archived`
- Periodic theme reports are generated (weekly/bi-weekly, auto-adjusted based on activity level)

### Theme Reports

```
Bi-weekly Report: Agent Orchestration Frameworks

3 new items tracked since Mar 10
- CrewAI v0.5 — added structured tool delegation
- LangGraph — new checkpoint/resume for long-running agents
- AutoGen 0.4 — dropped Azure dependency, now framework-agnostic

Trend: All three converging on similar patterns — tool-use
delegation with state persistence. PsiBot subagent architecture
already does this natively via Claude Agent SDK.

[Full Report] [Archive Theme] [Keep Watching]
```

### Trend Detection

- New theme emerges from accumulated saves -> alert in digest
- Archived item becomes relevant because a new cluster formed around its topic -> resurface
- Watched theme gains sudden activity -> escalate in digest

## Information Layering (Anti-Overload)

Research is compressed into progressively shorter forms. Users interact at the shallowest sufficient layer.

| Layer | Length | When you see it |
|---|---|---|
| **Full research note** | 1-2 pages | Only if you explicitly open it in NotePlan |
| **Telegram brief** | 3-5 sentences + diagram | When deep research completes |
| **Digest line item** | 1 sentence | In the heartbeat digest |
| **Theme summary** | 1 paragraph per theme | Weekly/bi-weekly report |
| **Executive brief** | 5-10 bullets covering everything | Morning brief |

The morning brief is the **top of the pyramid** — "here are the 3 things that matter today across all your research, themes, and pending actions." Everything else exists in the knowledge base for drill-down.

## Data Model Changes

### Modified: `pending_items`

New columns:
- `quick_scan_summary TEXT` — result of the quick scan
- `theme_id INTEGER` — FK to themes table
- `relevance_window TEXT` — optional date after which this item loses urgency
- `watch_status TEXT` — null / 'watching' / 'expired'
- `auto_decision TEXT` — what the system decided autonomously (audit trail)
- `signal_score REAL` — contextual intelligence score that triggered auto-decisions

### New: `themes`

```sql
CREATE TABLE IF NOT EXISTS themes (
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### New: `theme_items`

```sql
CREATE TABLE IF NOT EXISTS theme_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES pending_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(theme_id, item_id)
);
```

### New: `feedback_log`

```sql
CREATE TABLE IF NOT EXISTS feedback_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER REFERENCES pending_items(id),
  theme_id INTEGER REFERENCES themes(id),
  content_type TEXT,
  source TEXT,
  system_recommendation TEXT,
  user_action TEXT NOT NULL,
  signal_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### New: `autonomy_rules`

```sql
CREATE TABLE IF NOT EXISTS autonomy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type TEXT NOT NULL,
  signal_value TEXT NOT NULL,
  learned_action TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  decision_count INTEGER NOT NULL DEFAULT 0,
  level TEXT NOT NULL DEFAULT 'manual'
    CHECK(level IN ('manual', 'suggest', 'auto_report', 'silent')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(signal_type, signal_value)
);
```

## Alignment with March 23 Session Changes

A parallel session (documented in `docs/2026-03-23-session-changes.md`) made several changes that align with or inform this design:

| Change | Alignment |
|---|---|
| YouTube -> pending_items pipeline | New capture source; incorporated into this design |
| Budget enforcement disabled | Matches our "GLM for everything, don't worry about cost" decision |
| Rich content extraction (Reddit JSON API, HTML stripping) | Already implements Tier 0+; triage now sees actual content |
| No NotePlan notes at triage time | Matches our design — notes only from research pipeline |
| NaN priority fix | Bug fix; no design impact |
| Subreddit in profile field | Useful metadata for theme clustering |
| 128 pending + 228 old-quality triaged items | Backlog to process on first heartbeat run |

The improved triage prompts from that session are a foundation for the value-extraction model described here. The rich content extraction is critical — the old blind triage couldn't extract value because it couldn't see content.

## Migration Path

1. **Phase 1:** Create workflow manifest. Refactor heartbeat into deterministic orchestrator. Move maintenance tasks to separate cron jobs. Update triage prompt to value-extraction model.
2. **Phase 2:** Add quick scan to heartbeat pipeline. Implement digest message with inline keyboards. Add feedback logging. Process the 128+ item backlog.
3. **Phase 3:** Implement deep research multi-agent system. Add theme clustering and auto-detection. Implement contextual intelligence signals.
4. **Phase 4:** Build progressive autonomy engine. Add periodic theme reports. Integrate into morning brief executive summary. Re-evaluate the 228 old-quality triaged items.

## Open Questions

- Exact similarity algorithm for theme clustering (embedding-based vs keyword-based vs LLM-judged)
- How to handle the agent-browser dependency for deep research (requires Edge running with remote debugging)
- Whether watched theme re-checks should be their own cron job or part of the heartbeat tick
- Mermaid diagram generation: inline in the Telegram brief or as an attached image?
- How to handle the 228 items triaged with the old (blind) system — re-triage all, or only re-triage those that were categorized as "reference"?
