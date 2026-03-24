#!/usr/bin/env bun
// Quick script to triage all pending inbox items

import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { triageAllPending } from "../src/triage/index.ts";

await loadConfig();
await initDb();
const count = await triageAllPending();
console.log(`Triaged ${count} items.`);
