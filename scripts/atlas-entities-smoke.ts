import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { extractEntitiesForItem, seedTickerAliases, indexItemEntities } from "../src/atlas/entities.ts";
import { getItem } from "../src/atlas/index.ts";

loadConfig();
initDb();
const db = getDb();

seedTickerAliases();

// Pick one item of each kind with a non-trivial body.
const kinds = ["inbox", "youtube", "signal", "research", "scan", "daily_log"] as const;

for (const kind of kinds) {
  const row = db
    .prepare<{ id: number }, [string]>(
      `SELECT id FROM atlas_items
       WHERE kind = ? AND length(body) > 150
       ORDER BY captured_at DESC
       LIMIT 1`,
    )
    .get(kind);
  if (!row) {
    console.log(`\n[${kind}] (no items)`);
    continue;
  }
  const item = getItem(row.id);
  if (!item) continue;
  console.log(`\n[${kind}] #${item.id} ${item.title.slice(0, 70)}`);
  const ents = await extractEntitiesForItem(item);
  if (ents.length === 0) {
    console.log("  (none)");
    continue;
  }
  for (const e of ents) {
    console.log(`  ${e.kind} :: ${e.raw}  — ${e.context.slice(0, 80)}`);
  }
}

console.log("\nEntity counts:");
const counts = db
  .prepare<{ kind: string; n: number }, []>(
    "SELECT kind, COUNT(*) AS n FROM atlas_entities GROUP BY kind",
  )
  .all();
for (const c of counts) console.log(`  ${c.kind}: ${c.n}`);
