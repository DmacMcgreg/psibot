import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { embedBatch } from "../src/shared/embeddings.ts";

loadConfig();
initDb();
const db = getDb();

const BATCH = 100;
const BODY_CAP = 2000;

interface Row {
  id: number;
  title: string;
  body: string;
}

const remaining = () =>
  (db
    .prepare("SELECT COUNT(*) AS n FROM atlas_items WHERE embedded_at IS NULL")
    .get() as { n: number }).n;

const startTotal = remaining();
console.log(`Embedding backlog: ${startTotal}`);

const insert = db.prepare(
  "INSERT OR REPLACE INTO atlas_items_vec (rowid, embedding) VALUES (?, ?)",
);
const markEmbedded = db.prepare(
  "UPDATE atlas_items SET embedded_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
);

const selectStmt = db.prepare<Row, [number]>(
  `SELECT id, title, body
   FROM atlas_items
   WHERE embedded_at IS NULL
   ORDER BY id
   LIMIT ?`,
);

let processed = 0;
const t0 = Date.now();

while (true) {
  const rows = selectStmt.all(BATCH);
  if (rows.length === 0) break;

  const texts = rows.map((r) => {
    const title = (r.title ?? "").trim();
    const body = (r.body ?? "").slice(0, BODY_CAP).trim();
    return title && body ? `${title}\n\n${body}` : title || body || " ";
  });

  try {
    const vectors = await embedBatch(texts);
    for (let i = 0; i < rows.length; i++) {
      insert.run(rows[i].id, vectors[i]);
      markEmbedded.run(rows[i].id);
    }
    processed += rows.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  batch done: ${processed}/${startTotal} (${elapsed}s elapsed)`);
  } catch (err) {
    console.error("batch failed, skipping:", (err as Error).message);
    break;
  }
}

console.log(`\nEmbedded ${processed} atlas items.`);
console.log(`Remaining unembedded: ${remaining()}`);
