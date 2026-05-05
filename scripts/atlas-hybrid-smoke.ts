import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { hybridSearch } from "../src/atlas/search.ts";
import { counts } from "../src/atlas/index.ts";

loadConfig();
initDb();

console.log("Atlas counts:", counts());

const tests = [
  "claude agent sdk",
  "portfolio rebalancing",
  "obsidian second brain",
  "AAPL insider buy",
  "market regime",
];

for (const q of tests) {
  const results = await hybridSearch(q, { limit: 5 });
  console.log(`\nQuery: "${q}" -> ${results.length} results`);
  for (const r of results) {
    const fts = r.ftsRank !== null ? (-r.ftsRank).toFixed(2) : "-";
    const vec = r.vecDistance !== null ? r.vecDistance.toFixed(3) : "-";
    console.log(
      `  [${r.kind}] ${r.title.slice(0, 70)}  score=${r.score.toFixed(3)} fts=${fts} vec=${vec}`,
    );
  }
}
