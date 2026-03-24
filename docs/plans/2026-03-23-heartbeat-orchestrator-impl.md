# Heartbeat Orchestrator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the PsiBot heartbeat from a single maintenance agent into an autonomous inbox processing orchestrator with value-extraction triage, multi-agent deep research, thematic clustering, and progressive autonomy.

**Architecture:** The heartbeat becomes a deterministic TypeScript pipeline that calls specific functions (triage, research, clustering, surfacing) rather than running a single agent prompt. Agents are tools the pipeline uses, not the orchestrator. Current maintenance tasks move to separate cron jobs.

**Tech Stack:** Bun, SQLite (bun:sqlite), Claude Agent SDK (`query()`), GLM backend (api.z.ai), Grammy (Telegram), NotePlan (markdown files with `[[wikilinks]]`)

**Design doc:** `docs/plans/2026-03-23-heartbeat-orchestrator-design.md`

**Key paths:**
- Project root: (repository root)
- NotePlan notes: `~/Documents/NotePlan-Notes/Notes/`
- PsiBot knowledge: `knowledge/`
- Workflow manifest (canonical): `~/Documents/NotePlan-Notes/Notes/10 - Projects/00-workflow-manifest.md`
- Workflow manifest (symlink): `knowledge/WORKFLOW.md`

---

## Phase 1: Foundation (Tasks 1-8)

Database, types, workflow manifest, heartbeat refactor, value-extraction triage.

---

### Task 1: Database Migrations — New Tables and Columns

**Files:**
- Modify: `src/db/schema.ts` (append new migrations)
- Modify: `src/shared/types.ts` (add new interfaces)

**Step 1: Add new types to `src/shared/types.ts`**

Append after the `Reminder` interface (line ~219):

```typescript
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
```

**Step 2: Update `PendingItem` interface in `src/shared/types.ts`**

Add optional fields to the existing `PendingItem` interface (line ~184):

```typescript
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
  created_at: string;
  // New fields
  quick_scan_summary: string | null;
  theme_id: number | null;
  relevance_window: string | null;
  watch_status: WatchStatus | null;
  auto_decision: string | null;
  signal_score: number | null;
  value_type: ValueType | null;
  extracted_value: string | null;
}
```

**Step 3: Add SQL migrations to `src/db/schema.ts`**

Append to the `MIGRATIONS` array:

```typescript
// --- Heartbeat Orchestrator: Phase 1 ---

// Extended pending_items columns
`ALTER TABLE pending_items ADD COLUMN quick_scan_summary TEXT`,
`ALTER TABLE pending_items ADD COLUMN theme_id INTEGER REFERENCES themes(id)`,
`ALTER TABLE pending_items ADD COLUMN relevance_window TEXT`,
`ALTER TABLE pending_items ADD COLUMN watch_status TEXT CHECK(watch_status IN ('watching', 'expired'))`,
`ALTER TABLE pending_items ADD COLUMN auto_decision TEXT`,
`ALTER TABLE pending_items ADD COLUMN signal_score REAL`,
`ALTER TABLE pending_items ADD COLUMN value_type TEXT CHECK(value_type IN ('technique', 'tool', 'actionable', 'no_value'))`,
`ALTER TABLE pending_items ADD COLUMN extracted_value TEXT`,

// Themes
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,
`CREATE INDEX IF NOT EXISTS idx_themes_status ON themes(status)`,

// Theme-Item junction
`CREATE TABLE IF NOT EXISTS theme_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  theme_id INTEGER NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES pending_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(signal_type, signal_value)
)`,
`CREATE INDEX IF NOT EXISTS idx_autonomy_rules_signal ON autonomy_rules(signal_type, signal_value)`,
```

**Step 4: Run the app to verify migrations apply**

```bash
cd /path/to/telegram-claude-code
bun run tsc --noEmit
```

Expected: No type errors.

**Step 5: Commit**

```bash
git add src/db/schema.ts src/shared/types.ts
git commit -m "feat: add database migrations for heartbeat orchestrator (themes, feedback, autonomy)"
```

---

### Task 2: Query Functions for New Tables

**Files:**
- Modify: `src/db/queries.ts` (add new query functions)

**Step 1: Add theme query functions**

Append to `src/db/queries.ts`:

```typescript
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

  sets.push("updated_at = datetime('now')");
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
```

**Step 2: Add feedback and autonomy query functions**

```typescript
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
       updated_at = datetime('now')`
  ).run(
    params.signal_type,
    params.signal_value,
    params.learned_action,
    params.confidence,
    params.decision_count,
    params.level
  );
}
```

**Step 3: Add missing imports at top of `src/db/queries.ts`**

Update the type imports to include new types:

```typescript
import type {
  // ...existing imports...
  Theme,
  ThemeStatus,
  ThemeItem,
  FeedbackLogEntry,
  AutonomyRule,
  AutonomyLevel,
  ValueType,
  WatchStatus,
} from "../shared/types.ts";
```

**Step 4: Update `updatePendingItem` to accept new fields**

Modify the `updatePendingItem` function's `params` type (line ~879) to include the new columns:

```typescript
export function updatePendingItem(
  id: number,
  params: Partial<Pick<PendingItem,
    "status" | "priority" | "category" | "triage_summary" | "noteplan_path" |
    "title" | "description" | "quick_scan_summary" | "theme_id" |
    "relevance_window" | "watch_status" | "auto_decision" | "signal_score" |
    "value_type" | "extracted_value"
  >>
): void {
```

**Step 5: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 6: Commit**

```bash
git add src/db/queries.ts
git commit -m "feat: add query functions for themes, feedback log, and autonomy rules"
```

---

### Task 3: Workflow Manifest

**Files:**
- Create: `~/Documents/NotePlan-Notes/Notes/10 - Projects/00-workflow-manifest.md`
- Create: `knowledge/WORKFLOW.md` (symlink)

**Step 1: Create the workflow manifest in NotePlan**

Write to `~/Documents/NotePlan-Notes/Notes/10 - Projects/00-workflow-manifest.md`:

```markdown
---
title: Workflow Manifest
created: 2026-03-23
updated: 2026-03-23
tags:
  - psibot
  - workflow
  - manifest
---

# Workflow Manifest

Living document referenced by PsiBot triage, research, and briefing agents.
Updated by the user and by PsiBot when it detects new patterns.

## Active Projects

| Project | Phase | Stack | Key Goals |
|---|---|---|---|
| PsiBot v2 | Phase 2 (heartbeat orchestrator) | Bun, Claude Agent SDK, Grammy, SQLite | Autonomous inbox processing, research, knowledge building |
| ScanAI | Active development | Next.js, Vercel, Convex | Document scanning product |
| Trading Bot | Maintenance + improvement | Python, FastAPI, ML | Market data API, event-driven strategies |
| Cloud Nexus Solutions | Business operations | Various | Client work, marketing automation |

## Current Toolchain

- **IDE/Editor:** Claude Code (primary), Cursor, VS Code
- **AI Models:** Claude Opus/Sonnet (reasoning, code), GLM-5 (triage, web search), Gemini (images, embeddings)
- **Version Control:** Git, GitButler, GitHub
- **Deployment:** Vercel (frontend), Coolify (self-hosted), macOS LaunchAgent (PsiBot daemon)
- **Knowledge Management:** NotePlan (PARA structure), PsiBot memory system
- **Browser Automation:** agent-browser + Edge (port 9222)
- **Communication:** Telegram (PsiBot interface), Gmail (via MCP)
- **Package Management:** Bun (JS/TS), uv (Python)

## Known Gaps & Pain Points

- Inbox items accumulate without being processed or connected
- No automatic trend detection across saved content
- Research notes are isolated — no wikilink graph
- Morning brief doesn't include research findings or theme updates
- No way to "watch" a topic for updates over time
- Manual effort required to evaluate new tools against current stack

## Evaluation Criteria

What makes something "revolutionary" or worth immediate attention:
- Directly replaces or improves a tool in the current toolchain
- Solves a listed gap or pain point
- New capability for Claude Agent SDK, Bun, or Grammy (core stack)
- Security advisory for any dependency in active projects
- Significant cost/performance improvement for current workflows

## Topics Being Evaluated

- Agent orchestration frameworks (comparing against Claude Agent SDK subagents)
- AI image/video generation techniques and prompting patterns
- Browser automation improvements (alternatives to agent-browser)
- Knowledge graph tools and second-brain automation

## Teaching & Personal

- Gnostic studies classes (Wed/Thu evenings)
- Class preparation needs automated research support
- Personal content saves (memes, jokes) should be filtered out of the work pipeline
```

**Step 2: Create symlink in knowledge/**

```bash
cd /path/to/telegram-claude-code
ln -s ~/Documents/NotePlan-Notes/Notes/10\ -\ Projects/00-workflow-manifest.md knowledge/WORKFLOW.md
```

**Step 3: Verify symlink works**

```bash
head -5 knowledge/WORKFLOW.md
```

Expected: First 5 lines of the manifest file.

**Step 4: Commit**

```bash
git add knowledge/WORKFLOW.md
git commit -m "feat: add workflow manifest symlink for triage context"
```

---

### Task 4: Move Heartbeat Maintenance Tasks to Separate Job

**Files:**
- Modify: `knowledge/HEARTBEAT.md` (replace with orchestrator instructions)
- Create: `scripts/seed-maintenance-job.ts` (seed the maintenance cron job)

**Step 1: Create maintenance job seed script**

Write `scripts/seed-maintenance-job.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Seeds the "System Maintenance" cron job that replaces
 * the old heartbeat maintenance tasks.
 */
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { createJob, getAllJobs } from "../src/db/queries.ts";

loadConfig();
initDb();

const existingJobs = getAllJobs();
const alreadyExists = existingJobs.some((j) => j.name === "System Maintenance");

if (alreadyExists) {
  console.log("System Maintenance job already exists, skipping.");
  process.exit(0);
}

const prompt = `You are running a system maintenance routine. Perform these tasks:

## Review Recent Sessions
- Look at the last few chat messages for unresolved questions or action items
- Update USER.md with any new learned preferences

## Memory Maintenance
- Review memory.md for stale or redundant entries
- Distill important patterns into organized sections
- Write a brief daily summary to memory/YYYY-MM-DD.md

## Check Worktrees
- List active worktrees in ~/.psibot/worktrees/
- Report any with uncommitted changes or stale branches
- If the trading-bot-improvements worktree has failing tests, [NOTIFY] David

## Proactive Checks
- If the user mentioned something time-sensitive, check on it
- If there are enabled cron jobs, verify they ran successfully

## Trading Bot Continuous Improvement
Pick ONE of these tasks if time permits (rotate through them):
- Run tests: cd ~/.psibot/worktrees/trading-bot-improvements/backend && uv run pytest tests/ -q
- If tests fail, [NOTIFY] David with details
- Check for TODO/FIXME comments in event strategies code
- Keep knowledge/trading-bot-research.md updated`;

const job = createJob({
  name: "System Maintenance",
  prompt,
  type: "cron",
  schedule: "0 */4 * * *",  // Every 4 hours
  max_budget_usd: 1.0,
  use_browser: false,
  model: null,
  backend: "claude",
});

console.log(`Created job: ${job.name} (id: ${job.id}, schedule: every 4 hours)`);
```

**Step 2: Run the seed script**

```bash
bun run scripts/seed-maintenance-job.ts
```

**Step 3: Replace `knowledge/HEARTBEAT.md` with orchestrator context**

This file is now only loaded by the heartbeat for reference context, not as a task list:

```markdown
# Heartbeat Orchestrator

The heartbeat is an autonomous inbox processing pipeline. It does NOT run as an agent prompt.

## Pipeline
1. Intake: pull pending items, run value-extraction triage (GLM)
2. Research: quick scan investigate items, check contextual signals, auto deep dive on strong signals
3. Knowledge Integration: write NotePlan notes with [[wikilinks]], update theme clusters
4. Surfacing: compose Telegram digest, surface items needing user decisions

## Configuration
- Interval: 30 minutes
- Quiet hours: 23:00 - 08:00
- Maintenance tasks: moved to separate "System Maintenance" cron job

## References
- Workflow manifest: knowledge/WORKFLOW.md
- Interest profile: knowledge/INTERESTS.md
- Design doc: docs/plans/2026-03-23-heartbeat-orchestrator-design.md
```

**Step 4: Commit**

```bash
git add scripts/seed-maintenance-job.ts knowledge/HEARTBEAT.md
git commit -m "feat: move heartbeat maintenance tasks to separate cron job"
```

---

### Task 5: Value-Extraction Triage Prompt

**Files:**
- Modify: `src/triage/index.ts` (update `triageItem` function prompt and response parsing)

**Step 1: Update the `TriageResult` interface** (line ~23)

```typescript
interface TriageResult {
  value_type: "technique" | "tool" | "actionable" | "no_value";
  extracted_value: string;
  priority: number;
  summary: string;
  relevance_signal: string;
  tags: string[];
}
```

**Step 2: Load the workflow manifest alongside interests**

Add a `loadWorkflowManifest` function after `loadInterests` (~line 186):

```typescript
function loadWorkflowManifest(): string {
  const projectRoot = dirname(dirname(dirname(import.meta.path)));
  const manifestPath = join(projectRoot, "knowledge/WORKFLOW.md");
  try {
    return readFileSync(manifestPath, "utf-8");
  } catch {
    log.warn("Could not load WORKFLOW.md", { path: manifestPath });
    return "No workflow manifest available.";
  }
}
```

**Step 3: Replace the triage prompt in `triageItem`** (line ~322)

Replace the entire prompt string with:

```typescript
const prompt = `You are a value-extraction triage agent. Your job is NOT to categorize content — it is to extract the transferable value from this item.

The default assumption is: "there's something useful here, since the user saved it." Only mark as no_value if there is genuinely nothing transferable (pure joke, meme with no technique, spam).

## Item
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Description: ${item.description ?? "none"}
- Platform: ${item.platform ?? "unknown"}
- Source: ${item.source}
${item.profile ? `- Profile/Subreddit: ${item.profile}` : ""}

## Content
${contentText}

## User Workflow Manifest
${workflowManifest}

## User Interest Profile
${interests}

## Instructions

Analyze the ACTUAL CONTENT (not just the title) and extract the transferable value — the technique, method, tool, pattern, or insight that exists regardless of how the content is framed.

Return a JSON object:
- "value_type": one of "technique" (prompting pattern, CLI workflow, config trick, image/video method), "tool" (framework, library, CLI tool, service to evaluate), "actionable" (needs response, time-sensitive, decision needed), "no_value" (genuinely nothing transferable)
- "extracted_value": 1-2 sentences describing the specific transferable nugget. NOT a summary of the content — the actual technique, tool, or actionable item. Example: "JSON prompting technique for structured image generation using nested scene descriptions" NOT "Reddit post about AI image generation"
- "priority": 1-5 based on relevance to active projects and workflow gaps in the manifest (1 = directly addresses a listed gap, 2 = relevant to active project, 3 = matches interests, 4 = tangentially useful, 5 = no value)
- "summary": 2-3 sentence summary with specific details from the content
- "relevance_signal": 1 sentence explaining the connection to the user's workflow, projects, or interests. If no connection, say "No direct connection to current workflow"
- "tags": array of relevant tags (include subreddit if Reddit, platform, topic keywords)

If content could not be extracted or is empty/inaccessible, set value_type to "no_value".

Return ONLY the JSON object.

\`\`\`json
{
  "value_type": "...",
  "extracted_value": "...",
  "priority": ...,
  "summary": "...",
  "relevance_signal": "...",
  "tags": ["..."]
}
\`\`\``;
```

**Step 4: Update response parsing in `triageItem`**

After the GLM call, update the parsing to handle the new response shape:

```typescript
const workflowManifest = loadWorkflowManifest();

// ... GLM call ...

const parsed = extractJson<TriageResult>(response);

if (!parsed) {
  log.error("Failed to parse triage response", {
    itemId: item.id,
    response: response.slice(0, 300),
  });
  return {
    value_type: "tool",
    extracted_value: "Triage parsing failed - needs manual review.",
    priority: 3,
    summary: "Triage parsing failed.",
    relevance_signal: "Unknown",
    tags: [],
  };
}

const validValueTypes = ["technique", "tool", "actionable", "no_value"] as const;
const value_type = validValueTypes.includes(parsed.value_type as typeof validValueTypes[number])
  ? parsed.value_type
  : "tool";

const priority = Number.isFinite(parsed.priority)
  ? Math.max(1, Math.min(5, Math.round(parsed.priority)))
  : 3;

return {
  value_type,
  extracted_value: parsed.extracted_value ?? "No value extracted.",
  priority,
  summary: parsed.summary ?? "No summary available.",
  relevance_signal: parsed.relevance_signal ?? "Unknown",
  tags: Array.isArray(parsed.tags) ? parsed.tags : [],
};
```

**Step 5: Update `triageBatch` to use new fields**

In `triageBatch` (~line 402), update the `updatePendingItem` call:

```typescript
updatePendingItem(item.id, {
  status: result.value_type === "no_value" ? "deleted" : "triaged",
  priority: result.priority,
  category: result.value_type,  // Reuse category column for value_type
  triage_summary: result.summary,
  value_type: result.value_type,
  extracted_value: result.extracted_value,
});
```

**Step 6: Remove the `createNotePlanNote` function and `CATEGORY_FOLDER_MAP`**

These should already be removed per the March 23 session changes. Verify they're gone:

```bash
rg "createNotePlanNote|CATEGORY_FOLDER_MAP" src/triage/index.ts
```

Expected: No matches. If they still exist, remove them.

**Step 7: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 8: Commit**

```bash
git add src/triage/index.ts
git commit -m "feat: replace category-based triage with value-extraction model"
```

---

### Task 6: Refactor HeartbeatRunner into Orchestrator

**Files:**
- Rewrite: `src/heartbeat/index.ts`

**Step 1: Rewrite `src/heartbeat/index.ts`**

Replace the entire file. The new heartbeat is a deterministic pipeline, not an agent prompt runner.

```typescript
import { Cron } from "croner";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";
import { markdownToTelegramV2, splitMessage } from "../telegram/format.ts";
import {
  getPendingItems,
  getPendingItemCount,
  updatePendingItem,
  getDueReminders,
  updateReminder,
  dismissReminder,
} from "../db/queries.ts";
import { extractMetadata, triageAllPending } from "../triage/index.ts";
import { briefingActionKeyboard, approvalKeyboard, digestKeyboard } from "../telegram/keyboards.ts";
import type { Bot } from "grammy";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("heartbeat");
const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

interface OrchestratorState {
  lastRunAt: string | null;
  runCount: number;
  totalItemsProcessed: number;
}

interface OrchestratorConfig {
  intervalMinutes: number;
  quietStart: number;
  quietEnd: number;
}

interface OrchestratorDeps {
  getBot: () => Bot | null;
  defaultChatIds: number[];
  config: OrchestratorConfig;
}

interface TickResult {
  pendingProcessed: number;
  triagedCount: number;
  droppedCount: number;
  topItems: PendingItem[];
}

export class HeartbeatRunner {
  private cron: Cron | null = null;
  private getBot: () => Bot | null;
  private defaultChatIds: number[];
  private config: OrchestratorConfig;
  private running = false;
  private statePath: string;

  constructor(deps: OrchestratorDeps) {
    this.getBot = deps.getBot;
    this.defaultChatIds = deps.defaultChatIds;
    this.config = deps.config;
    this.statePath = join(KNOWLEDGE_DIR, "orchestrator-state.json");
  }

  start(): void {
    const pattern = `*/${this.config.intervalMinutes} * * * *`;
    log.info("Starting heartbeat orchestrator", { pattern, config: this.config });

    this.cron = new Cron(pattern, () => {
      this.tick().catch((err) => {
        log.error("Heartbeat tick failed", { error: String(err) });
      });
    });
  }

  stop(): void {
    if (this.cron) {
      this.cron.stop();
      this.cron = null;
      log.info("Heartbeat orchestrator stopped");
    }
  }

  private isQuietHours(): boolean {
    const hour = new Date().getHours();
    const { quietStart, quietEnd } = this.config;
    if (quietStart > quietEnd) {
      return hour >= quietStart || hour < quietEnd;
    }
    return hour >= quietStart && hour < quietEnd;
  }

  private readState(): OrchestratorState {
    try {
      if (existsSync(this.statePath)) {
        return JSON.parse(readFileSync(this.statePath, "utf-8")) as OrchestratorState;
      }
    } catch {
      // Fall through to default
    }
    return { lastRunAt: null, runCount: 0, totalItemsProcessed: 0 };
  }

  private writeState(state: OrchestratorState): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  private async tick(): Promise<void> {
    if (this.running) {
      log.info("Heartbeat skipped (already running)");
      return;
    }

    if (this.isQuietHours()) {
      log.info("Heartbeat skipped (quiet hours)");
      return;
    }

    this.running = true;
    const state = this.readState();

    try {
      // --- Phase 1: Intake ---
      const result = await this.phaseIntake();

      // --- Phase 4: Surfacing (Phases 2-3 added in later tasks) ---
      if (result.triagedCount > 0 || result.topItems.length > 0) {
        await this.phaseSurfacing(result);
      }

      // Update state
      const newState: OrchestratorState = {
        lastRunAt: new Date().toISOString(),
        runCount: state.runCount + 1,
        totalItemsProcessed: state.totalItemsProcessed + result.pendingProcessed,
      };
      this.writeState(newState);

      log.info("Heartbeat tick completed", {
        processed: result.pendingProcessed,
        triaged: result.triagedCount,
        dropped: result.droppedCount,
        runCount: newState.runCount,
      });
    } catch (err) {
      log.error("Heartbeat orchestrator error", { error: String(err) });
    }

    // Check due reminders (runs even if pipeline fails)
    try {
      await this.checkDueReminders();
    } catch (err) {
      log.error("Due reminders check failed", { error: String(err) });
    }

    this.running = false;
  }

  // --- Phase 1: Intake ---
  private async phaseIntake(): Promise<TickResult> {
    const pendingCount = getPendingItemCount("pending");
    if (pendingCount === 0) {
      log.info("No pending items to process");
      return { pendingProcessed: 0, triagedCount: 0, droppedCount: 0, topItems: [] };
    }

    log.info("Phase 1: Intake", { pendingCount });

    // Run triage (already handles metadata extraction + GLM categorization)
    const processed = await triageAllPending(50);

    // Count results
    const triaged = getPendingItems("triaged", 50);
    const topItems = triaged
      .filter((item) => item.priority !== null && item.priority <= 2)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 5);

    const droppedCount = processed - triaged.length;

    return {
      pendingProcessed: processed,
      triagedCount: triaged.length,
      droppedCount: Math.max(0, droppedCount),
      topItems,
    };
  }

  // --- Phase 4: Surfacing ---
  private async phaseSurfacing(result: TickResult): Promise<void> {
    const bot = this.getBot();
    if (!bot || this.defaultChatIds.length === 0) return;

    // Build digest message
    const lines: string[] = [];
    lines.push(`Inbox processed: ${result.pendingProcessed} items`);
    lines.push(`${result.triagedCount} triaged, ${result.droppedCount} dropped`);

    if (result.topItems.length > 0) {
      lines.push("");
      lines.push("Top items:");
      for (const item of result.topItems) {
        const valueType = item.value_type ?? item.category ?? "unknown";
        const summary = item.extracted_value ?? item.triage_summary ?? item.title ?? "No summary";
        lines.push(`P${item.priority} [${valueType}] ${summary}`);
      }
    }

    const message = lines.join("\n");

    for (const chatId of this.defaultChatIds) {
      try {
        await bot.api.sendMessage(chatId, message);
      } catch (err) {
        log.error("Failed to send digest", { chatId, error: String(err) });
      }
    }
  }

  // --- Reminders (preserved from original) ---
  private async checkDueReminders(): Promise<void> {
    const bot = this.getBot();
    if (!bot || this.defaultChatIds.length === 0) return;

    const dueReminders = getDueReminders();
    if (dueReminders.length === 0) return;

    log.info("Processing due reminders", { count: dueReminders.length });

    for (const reminder of dueReminders) {
      if (reminder.remind_count >= reminder.max_reminds) {
        dismissReminder(reminder.id);
        log.info("Auto-dismissed reminder (max reminds reached)", { id: reminder.id, title: reminder.title });
        continue;
      }

      const keyboard = reminder.type === "research"
        ? approvalKeyboard(reminder.id)
        : briefingActionKeyboard(reminder.id);

      const messageText = `${reminder.type.toUpperCase()}: ${reminder.title}${reminder.description ? "\n" + reminder.description : ""}`;

      for (const chatId of this.defaultChatIds) {
        try {
          await bot.api.sendMessage(chatId, messageText, {
            reply_markup: keyboard,
          });
        } catch (err) {
          log.error("Failed to send reminder", {
            chatId,
            reminderId: reminder.id,
            error: String(err),
          });
        }
      }

      updateReminder(reminder.id, {
        remind_count: reminder.remind_count + 1,
        status: "active",
      });
    }
  }
}
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/heartbeat/index.ts
git commit -m "feat: refactor heartbeat into deterministic orchestrator pipeline"
```

---

### Task 7: Update HeartbeatRunner Wiring in index.ts

**Files:**
- Modify: `src/index.ts` (update HeartbeatRunner constructor call)

**Step 1: Update the heartbeat construction** (line ~91)

The new HeartbeatRunner no longer needs `agent` or `memory` deps. Update:

```typescript
  // Start heartbeat system
  let heartbeat: HeartbeatRunner | null = null;
  if (config.HEARTBEAT_ENABLED) {
    heartbeat = new HeartbeatRunner({
      getBot: () => bot ?? null,
      defaultChatIds: config.ALLOWED_TELEGRAM_USER_IDS,
      config: {
        intervalMinutes: config.HEARTBEAT_INTERVAL_MINUTES,
        quietStart: config.HEARTBEAT_QUIET_START,
        quietEnd: config.HEARTBEAT_QUIET_END,
      },
    });
    heartbeat.start();
    log.info("Heartbeat orchestrator started", {
      intervalMinutes: config.HEARTBEAT_INTERVAL_MINUTES,
      quietHours: `${config.HEARTBEAT_QUIET_START}:00-${config.HEARTBEAT_QUIET_END}:00`,
    });
  }
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire up new heartbeat orchestrator in main index"
```

---

### Task 8: Phase 1 Integration Test

**Files:**
- Manual testing via Telegram and logs

**Step 1: Restart the daemon**

```bash
psibot restart
```

**Step 2: Check logs for heartbeat startup**

```bash
psibot logs | head -30
```

Expected: "Heartbeat orchestrator started" in logs.

**Step 3: Seed a test pending item**

```bash
cd /path/to/telegram-claude-code
bun -e "
import { loadConfig } from './src/config.ts';
import { initDb } from './src/db/index.ts';
import { insertPendingItem } from './src/db/queries.ts';
loadConfig();
initDb();
const item = insertPendingItem({
  url: 'https://github.com/anthropics/claude-agent-sdk',
  title: 'Claude Agent SDK',
  source: 'manual',
  platform: 'github',
});
console.log('Inserted test item:', item?.id);
"
```

**Step 4: Wait for next heartbeat tick or check logs**

```bash
tail -f ~/.psibot/logs/psibot.out.log | grep -i heartbeat
```

Expected: "Phase 1: Intake" log entry, triage processing, digest message sent to Telegram.

**Step 5: Verify digest received in Telegram**

Check Telegram for a message showing processed items.

**Step 6: Commit any fixes needed**

If fixes are required during testing, commit them with descriptive messages.

---

## Phase 2: Research & Surfacing (Tasks 9-13)

Quick scan, contextual signals, digest keyboards, digest callbacks.

*Note: Phase 2 tasks are outlined here. Implementation details will be refined after Phase 1 is validated.*

---

### Task 9: Quick Scan Function

**Files:**
- Create: `src/research/quick-scan.ts`

Quick scan uses GLM + web search to produce a 2-sentence summary of what the item is and whether it's worth going deeper. Simpler and cheaper than the existing `preliminaryResearch` — no structured JSON output needed, just a brief.

---

### Task 10: Contextual Intelligence Signal Scoring

**Files:**
- Create: `src/heartbeat/signals.ts`

Score each triaged item against:
- Direct relevance: check if item mentions packages from `package.json` / `bun.lock`
- Previously researched: check if item URL or topic matches existing NotePlan research notes
- Momentum: check if multiple items are clustering around the same topic in a short window
- Workflow manifest gaps: check if item addresses a listed gap

Returns a `signal_score` and whether auto-deep-dive is warranted.

---

### Task 11: Digest Message Builder with Keyboards

**Files:**
- Modify: `src/telegram/keyboards.ts` (add `digestKeyboard` and `digestItemKeyboard`)
- Create: `src/heartbeat/digest.ts`

Build the digest message with:
- Items processed count
- Top 3-5 items with extracted value summaries
- Trend alerts if themes detected
- Per-item keyboards: `[Go Deep]` `[Archive]` `[Drop]`

---

### Task 12: Digest Callback Handlers

**Files:**
- Modify: `src/telegram/keyboards.ts` (add callback handlers for digest actions)

New callback prefixes:
- `dd:itemId` — Go Deep (queue deep research)
- `da:itemId` — Archive
- `dx:itemId` — Drop
- `dw:itemId` — Watch

Each handler logs to `feedback_log` for progressive autonomy learning.

---

### Task 13: Wire Research & Surfacing into Heartbeat

**Files:**
- Modify: `src/heartbeat/index.ts` (add Phase 2 and Phase 3 calls)

Add quick scan, signal scoring, and enhanced digest to the heartbeat tick.

---

## Phase 3: Deep Research & Themes (Tasks 14-18)

*Outlined — implement after Phase 2 is validated.*

---

### Task 14: Deep Research Orchestrator

**Files:**
- Create: `src/research/deep-research.ts`

Orchestrator that examines the item and decides which subagents to spawn. Runs them in parallel via `Promise.all()`. Synthesizes results into a NotePlan note and Telegram brief with mermaid diagrams.

---

### Task 15: Theme Clustering Detection

**Files:**
- Create: `src/heartbeat/themes.ts`

After triage, compare new items against existing items and themes. Use GLM to judge similarity and propose groupings. Create theme records, assign items.

---

### Task 16: Knowledge Agent — NotePlan Wikilink Builder

**Files:**
- Create: `src/research/knowledge-linker.ts`

Searches existing NotePlan research notes, adds bidirectional `[[wikilinks]]`, updates related notes with links back to new research.

---

### Task 17: Theme Report Generator

**Files:**
- Create: `src/heartbeat/theme-reports.ts`

Generates periodic theme summaries. Checks `next_report_at` for each active theme. Sends to Telegram with `[Full Report]` `[Archive Theme]` `[Keep Watching]` keyboards.

---

### Task 18: Deep Research Completion Callbacks

**Files:**
- Modify: `src/telegram/keyboards.ts`

New callbacks for post-deep-research actions:
- `ra:itemId` — Action Now (create NotePlan tasks)
- `rr:itemId` — Remind Me (snooze with timer picker)
- `rw:itemId` — Watch (add to theme monitoring)
- `rx:itemId` — Archive

---

## Phase 4: Progressive Autonomy (Tasks 19-22)

*Outlined — implement after Phase 3 is validated.*

---

### Task 19: Feedback Logging on Every User Action

Wire all callback handlers (digest, deep research, theme reports) to write to `feedback_log` with the system's recommendation and user's actual action.

---

### Task 20: Autonomy Rule Learning Engine

**Files:**
- Create: `src/heartbeat/autonomy.ts`

After each feedback entry, recalculate confidence for the relevant signal. Update `autonomy_rules` table. Progress level when thresholds met.

---

### Task 21: Auto-Decision in Heartbeat

Modify the heartbeat pipeline to check `autonomy_rules` before surfacing items. High-confidence rules execute automatically. Report autonomous actions in the digest.

---

### Task 22: Morning Brief Integration

Modify the morning brief job prompt to include:
- Executive summary of active themes
- Research completed since last brief
- Items requiring attention
- Watched themes with updates
