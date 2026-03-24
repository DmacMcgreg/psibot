#!/usr/bin/env bun
/**
 * Seed the Research Pipeline cron job into PsiBot's database.
 * Run: bun run scripts/seed-research-job.ts
 */
import { initDb } from "../src/db/index.ts";
import { createJob, getAllJobs } from "../src/db/queries.ts";
import { loadConfig } from "../src/config.ts";

loadConfig();
initDb();

const JOB_NAME = "Research Pipeline";

// Check if already exists
const existing = getAllJobs().find((j) => j.name === JOB_NAME);
if (existing) {
  console.log(`Job "${JOB_NAME}" already exists (ID: ${existing.id}, status: ${existing.status})`);
  process.exit(0);
}

const prompt = `Run the research pipeline for high-priority triaged items. Steps:

1. Use inbox_list with status "triaged" to find items that have been triaged
2. Look for items with category "research" and priority 1-2
3. For each high-priority research item (up to 3 per run):
   a. Use research_item with the item's ID and depth "preliminary" to do initial research
   b. Review the research findings
   c. Use create_reminder with type "research" to send the findings to the user via Telegram for approval:
      - Title: "Research: {item title}"
      - Description: Include a concise summary of findings, key insights, and why it matters
      - Priority: match the item's priority
   d. The user will approve or reject via inline keyboard. When approved, use research_approve to save the NotePlan note.
4. Report what was researched and what reminders were created

If no high-priority research items are found, just say "No items queued for research." -- keep it brief.`;

const job = createJob({
  name: JOB_NAME,
  prompt,
  type: "cron",
  schedule: "0 */6 * * *", // Every 6 hours
  use_browser: false,
  model: "claude-sonnet-4-5-20250929",
  backend: "claude",
});

console.log(`Created job: ${job.name} (ID: ${job.id})`);
console.log(`Schedule: ${job.schedule} (every 6 hours)`);
console.log(`Model: ${job.model} (backend: ${job.backend})`);
