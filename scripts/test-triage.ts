#!/usr/bin/env bun
/**
 * Test the improved triage on a small batch of pending items.
 * Usage: bun run scripts/test-triage.ts [limit]
 */
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { getPendingItems } from "../src/db/queries.ts";
import { triageBatch } from "../src/triage/index.ts";

loadConfig();
initDb();

const limit = Number(process.argv[2]) || 5;
const pending = getPendingItems("pending", limit);

if (pending.length === 0) {
  console.log("No pending items to triage.");
  process.exit(0);
}

console.log(`Triaging ${pending.length} items...\n`);
for (const item of pending) {
  console.log(`  - [${item.source}] ${item.title?.slice(0, 80) ?? item.url}`);
}
console.log();

await triageBatch(pending);

// Show results
console.log("\n--- Results ---\n");
for (const item of pending) {
  const updated = getPendingItems("triaged", 500).find((i) => i.id === item.id)
    ?? getPendingItems("deleted", 500).find((i) => i.id === item.id);
  if (updated) {
    console.log(`[P${updated.priority}] ${updated.category?.toUpperCase()} — ${updated.title?.slice(0, 60)}`);
    console.log(`  ${updated.triage_summary}`);
    console.log();
  }
}
