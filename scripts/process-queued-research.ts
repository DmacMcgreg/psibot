#!/usr/bin/env bun
/**
 * Process all deep_research_queued items directly.
 * Runs deepResearch + createResearchNote for each item.
 *
 * Usage: bun run scripts/process-queued-research.ts
 */

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
loadConfig();
initDb();

import { deepResearch, preliminaryResearch, createResearchNote } from "../src/research/index.ts";
import { getQueuedResearchItems, updatePendingItem } from "../src/db/queries.ts";

const items = getQueuedResearchItems(50);
console.log(`Found ${items.length} queued research items\n`);

let success = 0;
let failed = 0;

for (const item of items) {
  const isDeep = item.auto_decision === "deep_research_queued";
  const label = isDeep ? "Deep" : "Quick";
  const shortTitle = (item.title ?? item.url).slice(0, 70);

  process.stdout.write(`[${item.id}] ${label}: ${shortTitle}... `);

  try {
    updatePendingItem(item.id, {
      auto_decision: isDeep ? "deep_research_running" : "quick_research_running",
    });

    const result = isDeep
      ? await deepResearch(item)
      : await preliminaryResearch(item);

    const notePath = createResearchNote(item, result);

    const updates: Record<string, string | null> = {
      status: "archived",
      auto_decision: isDeep ? "deep_research_done" : "quick_research_done",
      quick_scan_summary: result.summary,
    };
    if (notePath) {
      updates.noteplan_path = notePath;
    }
    updatePendingItem(item.id, updates as Parameters<typeof updatePendingItem>[1]);

    console.log(notePath ? `OK -> ${notePath.split("/").pop()}` : "OK (no note)");
    success++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`FAILED: ${message.slice(0, 100)}`);
    updatePendingItem(item.id, {
      auto_decision: isDeep ? "deep_research_failed" : "quick_research_failed",
    });
    failed++;
  }
}

console.log(`\n--- Done ---`);
console.log(`Success: ${success}`);
console.log(`Failed: ${failed}`);
