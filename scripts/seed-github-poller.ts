#!/usr/bin/env bun
/**
 * Seed the GitHub starred repos poller job into PsiBot's database.
 * Run: bun run scripts/seed-github-poller.ts
 */
import { initDb } from "../src/db/index.ts";
import { createJob, getAllJobs } from "../src/db/queries.ts";
import { loadConfig } from "../src/config.ts";

loadConfig();
initDb();

const JOB_NAME = "GitHub Stars Poller";

// Check if already exists
const existing = getAllJobs().find((j) => j.name === JOB_NAME);
if (existing) {
  console.log(`Job "${JOB_NAME}" already exists (ID: ${existing.id}, status: ${existing.status})`);
  process.exit(0);
}

const prompt = `Poll GitHub starred repos using the inbox_poll_github tool. Report how many new items were captured. If no new items, just say "No new GitHub stars." — keep it brief.`;

const job = createJob({
  name: JOB_NAME,
  prompt,
  type: "cron",
  schedule: "0 */4 * * *", // Every 4 hours
  use_browser: false,
  model: "haiku",
  backend: "glm", // Use GLM backend (free, preserves Claude Max quota)
});

console.log(`Created job: ${job.name} (ID: ${job.id})`);
console.log(`Schedule: ${job.schedule} (every 4 hours)`);
console.log(`Model: ${job.model} (backend: ${job.backend})`);
