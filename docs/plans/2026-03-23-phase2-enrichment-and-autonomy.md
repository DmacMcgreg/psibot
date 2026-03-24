# Phase 2: Enrichment, Inbox Watcher, Themes & Autonomy

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enrich the heartbeat digest with quick-scan web research, add a NotePlan inbox watcher for tag-based actions, implement automatic theme clustering, enhance deep research with knowledge linking, and build the dual-path progressive autonomy system.

**Architecture:** The heartbeat pipeline gains two new phases between Intake and Surfacing: Quick Scan (GLM + web/zread MCP enrichment) and Knowledge Integration (inbox watcher + theme clustering). Contextual intelligence signals run during quick scan to auto-trigger deep research without waiting for feedback. The feedback learning loop runs after each user action to build per-signal autonomy rules over time.

**Tech Stack:** Bun, SQLite (bun:sqlite), Claude Agent SDK (`query()`), GLM backend (api.z.ai), Z.AI MCP (webSearchPrime, webReader, zread), Grammy (Telegram), NotePlan (markdown + YAML frontmatter)

**Design doc:** `docs/plans/2026-03-23-heartbeat-orchestrator-design.md`

**Key paths:**
- Project root: (repository root)
- NotePlan inbox: `~/Documents/NotePlan-Notes/Notes/00 - Inbox/`
- NotePlan research: `~/Documents/NotePlan-Notes/Notes/70 - Research/`
- GLM MCP config: `src/agent/glm-mcp.ts`
- Heartbeat: `src/heartbeat/index.ts`
- Research: `src/research/index.ts`
- Triage: `src/triage/index.ts`
- Queries: `src/db/queries.ts`
- Types: `src/shared/types.ts`
- Keyboards: `src/telegram/keyboards.ts`

**Depends on:** Phase 1 (complete) — DB migrations, types, queries, value-extraction triage, orchestrator heartbeat, workflow manifest, inbox notes, digest with action buttons.

---

## Task 1: Add zread MCP to GLM servers

**Files:**
- Modify: `src/agent/glm-mcp.ts:24-54`

**Step 1: Add zread to getGlmMcpServers()**

After the `"zai-vision"` entry (line ~45), add:

```typescript
    zread: {
      type: "http",
      url: "https://api.z.ai/api/mcp/zread/mcp",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    },
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/agent/glm-mcp.ts
git commit -m "feat: add zread MCP server for GitHub repo analysis"
```

---

## Task 2: Quick Scan Function

**Files:**
- Create: `src/research/quick-scan.ts`

**Step 1: Create the quick scan module**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { getGlmMcpServers } from "../agent/glm-mcp.ts";
import { createLogger } from "../shared/logger.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("research:quick-scan");

export interface QuickScanResult {
  summary: string;
  notable: boolean;
  signals: string[];
}

/**
 * Quick scan: GLM + web search/zread to enrich a triaged item
 * with 3-5 sentences of external context. Fast (~5-10s per item).
 */
export async function quickScan(item: PendingItem): Promise<QuickScanResult> {
  const config = getConfig();

  if (!config.GLM_AUTH_TOKEN) {
    return { summary: "", notable: false, signals: [] };
  }

  const isGitHub = item.url.includes("github.com");
  const repoMatch = isGitHub ? item.url.match(/github\.com\/([^/]+\/[^/]+)/) : null;
  const repoSlug = repoMatch ? repoMatch[1] : null;

  const toolInstructions = repoSlug
    ? `Use the zread search_doc tool to look up "${repoSlug}" — get stars, recent issues, documentation summary, and project activity. Also use get_repo_structure to understand the project layout.`
    : `Use webSearchPrime to search for "${item.title ?? item.url}" and get recent context: what it is, how popular/notable, any red flags or standout features.`;

  const prompt = `You are a quick research scanner. Produce a concise enrichment of this item.

## Item
- URL: ${item.url}
- Title: ${item.title ?? "unknown"}
- Platform: ${item.platform ?? "unknown"}
- Triage Value: ${item.extracted_value ?? item.triage_summary ?? "none"}

## Instructions
${toolInstructions}

Then return a JSON object:
- "summary": 3-5 sentences of external context. Include specific numbers (stars, downloads, release date). Mention competitors or alternatives if relevant. Be factual, not promotional.
- "notable": true if this stands out (>1k stars, rapid growth, security advisory, addresses a known gap), false otherwise
- "signals": array of signal strings detected, e.g. ["matches-dependency:grammy", "rapid-growth", "security-advisory", "addresses-workflow-gap:browser-automation"]

Return ONLY the JSON object.`;

  const envOverride: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.GLM_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.GLM_OPUS_MODEL,
  };

  const glmServers = getGlmMcpServers();

  let response = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 8,
        permissionMode: "bypassPermissions",
        env: envOverride,
        mcpServers: glmServers as Record<string, ReturnType<typeof getGlmMcpServers>[string]>,
      },
    })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? (block.text ?? "") : ""
          )
          .join("");
      }
    }
  } catch (err) {
    log.error("Quick scan query failed", { itemId: item.id, error: String(err) });
    return { summary: "", notable: false, signals: [] };
  }

  // Parse JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn("Quick scan returned no JSON", { itemId: item.id });
    return { summary: response.slice(0, 500), notable: false, signals: [] };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as QuickScanResult;
    return {
      summary: parsed.summary ?? "",
      notable: parsed.notable ?? false,
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    };
  } catch {
    log.warn("Quick scan JSON parse failed", { itemId: item.id });
    return { summary: response.slice(0, 500), notable: false, signals: [] };
  }
}

/**
 * Run quick scans in parallel on a batch of items.
 * Returns items with their scan results.
 */
export async function quickScanBatch(
  items: PendingItem[],
  concurrency: number = 3
): Promise<Map<number, QuickScanResult>> {
  const results = new Map<number, QuickScanResult>();

  // Process in chunks to limit concurrency
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        const result = await quickScan(item);
        return { id: item.id, result };
      })
    );
    for (const { id, result } of chunkResults) {
      results.set(id, result);
    }
  }

  return results;
}
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/research/quick-scan.ts
git commit -m "feat: add quick scan module with platform-aware enrichment (zread for GitHub)"
```

---

## Task 3: Contextual Intelligence Signal Scorer

**Files:**
- Create: `src/heartbeat/signals.ts`

**Step 1: Create the signal scoring module**

```typescript
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";
import { getThemes, getThemeItems } from "../db/queries.ts";
import type { PendingItem } from "../shared/types.ts";
import type { QuickScanResult } from "../research/quick-scan.ts";

const log = createLogger("heartbeat:signals");
const PROJECT_ROOT = resolve(process.cwd());

interface SignalResult {
  score: number;
  signals: string[];
  autoAction: "deep_research" | "watch" | "archive" | null;
}

/**
 * Score an item using contextual intelligence signals.
 * These are deterministic checks that don't need accumulated feedback.
 */
export function scoreSignals(
  item: PendingItem,
  quickScan: QuickScanResult | null
): SignalResult {
  const signals: string[] = [];
  let score = 0;

  // --- Direct Relevance Signals ---

  // Check if item mentions a dependency from package.json
  const deps = loadDependencies();
  const textToSearch = [
    item.title,
    item.description,
    item.extracted_value,
    item.triage_summary,
    quickScan?.summary,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const dep of deps) {
    if (textToSearch.includes(dep.toLowerCase())) {
      signals.push(`matches-dependency:${dep}`);
      score += 30;
    }
  }

  // Check if item addresses a workflow manifest gap
  const gaps = loadWorkflowGaps();
  for (const gap of gaps) {
    if (textToSearch.includes(gap.toLowerCase())) {
      signals.push(`addresses-workflow-gap:${gap}`);
      score += 25;
    }
  }

  // Include quick scan signals
  if (quickScan?.signals) {
    for (const sig of quickScan.signals) {
      if (!signals.includes(sig)) {
        signals.push(sig);
        if (sig.startsWith("matches-dependency")) score += 30;
        else if (sig === "security-advisory") score += 50;
        else if (sig === "rapid-growth") score += 15;
        else if (sig.startsWith("addresses-workflow-gap")) score += 25;
        else score += 10;
      }
    }
  }

  // --- Momentum Signals ---

  // Check if similar items are clustering (same platform+profile within recent triaged)
  if (quickScan?.notable) {
    signals.push("quick-scan-notable");
    score += 15;
  }

  // --- Decay Signals ---

  if (item.relevance_window) {
    const deadline = new Date(item.relevance_window);
    const now = new Date();
    const daysLeft = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 3 && daysLeft > 0) {
      signals.push("approaching-deadline");
      score += 20;
    } else if (daysLeft <= 0) {
      signals.push("past-deadline");
      score -= 10;
    }
  }

  // --- Determine auto-action ---
  let autoAction: SignalResult["autoAction"] = null;

  if (score >= 40) {
    autoAction = "deep_research";
  } else if (signals.includes("past-deadline")) {
    autoAction = "archive";
  }

  log.info("Signal scoring complete", {
    itemId: item.id,
    score,
    signalCount: signals.length,
    autoAction,
    signals: signals.join(", "),
  });

  return { score, signals, autoAction };
}

// --- Helpers ---

let _depsCache: string[] | null = null;

function loadDependencies(): string[] {
  if (_depsCache) return _depsCache;
  try {
    const pkgPath = join(PROJECT_ROOT, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    _depsCache = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    return _depsCache;
  } catch {
    return [];
  }
}

let _gapsCache: string[] | null = null;

function loadWorkflowGaps(): string[] {
  if (_gapsCache) return _gapsCache;
  try {
    const manifestPath = join(PROJECT_ROOT, "knowledge/WORKFLOW.md");
    const content = readFileSync(manifestPath, "utf-8");
    // Extract bullet points from "Known Gaps & Pain Points" section
    const gapsMatch = content.match(
      /## Known Gaps & Pain Points\n([\s\S]*?)(?=\n##|\n$)/
    );
    if (!gapsMatch) return [];
    _gapsCache = gapsMatch[1]
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^- /, "").trim().toLowerCase())
      .flatMap((gap) => {
        // Extract key phrases from each gap
        const words = gap.split(/\s+/).filter((w) => w.length > 4);
        return words.slice(0, 3);
      });
    return _gapsCache;
  } catch {
    return [];
  }
}
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/heartbeat/signals.ts
git commit -m "feat: add contextual intelligence signal scorer (dependency, workflow gaps, momentum, decay)"
```

---

## Task 4: Wire Quick Scan + Signals into Heartbeat Pipeline

**Files:**
- Modify: `src/heartbeat/index.ts:104-182` (tick and phaseIntake methods)

**Step 1: Add imports at top of heartbeat/index.ts**

After the existing imports (line ~15), add:

```typescript
import { quickScanBatch } from "../research/quick-scan.ts";
import { scoreSignals } from "./signals.ts";
import type { QuickScanResult } from "../research/quick-scan.ts";
```

**Step 2: Update TickResult interface** (line ~39)

Add fields for enriched data:

```typescript
interface TickResult {
  pendingProcessed: number;
  triagedCount: number;
  droppedCount: number;
  topItems: PendingItem[];
  autoResearchItems: PendingItem[];
}
```

**Step 3: Add Phase 2 (Quick Scan + Signals) to phaseIntake**

Replace the `phaseIntake` method (lines 156-182) with:

```typescript
  private async phaseIntake(): Promise<TickResult> {
    const pendingCount = getPendingItemCount("pending");
    if (pendingCount === 0) {
      log.info("No pending items to process");
      return { pendingProcessed: 0, triagedCount: 0, droppedCount: 0, topItems: [], autoResearchItems: [] };
    }

    log.info("Phase 1: Intake", { pendingCount });

    // Run triage (handles metadata extraction + GLM value-extraction)
    const processed = await triageAllPending(50);

    // Get recently triaged items
    const triaged = getPendingItems("triaged", 50);

    // --- Phase 2: Quick Scan + Signal Scoring ---
    // Only scan items that don't already have a quick_scan_summary
    const needsScan = triaged
      .filter((item) => !item.quick_scan_summary && item.priority !== null && item.priority <= 3)
      .slice(0, 10);

    let scanResults = new Map<number, QuickScanResult>();
    if (needsScan.length > 0) {
      log.info("Phase 2: Quick Scan", { count: needsScan.length });
      scanResults = await quickScanBatch(needsScan, 3);

      // Persist quick scan results and signal scores
      for (const item of needsScan) {
        const scan = scanResults.get(item.id);
        if (!scan) continue;

        const signalResult = scoreSignals(item, scan);

        updatePendingItem(item.id, {
          quick_scan_summary: scan.summary,
          signal_score: signalResult.score,
          auto_decision: signalResult.autoAction,
        });
      }
    }

    // Build top items list (now enriched with quick scan)
    const enrichedTriaged = getPendingItems("triaged", 50);
    const topItems = enrichedTriaged
      .filter((item) => item.priority !== null && item.priority <= 2)
      .sort((a, b) => (b.signal_score ?? 0) - (a.signal_score ?? 0) || (a.priority ?? 5) - (b.priority ?? 5))
      .slice(0, 5);

    // Collect auto-research items (strong contextual signals)
    const autoResearchItems = enrichedTriaged.filter(
      (item) => item.auto_decision === "deep_research"
    );

    const droppedCount = processed - triaged.length;

    return {
      pendingProcessed: processed,
      triagedCount: triaged.length,
      droppedCount: Math.max(0, droppedCount),
      topItems,
      autoResearchItems,
    };
  }
```

**Step 4: Update tick() to handle auto-research items**

In the `tick` method (line ~118), after `phaseIntake()` and before `phaseSurfacing()`, add:

```typescript
      // --- Phase 2b: Auto-research strong signals ---
      if (result.autoResearchItems.length > 0) {
        log.info("Auto-researching strong signal items", {
          count: result.autoResearchItems.length,
        });
        // Queue for deep research (actual research happens asynchronously)
        for (const item of result.autoResearchItems) {
          updatePendingItem(item.id, {
            auto_decision: "deep_research_queued",
          });
        }
      }
```

**Step 5: Update phaseSurfacing to show enriched summaries**

In `phaseSurfacing`, update the item message builder to prefer `quick_scan_summary` over `extracted_value`:

```typescript
          const value = escapeHtml(truncate(
            item.quick_scan_summary ?? item.extracted_value ?? item.triage_summary ?? "", 200
          ));
```

Also add auto-research notification to the header:

```typescript
    // Header message
    const headerLines = [
      `<b>Inbox Digest</b>`,
      `${result.triagedCount} triaged | ${result.droppedCount} dropped`,
    ];

    if (result.autoResearchItems.length > 0) {
      const names = result.autoResearchItems
        .map((i) => i.title ?? "Untitled")
        .slice(0, 3)
        .join(", ");
      headerLines.push(`Auto-researching: ${escapeHtml(names)}`);
    }

    const header = headerLines.join("\n");
```

**Step 6: Fix the return in phaseIntake for the no-items case**

Make sure the early return also includes `autoResearchItems: []`.

**Step 7: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 8: Commit**

```bash
git add src/heartbeat/index.ts
git commit -m "feat: wire quick scan and signal scoring into heartbeat pipeline"
```

---

## Task 5: NotePlan Inbox Watcher

**Files:**
- Create: `src/heartbeat/inbox-watcher.ts`
- Modify: `src/heartbeat/index.ts` (add phase call)

**Step 1: Create the inbox watcher module**

```typescript
import { readdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.ts";
import { getPendingItems, updatePendingItem } from "../db/queries.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("heartbeat:inbox-watcher");
const NOTEPLAN_INBOX = join(homedir(), "Documents/NotePlan-Notes/Notes/00 - Inbox");

interface InboxAction {
  itemId: number;
  action: "research" | "watch" | "archived";
  noteplanPath: string;
}

/**
 * Scan NotePlan inbox for user-tagged notes and dispatch actions.
 * Returns list of actions taken for reporting in the digest.
 */
export function scanInbox(): InboxAction[] {
  if (!existsSync(NOTEPLAN_INBOX)) return [];

  const actions: InboxAction[] = [];

  // Get all triaged items that have noteplan_paths
  const triaged = getPendingItems("triaged", 200);
  const itemsByPath = new Map<string, PendingItem>();
  for (const item of triaged) {
    if (item.noteplan_path) {
      itemsByPath.set(item.noteplan_path, item);
    }
  }

  // Check each note in the inbox
  const files = readdirSync(NOTEPLAN_INBOX).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const filePath = join(NOTEPLAN_INBOX, file);
    const item = itemsByPath.get(filePath);
    if (!item) continue; // Not a psibot-managed note

    const content = readFileSync(filePath, "utf-8");
    const tags = extractFrontmatterTags(content);

    // Only process notes that have tags beyond psibot-triage
    const userTags = tags.filter((t) => t !== "psibot-triage" && t !== "inbox");
    if (userTags.length === 0) continue;

    if (userTags.includes("research")) {
      updatePendingItem(item.id, { auto_decision: "deep_research_queued" });
      actions.push({ itemId: item.id, action: "research", noteplanPath: filePath });
      log.info("Inbox action: research", { itemId: item.id, file });
    } else if (userTags.includes("watch")) {
      updatePendingItem(item.id, { watch_status: "watching" });
      actions.push({ itemId: item.id, action: "watch", noteplanPath: filePath });
      log.info("Inbox action: watch", { itemId: item.id, file });
    }
    // Any other user tag = acknowledged, will be themed by clustering
  }

  // Check for deleted notes (item has noteplan_path but file is gone)
  for (const [path, item] of itemsByPath) {
    if (!existsSync(path)) {
      updatePendingItem(item.id, { status: "archived" });
      actions.push({ itemId: item.id, action: "archived", noteplanPath: path });
      log.info("Inbox action: archived (note deleted)", { itemId: item.id, path });
    }
  }

  return actions;
}

function extractFrontmatterTags(content: string): string[] {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  const fm = fmMatch[1];
  const tagsMatch = fm.match(/tags:\n((?:\s+-\s+.+\n)*)/);
  if (!tagsMatch) return [];

  return tagsMatch[1]
    .split("\n")
    .map((l) => l.replace(/^\s+-\s+/, "").trim())
    .filter(Boolean);
}
```

**Step 2: Wire into heartbeat tick**

In `src/heartbeat/index.ts`, add import:

```typescript
import { scanInbox } from "./inbox-watcher.ts";
```

In the `tick()` method, after `phaseIntake()` and before `phaseSurfacing()`, add:

```typescript
      // --- Phase 3: Inbox Watcher ---
      try {
        const inboxActions = scanInbox();
        if (inboxActions.length > 0) {
          log.info("Inbox watcher processed", { count: inboxActions.length });
        }
      } catch (err) {
        log.error("Inbox watcher failed", { error: String(err) });
      }
```

**Step 3: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/heartbeat/inbox-watcher.ts src/heartbeat/index.ts
git commit -m "feat: add NotePlan inbox watcher for tag-based actions (research, watch, archive)"
```

---

## Task 6: Theme Clustering

**Files:**
- Create: `src/heartbeat/themes.ts`
- Modify: `src/heartbeat/index.ts` (add phase call)

**Step 1: Create the theme clustering module**

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { getGlmMcpServers } from "../agent/glm-mcp.ts";
import { createLogger } from "../shared/logger.ts";
import {
  getPendingItems,
  getThemes,
  getThemeByName,
  createTheme,
  addThemeItem,
  updateTheme,
  updatePendingItem,
} from "../db/queries.ts";
import type { PendingItem, Theme } from "../shared/types.ts";

const log = createLogger("heartbeat:themes");

interface ClusterProposal {
  theme_name: string;
  item_ids: number[];
  description: string;
}

/**
 * Detect thematic clusters among recently triaged items.
 * Compares new items against each other and existing themes.
 * Uses GLM to judge similarity in a single batch call.
 */
export async function detectThemes(): Promise<number> {
  const config = getConfig();
  if (!config.GLM_AUTH_TOKEN) return 0;

  // Get unthemed triaged items
  const triaged = getPendingItems("triaged", 100);
  const unthemed = triaged.filter((item) => !item.theme_id);
  if (unthemed.length < 3) return 0; // Need at least 3 for a cluster

  // Get existing themes
  const existingThemes = getThemes("active");

  // Build the prompt
  const itemSummaries = unthemed.slice(0, 30).map((item) => ({
    id: item.id,
    title: item.title ?? "Untitled",
    value: item.extracted_value ?? item.triage_summary ?? "",
    platform: item.platform ?? "unknown",
    value_type: item.value_type ?? "unknown",
  }));

  const themeSummaries = existingThemes.map((t) => ({
    name: t.name,
    description: t.description,
    item_count: t.item_count,
  }));

  const prompt = `You are a thematic clustering agent. Group related items into themes.

## Existing Themes
${JSON.stringify(themeSummaries, null, 2)}

## Unthemed Items
${JSON.stringify(itemSummaries, null, 2)}

## Instructions
1. For each item, check if it fits an existing theme. If so, assign it.
2. If 3+ items share a topic not covered by existing themes, propose a new theme.
3. Items with no clear cluster should be left unassigned.
4. Theme names should be specific and descriptive (e.g. "Agent Orchestration Frameworks" not "AI").

Return a JSON object:
- "assignments": array of { "item_id": number, "theme_name": string } for items assigned to existing themes
- "new_themes": array of { "theme_name": string, "item_ids": number[], "description": string } for new clusters
- "unassigned": array of item_ids that don't fit any cluster

Return ONLY the JSON object.`;

  const envOverride: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
  };

  let response = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        env: envOverride,
      },
    })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? (block.text ?? "") : ""
          )
          .join("");
      }
    }
  } catch (err) {
    log.error("Theme clustering query failed", { error: String(err) });
    return 0;
  }

  // Parse response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn("Theme clustering returned no JSON");
    return 0;
  }

  try {
    const result = JSON.parse(jsonMatch[0]) as {
      assignments: { item_id: number; theme_name: string }[];
      new_themes: ClusterProposal[];
      unassigned: number[];
    };

    let assignedCount = 0;

    // Process assignments to existing themes
    for (const assignment of result.assignments ?? []) {
      const theme = getThemeByName(assignment.theme_name);
      if (theme) {
        addThemeItem(theme.id, assignment.item_id);
        updatePendingItem(assignment.item_id, { theme_id: theme.id });
        updateTheme(theme.id, {
          item_count: theme.item_count + 1,
          last_activity_at: new Date().toISOString(),
        });
        assignedCount++;
      }
    }

    // Create new themes
    for (const proposal of result.new_themes ?? []) {
      if (proposal.item_ids.length < 3) continue;

      const existing = getThemeByName(proposal.theme_name);
      if (existing) continue; // Don't duplicate

      const theme = createTheme({
        name: proposal.theme_name,
        description: proposal.description,
      });

      for (const itemId of proposal.item_ids) {
        addThemeItem(theme.id, itemId);
        updatePendingItem(itemId, { theme_id: theme.id });
      }

      updateTheme(theme.id, {
        item_count: proposal.item_ids.length,
        last_activity_at: new Date().toISOString(),
      });

      assignedCount += proposal.item_ids.length;
      log.info("New theme created", {
        name: proposal.theme_name,
        itemCount: proposal.item_ids.length,
      });
    }

    log.info("Theme clustering complete", { assigned: assignedCount });
    return assignedCount;
  } catch (err) {
    log.error("Theme clustering parse failed", { error: String(err) });
    return 0;
  }
}
```

**Step 2: Wire into heartbeat**

In `src/heartbeat/index.ts`, add import:

```typescript
import { detectThemes } from "./themes.ts";
```

In `tick()`, after the inbox watcher call, add:

```typescript
      // --- Phase 3b: Theme Clustering ---
      try {
        const themed = await detectThemes();
        if (themed > 0) {
          log.info("Theme clustering assigned items", { count: themed });
        }
      } catch (err) {
        log.error("Theme clustering failed", { error: String(err) });
      }
```

**Step 3: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/heartbeat/themes.ts src/heartbeat/index.ts
git commit -m "feat: add automatic theme clustering via GLM batch analysis"
```

---

## Task 7: Deep Research with Knowledge Linking

**Files:**
- Create: `src/research/knowledge-linker.ts`
- Modify: `src/research/index.ts` (enhance createResearchNote)

**Step 1: Create the knowledge linker module**

```typescript
import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("research:knowledge-linker");
const RESEARCH_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research");

interface LinkResult {
  linkedNotes: string[];
  wikilinks: string[];
}

/**
 * Search existing research notes for related topics and add bidirectional wikilinks.
 */
export function linkToExistingResearch(
  newNoteTitle: string,
  newNotePath: string,
  keywords: string[]
): LinkResult {
  const linkedNotes: string[] = [];
  const wikilinks: string[] = [];

  if (!existsSync(RESEARCH_DIR)) return { linkedNotes, wikilinks };

  // Recursively find all .md files in research directory
  const researchFiles = findMarkdownFiles(RESEARCH_DIR);

  for (const filePath of researchFiles) {
    if (filePath === newNotePath) continue;

    const content = readFileSync(filePath, "utf-8");
    const fileName = filePath.split("/").pop()?.replace(".md", "") ?? "";

    // Check if any keywords appear in the existing note
    const contentLower = content.toLowerCase();
    const matchedKeywords = keywords.filter((kw) =>
      contentLower.includes(kw.toLowerCase())
    );

    if (matchedKeywords.length >= 2) {
      // Add backlink to existing note
      const backlinkSection = `\n\n## Related\n- [[${newNoteTitle}]]`;
      if (!content.includes(`[[${newNoteTitle}]]`)) {
        try {
          appendFileSync(filePath, backlinkSection, "utf-8");
          linkedNotes.push(fileName);
          log.info("Added backlink", { to: fileName, from: newNoteTitle });
        } catch (err) {
          log.warn("Failed to add backlink", { file: filePath, error: String(err) });
        }
      }

      // Collect wikilink for the new note
      wikilinks.push(`[[${fileName}]]`);
    }
  }

  return { linkedNotes, wikilinks };
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMarkdownFiles(fullPath));
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }
  return results;
}
```

**Step 2: Modify createResearchNote in src/research/index.ts**

Find the `createResearchNote` function (line ~422) and add knowledge linking after the note is written. Add import at top:

```typescript
import { linkToExistingResearch } from "./knowledge-linker.ts";
```

After `writeFileSync(filePath, content, "utf-8");` in `createResearchNote`, add:

```typescript
    // Link to existing research notes
    const keywords = research.keyFindings
      .flatMap((f) => f.split(/\s+/).filter((w) => w.length > 5))
      .slice(0, 10);

    const links = linkToExistingResearch(title, filePath, keywords);
    if (links.wikilinks.length > 0) {
      const relatedSection = `\n\n## Related\n${links.wikilinks.map((l) => `- ${l}`).join("\n")}\n`;
      appendFileSync(filePath, relatedSection, "utf-8");
      log.info("Knowledge links added", {
        note: title,
        linkedTo: links.linkedNotes.length,
      });
    }
```

Add `appendFileSync` to the existing `fs` import if not present.

**Step 3: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/research/knowledge-linker.ts src/research/index.ts
git commit -m "feat: add knowledge linker for bidirectional wikilinks between research notes"
```

---

## Task 8: Progressive Autonomy Learning Loop

**Files:**
- Create: `src/heartbeat/autonomy.ts`
- Modify: `src/telegram/keyboards.ts` (enhance feedback logging)

**Step 1: Create the autonomy learning module**

```typescript
import { createLogger } from "../shared/logger.ts";
import {
  getFeedbackForSignal,
  getAutonomyRule,
  upsertAutonomyRule,
} from "../db/queries.ts";
import type { AutonomyLevel } from "../shared/types.ts";

const log = createLogger("heartbeat:autonomy");

const THRESHOLDS: Record<AutonomyLevel, { minDecisions: number; minAgreement: number }> = {
  manual: { minDecisions: 0, minAgreement: 0 },
  suggest: { minDecisions: 5, minAgreement: 0.7 },
  auto_report: { minDecisions: 15, minAgreement: 0.9 },
  silent: { minDecisions: 30, minAgreement: 0.95 },
};

const LEVEL_ORDER: AutonomyLevel[] = ["manual", "suggest", "auto_report", "silent"];

/**
 * After a user action, recalculate confidence for the relevant signal.
 * Updates autonomy_rules table and progresses/regresses level.
 */
export function updateAutonomyFromFeedback(params: {
  signalType: string;
  signalValue: string;
  systemRecommendation: string;
  userAction: string;
}): void {
  const { signalType, signalValue, systemRecommendation, userAction } = params;
  const isAgreement = systemRecommendation === userAction;

  // Get existing rule or create default
  const existing = getAutonomyRule(signalType, signalValue);
  const currentLevel = existing?.level ?? "manual";
  const currentCount = existing?.decision_count ?? 0;
  const newCount = currentCount + 1;

  // If user overrode the system, reset to manual
  if (!isAgreement && currentLevel !== "manual") {
    upsertAutonomyRule({
      signal_type: signalType,
      signal_value: signalValue,
      learned_action: userAction,
      confidence: 0,
      decision_count: 0,
      level: "manual",
    });
    log.info("Autonomy reset to manual (user override)", {
      signalType,
      signalValue,
      was: currentLevel,
    });
    return;
  }

  // Calculate new confidence from recent feedback history
  const recentFeedback = getFeedbackForSignal(signalType, signalValue, 50);
  const agreements = recentFeedback.filter(
    (f) => f.system_recommendation === f.user_action
  ).length;
  const confidence = recentFeedback.length > 0
    ? agreements / recentFeedback.length
    : 0;

  // Determine appropriate level based on thresholds
  let newLevel: AutonomyLevel = "manual";
  for (const level of LEVEL_ORDER) {
    const threshold = THRESHOLDS[level];
    if (newCount >= threshold.minDecisions && confidence >= threshold.minAgreement) {
      newLevel = level;
    }
  }

  upsertAutonomyRule({
    signal_type: signalType,
    signal_value: signalValue,
    learned_action: isAgreement ? systemRecommendation : userAction,
    confidence,
    decision_count: newCount,
    level: newLevel,
  });

  if (newLevel !== currentLevel) {
    log.info("Autonomy level changed", {
      signalType,
      signalValue,
      from: currentLevel,
      to: newLevel,
      confidence: confidence.toFixed(2),
      decisions: newCount,
    });
  }
}

/**
 * Check if the system should auto-act on an item based on learned rules.
 * Returns the action to take, or null if manual decision needed.
 */
export function checkAutonomyRule(
  signalType: string,
  signalValue: string
): { action: string; level: AutonomyLevel } | null {
  const rule = getAutonomyRule(signalType, signalValue);
  if (!rule) return null;

  if (rule.level === "auto_report" || rule.level === "silent") {
    return { action: rule.learned_action, level: rule.level };
  }

  return null;
}
```

**Step 2: Enhance feedback logging in keyboards.ts callback handlers**

In `src/telegram/keyboards.ts`, add import:

```typescript
import { updateAutonomyFromFeedback } from "../heartbeat/autonomy.ts";
```

In each callback handler (`rr`, `rw`, `rx`, `rd`), after the `insertFeedbackLog` call, add an `updateAutonomyFromFeedback` call. For example, in the `rx` (Archive) handler:

```typescript
        case "rx": {
          const id = parseInt(payload, 10);
          updatePendingItem(id, { status: "archived" });
          insertFeedbackLog({
            item_id: id,
            user_action: "archive",
            system_recommendation: "triage",
            content_type: "digest_item",
            source: "telegram",
          });
          updateAutonomyFromFeedback({
            signalType: "digest_item",
            signalValue: "source:telegram",
            systemRecommendation: "triage",
            userAction: "archive",
          });
          await ctx.answerCallbackQuery({ text: "Archived" });
          await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
          break;
        }
```

Apply the same pattern to `rr` (research), `rw` (watch), and `rd` (drop) handlers.

**Step 3: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/heartbeat/autonomy.ts src/telegram/keyboards.ts
git commit -m "feat: add progressive autonomy learning loop with per-signal confidence tracking"
```

---

## Task 9: Wire Autonomy into Heartbeat Auto-Decisions

**Files:**
- Modify: `src/heartbeat/index.ts` (check autonomy rules before surfacing)

**Step 1: Add import**

```typescript
import { checkAutonomyRule } from "./autonomy.ts";
```

**Step 2: Add autonomy check in phaseIntake after signal scoring**

After the signal scoring loop in `phaseIntake`, add a check for learned autonomy rules:

```typescript
      // Check learned autonomy rules for items without strong contextual signals
      for (const item of enrichedTriaged) {
        if (item.auto_decision) continue; // Already has a contextual signal decision

        const sourceSignal = item.source ? `source:${item.source}` : null;
        const platformSignal = item.platform ? `platform:${item.platform}` : null;

        for (const signalValue of [sourceSignal, platformSignal].filter(Boolean)) {
          const rule = checkAutonomyRule("digest_item", signalValue!);
          if (rule) {
            updatePendingItem(item.id, { auto_decision: rule.action });
            log.info("Autonomy auto-decision", {
              itemId: item.id,
              action: rule.action,
              level: rule.level,
              signal: signalValue,
            });
            break;
          }
        }
      }
```

**Step 3: In phaseSurfacing, report autonomous actions**

Add a section after the auto-research notification:

```typescript
    // Report learned autonomy actions
    const autoArchived = result.topItems.filter((i) => i.auto_decision === "archive");
    if (autoArchived.length > 0) {
      headerLines.push(`Auto-archived: ${autoArchived.length} items (learned pattern)`);
    }
```

**Step 4: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/heartbeat/index.ts
git commit -m "feat: wire autonomy rules into heartbeat for learned auto-decisions"
```

---

## Task 10: Integration Test

**Step 1: Restart daemon**

```bash
psibot restart
```

**Step 2: Check logs for new phases**

```bash
psibot logs | grep -E "Phase 2|Quick Scan|Inbox watcher|Theme clustering|Autonomy"
```

**Step 3: Test quick scan enrichment**

Wait for the next heartbeat tick (or seed a test item) and verify:
- Digest items show enriched summaries from quick scan
- GitHub items show zread-sourced data (stars, structure)

**Step 4: Test inbox watcher**

In NotePlan, open an inbox note and add `research` to its tags. Wait for next tick. Verify item gets `auto_decision: deep_research_queued` in DB.

**Step 5: Test theme clustering**

Verify that after enough triaged items accumulate, themes are auto-created in the `themes` table.

```bash
sqlite3 data/app.db "SELECT name, item_count, status FROM themes"
```

**Step 6: Test feedback learning**

Use Telegram digest buttons (Archive, Drop) on several items. Check that `autonomy_rules` table gets populated:

```bash
sqlite3 data/app.db "SELECT signal_type, signal_value, level, confidence, decision_count FROM autonomy_rules"
```

**Step 7: Commit any fixes**
