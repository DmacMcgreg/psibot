import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import {
  fastPathSignal,
  seedTickerAliases,
  rebuildCooccurrence,
  indexItemEntities,
} from "../src/atlas/entities.ts";
import { getItem } from "../src/atlas/index.ts";

loadConfig();
initDb();
const db = getDb();

seedTickerAliases();

// --- Phase 1: free fast-path over all signals ---
const signalIds = db
  .prepare<{ id: number }, []>(
    `SELECT id FROM atlas_items
     WHERE kind = 'signal' AND entity_extracted_at IS NULL`,
  )
  .all();
console.log(`fast-path signals: ${signalIds.length}`);

let fastCount = 0;
for (const { id } of signalIds) {
  const item = getItem(id);
  if (!item) continue;
  const n = fastPathSignal(item);
  if (n !== null) {
    db.prepare(
      "UPDATE atlas_items SET entity_extracted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    ).run(id);
    if (n > 0) fastCount++;
  }
}
console.log(`signals with ticker: ${fastCount}`);

// --- Phase 2: run LLM backfill with bounded concurrency ---
const LLM_BUDGET = Number(process.argv[2] ?? 20);
const CONCURRENCY = Number(process.argv[3] ?? 8);
console.log(`\nLLM budget: ${LLM_BUDGET} items, concurrency: ${CONCURRENCY}`);

const llmIds = db
  .prepare<{ id: number }, [number]>(
    `SELECT id FROM atlas_items
     WHERE entity_extracted_at IS NULL
       AND kind != 'signal'
       AND length(body) + length(title) >= 80
     ORDER BY captured_at DESC
     LIMIT ?`,
  )
  .all(LLM_BUDGET);

let llmCount = 0;
let failCount = 0;
const startedAt = Date.now();
const queue = [...llmIds];

async function worker(workerId: number): Promise<void> {
  while (true) {
    const next = queue.shift();
    if (!next) return;
    const item = getItem(next.id);
    if (!item) continue;
    try {
      const n = await indexItemEntities(item);
      llmCount++;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      const rate = (llmCount / Math.max(Number(elapsed), 1)).toFixed(2);
      console.log(
        `  [w${workerId}] [${item.kind}] #${item.id} -> ${n} entities  (${llmCount}/${llmIds.length} done @ ${rate}/s, ${elapsed}s elapsed)`,
      );
    } catch (err) {
      failCount++;
      console.error(`  [w${workerId}] failed #${item.id}: ${(err as Error).message}`);
    }
  }
}

await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, llmIds.length) }, (_, i) => worker(i + 1)),
);
const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(
  `\nLLM-extracted: ${llmCount}/${llmIds.length} (${failCount} failed) in ${totalSec}s`,
);

// --- Phase 3: rebuild cooccur from final mention set ---
const pairs = rebuildCooccurrence();
console.log(`\nRebuilt cooccur: ${pairs} edges`);

// --- Phase 4: summary ---
const stats = db
  .prepare<{ kind: string; n: number }, []>(
    "SELECT kind, COUNT(*) AS n FROM atlas_entities GROUP BY kind",
  )
  .all();
console.log(`\nAtlas entities:`);
for (const s of stats) console.log(`  ${s.kind}: ${s.n}`);

const mentions = (db
  .prepare("SELECT COUNT(*) AS n FROM atlas_entity_mentions")
  .get() as { n: number }).n;
console.log(`  mentions: ${mentions}`);

const remaining = (db
  .prepare("SELECT COUNT(*) AS n FROM atlas_items WHERE entity_extracted_at IS NULL")
  .get() as { n: number }).n;
console.log(`  remaining (unprocessed): ${remaining}`);
