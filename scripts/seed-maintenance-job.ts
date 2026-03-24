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
  schedule: "0 */4 * * *",
  max_budget_usd: 1.0,
  use_browser: false,
  model: null,
  backend: "claude",
});

console.log(`Created job: ${job.name} (id: ${job.id}, schedule: every 4 hours)`);
