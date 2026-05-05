#!/usr/bin/env bun
/**
 * Append agent-run envelope instructions to the 7 trading job prompts.
 *
 * Idempotent: detects the ENVELOPE_MARKER and skips jobs that already have it.
 * Run any time after editing the appendix below — re-runs replace the appendix.
 *
 * Usage: bun run scripts/update-trading-job-prompts.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "..", "data", "app.db");

const ENVELOPE_MARKER = "<!-- agent-run-envelope:v1 -->";

const RUN_TYPE_BY_JOB: Record<number, string> = {
  24: "scan",              // Overnight Stock Screener
  30: "portfolio_update",  // Portfolio Manager
  31: "brief",             // Morning Brief
  36: "scan",              // Afternoon Market Scanner
  37: "strategy_review",   // Strategy Reviewer
  38: "ml_train",          // ML Trainer
  39: "alpha_research",    // Alpha Researcher
};

function buildAppendix(jobId: number, jobName: string): string {
  const runType = RUN_TYPE_BY_JOB[jobId];
  return `

---
${ENVELOPE_MARKER}

**Required: Agent-Run Envelope**

After your normal Telegram-bound prose summary above, append a fenced JSON block matching the agent-run envelope schema. The dashboard at trading-bot/agents parses this block to render your output as typed widgets (regime indicator, signal cards, tables, etc.) and to track results across runs.

Spec: \`trading-bot/docs/agent-run-envelope.md\`

Use these fixed values for this job:
- \`agent_id\`: \`"house"\`
- \`agent_name\`: \`"House"\`
- \`run_type\`: \`"${runType}"\`

Pick artifact \`type\`s from this set: \`markdown\`, \`metric_grid\`, \`table\`, \`bullets\`, \`signals_list\`, \`regime\`, \`strategy_ranking\`, \`backtest\`, \`unified_signal\`, \`equity_curve\`, \`trade_log\`, \`file_link\`. Unknown types still render but as collapsed JSON.

Minimal example:

\`\`\`json
{
  "schema_version": "1",
  "agent_id": "house",
  "agent_name": "House",
  "run_type": "${runType}",
  "started_at": "2026-04-25T06:00:00Z",
  "completed_at": "2026-04-25T06:08:42Z",
  "status": "success",
  "headline": "<one sentence headline>",
  "summary": "<2-3 sentence prose>",
  "artifacts": [
    { "type": "markdown", "title": "${jobName}", "content": "<your full markdown body>" }
  ]
}
\`\`\`

The envelope is OPTIONAL — if you can't produce it cleanly, just send the prose and the dashboard will show this run as text only. But favor emitting it whenever you can: structured signals, regime calls, and trades become first-class UI elements.

Do not include \`source_job_id\`, \`source_run_id\`, \`cost_usd\`, or \`duration_ms\` — those are filled in by the publisher.
`;
}

const db = new Database(DB_PATH);

const select = db.prepare("SELECT id, name, prompt FROM jobs WHERE id IN (24,30,31,36,37,38,39)");
const update = db.prepare("UPDATE jobs SET prompt = ?, updated_at = datetime('now') WHERE id = ?");

const rows = select.all() as { id: number; name: string; prompt: string }[];
let changed = 0;
for (const row of rows) {
  const existingMarkerIdx = row.prompt.indexOf(ENVELOPE_MARKER);
  // Strip any prior appendix (re-runnable) and re-append the latest version
  const base = existingMarkerIdx === -1
    ? row.prompt.replace(/\s+$/, "")
    : row.prompt.slice(0, row.prompt.lastIndexOf("\n---\n", existingMarkerIdx)).replace(/\s+$/, "");
  const next = base + buildAppendix(row.id, row.name);
  if (next === row.prompt) {
    console.log(`  job ${row.id} ${row.name}: unchanged`);
    continue;
  }
  update.run(next, row.id);
  changed++;
  console.log(`  job ${row.id} ${row.name}: updated (${row.prompt.length} -> ${next.length} chars)`);
}

console.log(`\nDone. ${changed}/${rows.length} jobs updated.`);
db.close();
