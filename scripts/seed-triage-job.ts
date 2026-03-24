#!/usr/bin/env bun
/**
 * Seed the Inbox Triage cron job into PsiBot's database.
 * Run: bun run scripts/seed-triage-job.ts
 */
import { initDb } from "../src/db/index.ts";
import { createJob, getAllJobs } from "../src/db/queries.ts";
import { loadConfig } from "../src/config.ts";

loadConfig();
initDb();

const JOB_NAME = "Inbox Triage";

// Check if already exists
const existing = getAllJobs().find((j) => j.name === JOB_NAME);
if (existing) {
  console.log(`Job "${JOB_NAME}" already exists (ID: ${existing.id}, status: ${existing.status})`);
  process.exit(0);
}

const prompt = `Triage pending inbox items. Steps:
1. Use inbox_list to get pending items
2. For each pending item, evaluate its URL, title, and description against the user's interests
3. Use inbox_triage to set priority (1-5), category (research/reference/actionable/entertainment/not_worth_keeping), status (triaged or deleted), and a brief triage_summary
4. Report how many items were triaged

If no pending items, just say "No pending items to triage." — keep it brief.`;

const job = createJob({
  name: JOB_NAME,
  prompt,
  type: "cron",
  schedule: "*/30 * * * *", // Every 30 minutes
  use_browser: false,
  model: "haiku",
  backend: "glm", // Use GLM backend (free, preserves Claude Max quota)
});

console.log(`Created job: ${job.name} (ID: ${job.id})`);
console.log(`Schedule: ${job.schedule} (every 30 minutes)`);
console.log(`Model: ${job.model} (backend: ${job.backend})`);
