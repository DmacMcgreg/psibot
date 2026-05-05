import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { ftsSearch, counts } from "../src/atlas/index.ts";

loadConfig();
initDb();
const db = getDb();

const c = counts();
console.log("Atlas counts:", c);

const orphans = db
  .prepare<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM atlas_items_fts
     WHERE rowid NOT IN (SELECT id FROM atlas_items)`,
  )
  .get();
console.log("Orphan FTS rows:", orphans?.n ?? 0);

const query = "claude agent sdk";
const results = ftsSearch(query, { limit: 5 });
console.log(`\nSearch "${query}" -> ${results.length} results`);
for (const r of results) {
  console.log(`  [${r.kind}] ${r.title.slice(0, 80)}  (rank=${r.rank.toFixed(3)})`);
}

const query2 = "obsidian";
const r2 = ftsSearch(query2, { limit: 5 });
console.log(`\nSearch "${query2}" -> ${r2.length} results`);
for (const r of r2) {
  console.log(`  [${r.kind}] ${r.title.slice(0, 80)}`);
}
