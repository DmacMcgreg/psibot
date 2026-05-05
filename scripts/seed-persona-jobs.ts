#!/usr/bin/env bun
/**
 * Seed three self-directed persona jobs that drive the new agents in trading-bot.
 *
 * Each job runs once per weekday after market close, fetches the agent's
 * portfolio and strategy from the trading-bot API, decides any trades, and
 * emits an envelope. Envelopes get auto-applied to the agent's paper portfolio.
 *
 * Idempotent: a job with the same name is updated in place (prompt + schedule).
 *
 * Usage: bun run scripts/seed-persona-jobs.ts
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";

const DB_PATH = process.env.DB_PATH ?? join(import.meta.dir, "..", "data", "app.db");
const TRADING_BOT_URL = process.env.TRADING_BOT_URL ?? "http://localhost:8000";

// Trading topic in the Psibot group; matches existing jobs 30/36/37/38/39
const NOTIFY_CHAT_ID = process.env.PSIBOT_GROUP_CHAT_ID ?? "-1003762174787";
const NOTIFY_TOPIC_ID = 103;

interface PersonaJob {
  name: string;
  slug: string;
  schedule: string; // cron, UTC
}

const PERSONAS: PersonaJob[] = [
  // Run weekdays at 21:30 UTC (5:30pm ET, 30 min after close)
  { name: "Momentum Bot — Daily Decisions", slug: "momentum",       schedule: "30 21 * * 1-5" },
  { name: "Mean Reversion Bot — Daily Decisions", slug: "mean-reversion", schedule: "35 21 * * 1-5" },
  { name: "Macro Tactical Bot — Daily Decisions", slug: "macro-tactical", schedule: "40 21 * * 1-5" },
];

function buildPrompt(slug: string, name: string): string {
  return `You are ${name}, a self-directed paper-trading agent. Your strategy and constraints are stored on the trading-bot API.

Run this protocol every time you fire:

1. Fetch your CURRENT STATE from trading-bot:
   - GET ${TRADING_BOT_URL}/api/v1/agents/${slug} (your persona prompt + strategy)
   - GET ${TRADING_BOT_URL}/api/v1/agents/${slug}/portfolio (your cash, positions, equity, equity curve)

2. Pull MARKET CONTEXT from trading-bot tools:
   - Current regime (REGIME.md or trading-bot regime endpoint)
   - Watchlist + recent setups (knowledge/trading/PLAYBOOK.md, recent scans)
   - Any outstanding signals from House agent's recent runs

3. Apply YOUR persona prompt's rules to today's setups. Decide:
   - New entries (with explicit entry, stop, target, position size in dollars)
   - Trims/exits (with rationale: stop hit, target reached, regime change, thesis broken)
   - Hold-with-no-action (also valid — most days)

4. Validate: total new buys must not exceed available cash. Total sells must not exceed shares held.
   If a planned trade fails validation, drop it and note in summary.

5. Output:
   - PROSE summary (4-6 sentences) above the envelope, suitable for Telegram
   - FENCED JSON envelope at the very end (this is the source of truth for the dashboard).

Envelope requirements:
- agent_id: "${slug}"
- agent_name: "${name.replace(" — Daily Decisions", "")}"
- run_type: "self_directed"
- status: "success" (or "partial" if you knew you'd violate a constraint and dropped trades)
- headline: one sentence (e.g., "Added JPM long, trimmed AVGO into resistance")
- summary: 2-3 sentences
- trades: [] if no trades; otherwise list each as { symbol, side ("buy"|"sell"), shares, price, executed_at, rationale }
- artifacts: include a metric_grid of (new entries / trims / exits / cash %), plus a markdown reasoning section
- Use last close price for fills; the dashboard auto-applies trades and writes an equity snapshot

If trading-bot is unreachable, emit an envelope with status="error", headline explaining the issue, and trades=[].

Be conservative on day one. Build conviction over time by reading your past runs:
${TRADING_BOT_URL}/api/v1/agent-runs?agent_id=${slug}&limit=20

Do NOT post a message to the Trading Telegram topic explicitly — the executor handles delivery.

<!-- agent-run-envelope:v1 -->
`;
}

const db = new Database(DB_PATH);

const findByName = db.prepare("SELECT id, prompt FROM jobs WHERE name = ?");
const insertJob = db.prepare(`
  INSERT INTO jobs (
    name, prompt, type, schedule, max_budget_usd, allowed_tools, use_browser,
    status, model, notify_chat_id, notify_topic_id, notify_policy
  ) VALUES (?, ?, 'cron', ?, 1.0, NULL, 0, 'enabled', NULL, ?, ?, 'always')
`);
const updateJob = db.prepare(`
  UPDATE jobs SET prompt = ?, schedule = ?, notify_chat_id = ?, notify_topic_id = ?,
                  status = 'enabled', updated_at = datetime('now')
  WHERE id = ?
`);

let created = 0;
let updated = 0;

for (const p of PERSONAS) {
  const prompt = buildPrompt(p.slug, p.name);
  const existing = findByName.get(p.name) as { id: number; prompt: string } | undefined;
  if (existing) {
    updateJob.run(prompt, p.schedule, NOTIFY_CHAT_ID, NOTIFY_TOPIC_ID, existing.id);
    updated++;
    console.log(`  UPDATED  job ${existing.id}  ${p.name}  (${p.schedule})`);
  } else {
    const result = insertJob.run(p.name, prompt, p.schedule, NOTIFY_CHAT_ID, NOTIFY_TOPIC_ID);
    created++;
    console.log(`  CREATED  job ${result.lastInsertRowid}  ${p.name}  (${p.schedule})`);
  }
}

console.log(`\nDone. ${created} created, ${updated} updated.`);
console.log("\nNote: the scheduler picks up new jobs on next reload. Run:");
console.log("  psibot restart");
console.log("  -- or --");
console.log("  curl -X POST http://localhost:3141/api/jobs/reload");

db.close();
