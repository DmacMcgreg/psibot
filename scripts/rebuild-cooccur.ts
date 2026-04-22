import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { rebuildCooccurrence } from "../src/atlas/entities.ts";

loadConfig();
initDb();

console.log("Rebuilding atlas_entity_cooccur from mentions...");
const pairs = rebuildCooccurrence();
console.log(`Wrote ${pairs} cooccurrence pairs`);
