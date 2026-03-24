#!/usr/bin/env bun
/**
 * Seed the morning brief cron job into PsiBot's database.
 * Run: bun run scripts/seed-morning-brief.ts
 */
import { initDb } from "../src/db/index.ts";
import { createJob, getAllJobs } from "../src/db/queries.ts";
import { loadConfig } from "../src/config.ts";

loadConfig();
initDb();

const MORNING_BRIEF_NAME = "Morning Brief";

// Check if already exists
const existing = getAllJobs().find((j) => j.name === MORNING_BRIEF_NAME);
if (existing) {
  console.log(`Job "${MORNING_BRIEF_NAME}" already exists (ID: ${existing.id}, status: ${existing.status})`);
  process.exit(0);
}

const prompt = `Read the file knowledge/MORNING-BRIEF.md for full instructions, then generate and deliver today's morning brief.

Fetch data from all sources in parallel. If any source fails, skip it and note it was unavailable. Wrap the full briefing in [NOTIFY]...[/NOTIFY] markers so it gets sent via Telegram. Also save the brief as a markdown file to ~/Documents/NotePlan-Notes/Notes/60 - Briefings/ using today's date.`;

const job = createJob({
  name: MORNING_BRIEF_NAME,
  prompt,
  type: "cron",
  schedule: "30 6 * * *", // 6:30 AM local time (croner uses local timezone)
  use_browser: true,
  model: "sonnet",
  backend: "claude", // Use Claude for morning brief (needs strong reasoning)
});

console.log(`Created job: ${job.name} (ID: ${job.id})`);
console.log(`Schedule: ${job.schedule} (10:30 UTC = 6:30 AM EDT)`);
console.log(`Model: ${job.model} (backend: ${job.backend})`);
console.log(`\nTo test manually: use /jobs in Telegram, then trigger it`);
