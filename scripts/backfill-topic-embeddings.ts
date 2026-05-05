import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { embedBatch } from "../src/youtube/embeddings.ts";
import { upsertTopicEmbedding } from "../src/youtube/graph.ts";

loadConfig();
initDb();
const db = getDb();

interface TopicRow {
  id: number;
  display_name: string;
  description: string;
}

const topics = db
  .prepare<TopicRow, []>(`SELECT id, display_name, description FROM youtube_topics ORDER BY id`)
  .all();

console.log(`Embedding ${topics.length} topics...`);

const existingVecIds = new Set(
  db.prepare<{ rowid: number }, []>(`SELECT rowid FROM youtube_topic_vec`).all().map((r) => r.rowid)
);

const BATCH_SIZE = 100;
let embedded = 0;
let skipped = 0;

for (let i = 0; i < topics.length; i += BATCH_SIZE) {
  const batch = topics.slice(i, i + BATCH_SIZE);
  const toEmbed = batch.filter((t) => !existingVecIds.has(t.id));

  if (toEmbed.length === 0) {
    skipped += batch.length;
    continue;
  }

  const texts = toEmbed.map((t) => `${t.display_name}: ${t.description}`.slice(0, 2000));
  const embeddings = await embedBatch(texts);

  for (let j = 0; j < toEmbed.length; j++) {
    upsertTopicEmbedding(toEmbed[j].id, embeddings[j]);
  }

  embedded += toEmbed.length;
  skipped += batch.length - toEmbed.length;
  console.log(`  Progress: ${embedded + skipped}/${topics.length} (embedded: ${embedded}, skipped: ${skipped})`);
}

const finalVecCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topic_vec`).get()!.c;
const finalTopicCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topics`).get()!.c;

console.log(`\nDone.`);
console.log(`  Topics: ${finalTopicCount}`);
console.log(`  Topic embeddings: ${finalVecCount}`);
console.log(`  Embedded this run: ${embedded}`);
console.log(`  Skipped (already embedded): ${skipped}`);

if (finalVecCount !== finalTopicCount) {
  console.warn(`WARNING: ${finalTopicCount - finalVecCount} topics still missing embeddings`);
  process.exit(1);
}
