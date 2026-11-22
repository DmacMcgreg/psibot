/**
 * Export eval + training data for the decider fine-tune (cc-j8ti). READ-ONLY on app.db.
 *
 *   bun scripts/relevance-finetune/export-data.ts <app.db> <outDir>
 *
 * Writes into outDir:
 *   folds.json            { "<atlasId>": { fold, label } }   stratified 5-fold, fixed seed
 *   human.jsonl           one row per human-labelled item: id, fold, label, lite payload
 *   eval-rubric-f{k}.jsonl  FULL triage payload (rubric built WITHOUT fold k) for fold-k items
 *   eval-lite-f{k}.jsonl    facts-only payload for fold-k items
 *   jev.jsonl             Jev pseudo-labels (unrated items only): id, p_not, p_interest, lite payload
 *
 * Does not call triageDiscover (that would create tables); never writes the DB.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildQuestions } from "../../src/relevance/triage-questions.ts";
import { litePayload } from "../../src/relevance/triage-questions-lite.ts";
import { loadChosenVideos, loadRubric, loadTodo, sampleChosen, type ItemFacts, type RubricExample } from "../../src/relevance/triage-store.ts";

const [dbPath, outDir] = process.argv.slice(2);
if (!dbPath || !outDir) throw new Error("usage: export-data.ts <app.db> <outDir>");
mkdirSync(outDir, { recursive: true });
const db = new Database(dbPath, { readonly: true });
const K = 5;
const SEED = 20261012;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rubric, deduped by atlas id (loadRubric inner-joins groups; a multi-group item can repeat)
const all = loadRubric(db);
const byId = new Map<number, RubricExample>();
for (const e of all) byId.set(e.atlasId, e);
const rated = [...byId.values()];
console.error(`loadRubric rows=${all.length} unique=${rated.length}`);

// stratified folds
const rnd = mulberry32(SEED);
const folds: Record<number, { fold: number; label: string }> = {};
for (const cls of ["interested", "not_interested"] as const) {
  const ids = rated.filter((e) => e.verdict === cls).map((e) => e.atlasId).sort((a, b) => a - b);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
  ids.forEach((id, i) => { folds[id] = { fold: i % K, label: cls }; });
}
writeFileSync(`${outDir}/folds.json`, JSON.stringify(folds));

// channel prior, as production sets it
const chosen = loadChosenVideos(db);
const chosenByChannel = new Map<string, number>();
for (const v of chosen) chosenByChannel.set(v.channel, (chosenByChannel.get(v.channel) ?? 0) + 1);
const withChannel = <T extends ItemFacts>(i: T): T => {
  if (i.by && i.source.startsWith("youtube")) i.chosenFromChannel = chosenByChannel.get(i.by) ?? 0;
  return i;
};

// fixed exclude set: every rated item + whole unrated queue, so only the rubric changes per fold
const todo = loadTodo(db, { includeTriaged: true });
const exclude = new Set<number>([...todo.map((i) => i.atlasId), ...rated.map((e) => e.atlasId)]);
const sample = sampleChosen(chosen, 40, exclude);
console.error(`chosen total=${chosen.length} sample=${sample.length} todo=${todo.length}`);

const human: string[] = [];
for (let k = 0; k < K; k++) {
  const train = rated.filter((e) => folds[e.atlasId]!.fold !== k);
  const test = rated.filter((e) => folds[e.atlasId]!.fold === k);
  const qs = buildQuestions(train, sample);
  const rub = test.map((e) => JSON.stringify({ id: e.atlasId, label: e.verdict, ...qs.payloadFor(withChannel({ ...e })) }));
  const lite = test.map((e) => JSON.stringify({ id: e.atlasId, label: e.verdict, ...litePayload(withChannel({ ...e })) }));
  writeFileSync(`${outDir}/eval-rubric-f${k}.jsonl`, rub.join("\n") + "\n");
  writeFileSync(`${outDir}/eval-lite-f${k}.jsonl`, lite.join("\n") + "\n");
  for (const e of test) human.push(JSON.stringify({ id: e.atlasId, fold: k, label: e.verdict, ...litePayload(withChannel({ ...e })) }));
  console.error(`fold ${k}: train=${train.length} test=${test.length} (not_interested ${test.filter((e) => e.verdict === "not_interested").length})`);
}
writeFileSync(`${outDir}/human.jsonl`, human.join("\n") + "\n");

// Jev pseudo-labels: only items with no discover_feedback row at all (loadTodo guarantees that)
const jev = new Map(
  db.query<{ atlas_item_id: number; p_not: number; p_interest: number; model: string }, []>(
    `SELECT atlas_item_id, p_not, p_interest, model FROM discover_jev_triage`,
  ).all().map((r) => [r.atlas_item_id, r]),
);
const rows: string[] = [];
for (const i of todo) {
  const j = jev.get(i.atlasId);
  if (!j || j.p_not === null || j.p_interest === null) continue;
  rows.push(JSON.stringify({ id: i.atlasId, p_not: j.p_not, p_interest: j.p_interest, ...litePayload(withChannel({ ...i })) }));
}
writeFileSync(`${outDir}/jev.jsonl`, rows.join("\n") + "\n");
console.error(`jev rows exported=${rows.length} of ${jev.size}`);
