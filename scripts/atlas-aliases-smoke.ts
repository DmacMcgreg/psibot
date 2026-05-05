import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { computeAliasProposals } from "../src/atlas/alias-producer.ts";

loadConfig();
initDb();
const db = getDb();

function section(label: string) {
  console.log(`\n=== ${label} ===`);
}

section("Entity counts by kind (mention_count >= 2)");
const entityCounts = db
  .prepare<{ kind: string; n: number }, []>(
    `SELECT kind, COUNT(*) AS n FROM atlas_entities
     WHERE mention_count >= 2
     GROUP BY kind`,
  )
  .all();
if (entityCounts.length === 0) {
  console.log("  (no candidate entities — need >= 2 mentions to qualify)");
} else {
  for (const c of entityCounts) console.log(`  ${c.kind}: ${c.n}`);
}

section("Existing alias rows");
const existingAliasCount = (
  db.prepare("SELECT COUNT(*) AS n FROM atlas_entity_aliases").get() as { n: number }
).n;
console.log(`  ${existingAliasCount}`);

section("Pending proposals already in queue");
const pendingCount = (
  db
    .prepare("SELECT COUNT(*) AS n FROM atlas_alias_proposals WHERE status = 'pending'")
    .get() as { n: number }
).n;
console.log(`  ${pendingCount}`);

section("Dry run: what the producer WOULD propose this cycle");
const result = computeAliasProposals();
console.log(
  `  ${result.batch.length} new proposals (candidates: ${result.candidates}, skipped-existing-alias: ${result.skippedExistingAlias}, skipped-already-pending: ${result.skippedExistingProposal})`,
);

if (result.batch.length === 0) {
  console.log("\n  (nothing new to propose)");
} else {
  const byEntity = db.prepare<
    { kind: string; name: string },
    [number]
  >(`SELECT kind, display_name AS name FROM atlas_entities WHERE id = ?`);
  console.log();
  for (const p of result.batch) {
    const ent = byEntity.get(p.entity_id);
    const tag = ent ? `[${ent.kind}] "${ent.name}"` : `entity#${p.entity_id}`;
    console.log(`  ${tag}  \u2190  "${p.alias_norm}"   (${p.reason})`);
  }
}

console.log("\n(No DB writes performed — this is a dry run.)");
