/**
 * Child process for the discovery Jev gate (see jev-gate.ts vaultAsker).
 * Runs under `vault run`, which injects OPENROUTER_API_KEY. Reads Jev
 * payloads from a file, asks them, writes answers to a file. Prints nothing
 * large: vault run hangs on stdout over ~8 KB.
 *
 *   bun src/discovery/jev-gate-cli.ts <in.json> <out.json> <budgetUsd>
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { JevBudgetExceeded, JevClient, type Payload } from "../relevance/jev.ts";

const [inPath, outPath, budgetArg] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: jev-gate-cli.ts <in.json> <out.json> <budgetUsd>");
  process.exit(2);
}
const budget = Number(budgetArg);
const client = new JevClient({ budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : 0.03 });
const payloads = JSON.parse(readFileSync(inPath, "utf-8")) as Payload[];
const answers = await client.askMany(payloads);
const out = {
  model: client.model,
  cost: client.totalCost,
  liveCalls: client.liveCalls,
  answers: answers.map((a) => (a instanceof Error ? { error: a.message.slice(0, 300), budget: a instanceof JevBudgetExceeded } : a)),
};
writeFileSync(`${outPath}.tmp`, JSON.stringify(out));
renameSync(`${outPath}.tmp`, outPath);
console.error(`jev-gate: ${payloads.length} items, ${client.liveCalls} live, ${client.cacheHits} cached, $${client.totalCost.toFixed(5)}`);
