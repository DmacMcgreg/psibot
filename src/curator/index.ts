/**
 * Autonomous skill curator — periodic consolidation pass over agent-created
 * skills. Mirrors Hermes' `agent/curator.py`.
 *
 * Two phases per run:
 *   A. applyAutomaticTransitions — pure logic, no LLM. State machine over
 *      activity timestamps: active → stale @ 30d → archived @ 90d. Pinned
 *      skills bypass everything.
 *   B. LLM consolidation — forks an AIAgent on Sonnet with the verbatim
 *      Hermes CURATOR_REVIEW_PROMPT. Renders the candidate list, lets the
 *      fork call skill_manage to merge / archive / patch / write_file. Parses
 *      the structured YAML output and writes a per-run report under
 *      data/curator-reports/{ts}/.
 *
 * Trigger: `maybeRunCurator(agent, { idleForSeconds })` is wired into the
 * heartbeat tick. Gates: enabled + not paused + interval elapsed + idle
 * threshold. First-run defers by one full interval.
 *
 * The recovery story: Phase B is best-effort with a forked agent on a
 * separate session. Failure logs but doesn't raise. The archive directory
 * is the rollback path — `delete` action moves to `.archive/`, which is
 * recoverable.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import type { AgentService } from "../agent/index.ts";
import { listSkills } from "../skills/index.ts";
import { agentCreatedReport } from "../skills/usage.ts";
import { withWriteOriginAsync, BACKGROUND_REVIEW } from "../skills/provenance.ts";
import { CURATOR_REVIEW_PROMPT, CURATOR_DRY_RUN_BANNER } from "./prompts.ts";
import { applyAutomaticTransitions, type TransitionCounts } from "./transitions.ts";
import { loadState, saveState, shouldRunNow, isPaused } from "./state.ts";

const log = createLogger("curator");

const CURATOR_REPORTS_DIR = resolve(process.cwd(), "data", "curator-reports");

export interface CuratorRunResult {
  startedAt: string;
  durationMs: number;
  autoTransitions: TransitionCounts;
  llmSummary: string;
  consolidations: ConsolidationEntry[];
  prunings: PruningEntry[];
  reportPath: string | null;
  costUsd: number;
  error: string | null;
}

export interface ConsolidationEntry {
  from: string;
  into: string;
  reason: string;
}

export interface PruningEntry {
  name: string;
  reason: string;
}

/**
 * Guarded entry — call from the heartbeat tick. Honors all gates and
 * NEVER raises. Returns the result if a pass actually ran, else null.
 */
export async function maybeRunCurator(
  agent: AgentService,
  opts: { idleForSeconds?: number; onSummary?: (s: string) => void } = {},
): Promise<CuratorRunResult | null> {
  try {
    if (!shouldRunNow()) return null;
    if (opts.idleForSeconds !== undefined) {
      const cfg = getConfig();
      const minIdleS = cfg.CURATOR_MIN_IDLE_HOURS * 3600;
      if (opts.idleForSeconds < minIdleS) {
        log.info("Curator skipped — agent not idle long enough", {
          idleSeconds: opts.idleForSeconds,
          minIdleSeconds: minIdleS,
        });
        return null;
      }
    }
    return await runCuratorReview(agent, { onSummary: opts.onSummary });
  } catch (e) {
    log.warn("maybeRunCurator failed", { error: String(e) });
    return null;
  }
}

export interface CuratorRunOptions {
  /** Preview mode — skip auto-transitions, instruct LLM not to mutate. */
  dryRun?: boolean;
  onSummary?: (s: string) => void;
}

/**
 * Single curator pass. Phase A then Phase B.
 *
 * Phase A is a synchronous pure-logic walk; safe to do unconditionally.
 * Phase B forks an agent on Sonnet, takes minutes, and is wrapped in
 * try/catch so a failure mid-LLM doesn't lose Phase A's progress.
 */
export async function runCuratorReview(
  agent: AgentService,
  opts: CuratorRunOptions = {},
): Promise<CuratorRunResult> {
  const start = new Date();
  const dryRun = !!opts.dryRun;

  // Phase A — pure-logic transitions.
  const autoTransitions: TransitionCounts = dryRun
    ? { checked: agentCreatedReport().length, marked_stale: 0, archived: 0, reactivated: 0 }
    : applyAutomaticTransitions(start);

  const autoSummary = formatAutoSummary(autoTransitions);
  opts.onSummary?.(`curator: ${dryRun ? "dry-run " : ""}${autoSummary}`);

  // Persist progress eagerly so a Phase B crash doesn't cause re-trigger.
  if (!dryRun) {
    const state = loadState();
    state.lastRunAt = start.toISOString();
    state.runCount += 1;
    state.lastRunSummary = `auto: ${autoSummary}`;
    saveState(state);
  }

  // Phase B — LLM consolidation.
  const candidates = renderCandidateList();
  let llmSummary = "skipped (no candidates)";
  let consolidations: ConsolidationEntry[] = [];
  let prunings: PruningEntry[] = [];
  let costUsd = 0;
  let llmError: string | null = null;
  let llmFinalText = "";

  if (candidates.skillsCount > 0) {
    try {
      const cfg = getConfig();
      const prompt = dryRun
        ? `${CURATOR_DRY_RUN_BANNER}\n\n${CURATOR_REVIEW_PROMPT}\n\n${candidates.text}`
        : `${CURATOR_REVIEW_PROMPT}\n\n${candidates.text}`;

      const result = await withWriteOriginAsync(BACKGROUND_REVIEW, () =>
        agent.run({
          prompt,
          source: "heartbeat",
          sourceId: `curator-${start.toISOString()}`,
          maxTurns: 200,
          model: cfg.CURATOR_MODEL,
          backend: "claude",
          _isBackgroundReview: true,
          _lightweightSystemPrompt: true,
        }),
      );

      llmFinalText = result.result;
      costUsd = result.costUsd;
      const parsed = parseStructuredSummary(llmFinalText);
      consolidations = parsed.consolidations;
      prunings = parsed.prunings;
      const totalActions = consolidations.length + prunings.length;
      llmSummary = totalActions === 0
        ? "no changes"
        : `${consolidations.length} consolidated, ${prunings.length} pruned`;
    } catch (e) {
      llmError = e instanceof Error ? e.message : String(e);
      llmSummary = `error (${llmError})`;
      log.warn("Curator LLM pass failed", { error: llmError });
    }
  }

  const elapsed = Date.now() - start.getTime();
  const finalSummary = `${dryRun ? "dry-run " : ""}auto: ${autoSummary}; llm: ${llmSummary}`;
  opts.onSummary?.(`curator: ${finalSummary}`);

  // Write per-run report.
  let reportPath: string | null = null;
  try {
    reportPath = writeRunReport({
      startedAt: start,
      elapsedMs: elapsed,
      autoTransitions,
      autoSummary,
      llmSummary,
      llmFinalText,
      llmError,
      consolidations,
      prunings,
      dryRun,
      candidatesCount: candidates.skillsCount,
      costUsd,
    });
  } catch (e) {
    log.warn("Failed to write curator report", { error: String(e) });
  }

  if (!dryRun) {
    const state = loadState();
    state.lastRunDurationMs = elapsed;
    state.lastRunSummary = finalSummary;
    state.lastReportPath = reportPath;
    saveState(state);
  }

  return {
    startedAt: start.toISOString(),
    durationMs: elapsed,
    autoTransitions,
    llmSummary,
    consolidations,
    prunings,
    reportPath,
    costUsd,
    error: llmError,
  };
}

function formatAutoSummary(c: TransitionCounts): string {
  const parts: string[] = [];
  if (c.marked_stale) parts.push(`${c.marked_stale} marked stale`);
  if (c.archived) parts.push(`${c.archived} archived`);
  if (c.reactivated) parts.push(`${c.reactivated} reactivated`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

interface RenderedCandidates {
  text: string;
  skillsCount: number;
}

/**
 * Render the candidate list — only agent-created skills, with usage stats.
 * Empty list short-circuits the LLM pass.
 */
function renderCandidateList(): RenderedCandidates {
  const report = agentCreatedReport();
  if (report.length === 0) {
    return { text: "(no agent-created skills — nothing to curate)", skillsCount: 0 };
  }

  const onDisk = new Map(listSkills().map((s) => [s.name, s]));
  const lines: string[] = [
    "## Candidate skills",
    "",
    "Format: `name | description | use_count/view_count/patch_count | state | pinned | last_activity`",
    "",
  ];
  for (const { name, record } of report) {
    const disk = onDisk.get(name);
    const desc = disk?.description ?? "(missing on disk — orphan record)";
    const last =
      record.last_used_at ?? record.last_patched_at ?? record.last_viewed_at ?? record.created_at;
    lines.push(
      `- **${name}** | ${desc} | use=${record.use_count} view=${record.view_count} patch=${record.patch_count} | ${record.state} | pinned=${record.pinned} | ${last}`,
    );
  }
  return { text: lines.join("\n"), skillsCount: report.length };
}

/**
 * Extract the structured YAML block from the curator's final response.
 * Format the model is instructed to emit:
 *
 *   ```yaml
 *   consolidations:
 *     - from: <name>
 *       into: <umbrella>
 *       reason: <one short sentence>
 *   prunings:
 *     - name: <name>
 *       reason: <one short sentence>
 *   ```
 *
 * Tolerates surrounding chatter, missing keys, and either list being empty.
 * On parse failure, returns empty lists — Phase B's mutations are still on
 * disk in .archive/, the report just won't have a structured breakdown.
 */
export function parseStructuredSummary(text: string): {
  consolidations: ConsolidationEntry[];
  prunings: PruningEntry[];
} {
  const consolidations: ConsolidationEntry[] = [];
  const prunings: PruningEntry[] = [];

  // Find the last ```yaml ... ``` fence in the text (model occasionally emits
  // multiple — last one wins, matches the "block comes AFTER the human
  // summary" instruction in the prompt).
  const fenceRe = /```ya?ml\s*\n([\s\S]*?)```/g;
  let lastBody: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) lastBody = m[1];
  if (!lastBody) return { consolidations, prunings };

  let section: "consolidations" | "prunings" | null = null;
  let current: Record<string, string> = {};
  const flush = () => {
    if (Object.keys(current).length === 0) return;
    if (section === "consolidations" && current.from && current.into) {
      consolidations.push({
        from: current.from,
        into: current.into,
        reason: current.reason ?? "",
      });
    } else if (section === "prunings" && current.name) {
      prunings.push({ name: current.name, reason: current.reason ?? "" });
    }
    current = {};
  };

  for (const raw of lastBody.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;

    if (/^consolidations:\s*(\[\s*\])?\s*$/.test(line)) {
      flush();
      section = "consolidations";
      continue;
    }
    if (/^prunings:\s*(\[\s*\])?\s*$/.test(line)) {
      flush();
      section = "prunings";
      continue;
    }

    if (!section) continue;

    // New list item — starts a new entry.
    const itemMatch = /^\s*-\s*(.*)$/.exec(line);
    if (itemMatch) {
      flush();
      const remainder = itemMatch[1].trim();
      if (remainder) {
        const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(remainder);
        if (kv) current[kv[1]] = stripYamlValue(kv[2]);
      }
      continue;
    }

    // Continuation key:value within the current item.
    const kv = /^\s+([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv) current[kv[1]] = stripYamlValue(kv[2]);
  }
  flush();

  return { consolidations, prunings };
}

function stripYamlValue(s: string): string {
  let v = s.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

interface ReportInputs {
  startedAt: Date;
  elapsedMs: number;
  autoTransitions: TransitionCounts;
  autoSummary: string;
  llmSummary: string;
  llmFinalText: string;
  llmError: string | null;
  consolidations: ConsolidationEntry[];
  prunings: PruningEntry[];
  dryRun: boolean;
  candidatesCount: number;
  costUsd: number;
}

function writeRunReport(r: ReportInputs): string {
  const stamp = r.startedAt.toISOString().replace(/[:.]/g, "-");
  const dir = join(CURATOR_REPORTS_DIR, stamp);
  mkdirSync(dir, { recursive: true });

  const md: string[] = [
    `# Curator run — ${r.startedAt.toISOString()}`,
    "",
    `- mode: ${r.dryRun ? "dry-run (preview)" : "live"}`,
    `- duration: ${(r.elapsedMs / 1000).toFixed(1)}s`,
    `- candidates: ${r.candidatesCount}`,
    `- cost: $${r.costUsd.toFixed(4)}`,
    "",
    "## Phase A — automatic transitions",
    "",
    `${r.autoSummary} (checked ${r.autoTransitions.checked}, stale ${r.autoTransitions.marked_stale}, archived ${r.autoTransitions.archived}, reactivated ${r.autoTransitions.reactivated})`,
    "",
    "## Phase B — LLM consolidation",
    "",
    `Summary: ${r.llmSummary}`,
    "",
  ];

  if (r.consolidations.length > 0) {
    md.push("### Consolidations", "");
    for (const c of r.consolidations) {
      md.push(`- **${c.from}** → **${c.into}** — ${c.reason}`);
    }
    md.push("");
  }
  if (r.prunings.length > 0) {
    md.push("### Prunings", "");
    for (const p of r.prunings) {
      md.push(`- **${p.name}** — ${p.reason}`);
    }
    md.push("");
  }
  if (r.llmError) {
    md.push("### Error", "", "```", r.llmError, "```", "");
  }
  if (r.llmFinalText) {
    md.push("---", "", "## Full LLM output", "", r.llmFinalText, "");
  }

  const reportPath = join(dir, "REPORT.md");
  writeFileSync(reportPath, md.join("\n"));

  // Also dump the raw run.json for downstream tooling.
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify(
      {
        started_at: r.startedAt.toISOString(),
        duration_ms: r.elapsedMs,
        dry_run: r.dryRun,
        cost_usd: r.costUsd,
        candidates_count: r.candidatesCount,
        auto_transitions: r.autoTransitions,
        auto_summary: r.autoSummary,
        llm_summary: r.llmSummary,
        consolidations: r.consolidations,
        prunings: r.prunings,
        error: r.llmError,
      },
      null,
      2,
    ),
  );

  return reportPath;
}

// Public re-exports for callers (CLI commands, dashboard).
export { loadState, saveState, isPaused, shouldRunNow };
export { applyAutomaticTransitions } from "./transitions.ts";
