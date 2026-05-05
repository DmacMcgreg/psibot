import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { embedBatch } from "../src/youtube/embeddings.ts";

loadConfig();
initDb();
const db = getDb();

/**
 * Seed youtube_tag_canonicals + youtube_tag_vec from the current
 * youtube_videos.tags vocabulary. Intended to run once after the schema
 * migration; subsequent videos will add new canonicals on-the-fly via
 * canonicalizeTags() in process.ts.
 *
 * Idempotent: skips tags that already exist in youtube_tag_canonicals.
 * Embeds only the tags that are missing, so rerunning after a partial
 * failure picks up where it left off.
 */

interface TagCountRow {
  tag: string;
  count: number;
}

// Scrape tag vocabulary from existing video tags
const videoRows = db
  .prepare<{ tags: string }, []>(`SELECT tags FROM youtube_videos`)
  .all();

const counts = new Map<string, number>();
for (const row of videoRows) {
  let parsed: unknown;
  try { parsed = JSON.parse(row.tags); } catch { continue; }
  if (!Array.isArray(parsed)) continue;
  for (const t of parsed) {
    if (typeof t !== "string" || t.trim().length === 0) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
}

const allTags: TagCountRow[] = [...counts.entries()]
  .map(([tag, count]) => ({ tag, count }))
  .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

console.log(`Found ${allTags.length} unique tags across ${videoRows.length} videos.`);

// Anything already in youtube_tag_canonicals should be skipped (idempotent re-run)
const existingNames = new Set(
  db.prepare<{ name: string }, []>(`SELECT name FROM youtube_tag_canonicals`).all().map((r) => r.name)
);
console.log(`Already canonicalized: ${existingNames.size}`);

const toInsert = allTags.filter((t) => !existingNames.has(t.tag));
console.log(`To insert: ${toInsert.length}`);

if (toInsert.length === 0) {
  console.log("Nothing to backfill.");
  process.exit(0);
}

// Step 1: insert canonical rows in a transaction so we have stable IDs before embedding
console.log("Inserting canonical rows...");
const insertStmt = db.prepare<{ id: number }, [string, number]>(
  `INSERT INTO youtube_tag_canonicals (name, usage_count) VALUES (?, ?) RETURNING id`
);

const tx = db.transaction((rows: TagCountRow[]) => {
  const ids: number[] = [];
  for (const r of rows) {
    const res = insertStmt.get(r.tag, r.count);
    if (!res) throw new Error(`Insert returned null for tag "${r.tag}"`);
    ids.push(res.id);
  }
  return ids;
});

const insertedIds = tx(toInsert);
console.log(`Inserted ${insertedIds.length} canonical rows.`);

// Step 2: embed in batches of 100 (matches backfill-topic-embeddings.ts pacing)
const BATCH = 100;
console.log(`Embedding ${toInsert.length} tags in batches of ${BATCH}...`);

const upsertVec = db.prepare(`INSERT INTO youtube_tag_vec (rowid, embedding) VALUES (?, ?)`);

let embedded = 0;
for (let i = 0; i < toInsert.length; i += BATCH) {
  const slice = toInsert.slice(i, i + BATCH);
  const idSlice = insertedIds.slice(i, i + BATCH);
  // Mirror embeddingTextForTag: hyphens -> spaces so "ai-safety" embeds like "ai safety"
  const texts = slice.map((r) => r.tag.replace(/-/g, " "));

  try {
    const embeddings = await embedBatch(texts);
    const embedTx = db.transaction(() => {
      for (let j = 0; j < embeddings.length; j++) {
        upsertVec.run(BigInt(idSlice[j]), embeddings[j]);
      }
    });
    embedTx();
    embedded += embeddings.length;
    console.log(`  [${embedded}/${toInsert.length}] embedded`);
  } catch (err) {
    console.error(`Batch ${i}..${i + slice.length} failed:`, err);
    throw err;
  }
}

const finalCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_tag_canonicals`).get()!.c;
const vecCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_tag_vec`).get()!.c;
console.log(`\nDone. Canonical tags: ${finalCount}, vec rows: ${vecCount}`);
