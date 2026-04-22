import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const RESEARCH_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research");
const APPLY = process.argv.includes("--apply");
const db = new Database(join(process.cwd(), "data/app.db"));

interface Row {
  id: number;
  title: string;
  noteplan_path: string | null;
  status: string;
}

const rows = db
  .query<Row, []>(
    `SELECT id, title, noteplan_path, status FROM pending_items
     WHERE auto_decision = 'deep_research_queued'`,
  )
  .all();

let pointsToResearchOutput = 0;
let pointsToMissingFile = 0;
let pointsToInbox = 0;
let pointsToNull = 0;
const toMarkDone: number[] = [];

for (const r of rows) {
  if (!r.noteplan_path) {
    pointsToNull++;
    continue;
  }
  if (r.noteplan_path.startsWith(RESEARCH_DIR)) {
    pointsToResearchOutput++;
    toMarkDone.push(r.id);
    if (!existsSync(r.noteplan_path)) pointsToMissingFile++;
  } else {
    pointsToInbox++;
  }
}

console.log(`Total deep_research_queued items: ${rows.length}`);
console.log(`  → point to research OUTPUT (stuck from loop): ${pointsToResearchOutput}`);
console.log(`      of which file is MISSING (was a duplicate we deleted): ${pointsToMissingFile}`);
console.log(`  → point to inbox (legit queue waiting for research): ${pointsToInbox}`);
console.log(`  → noteplan_path is NULL: ${pointsToNull}`);
console.log();
console.log(`Action: mark ${toMarkDone.length} stuck items as deep_research_done`);

if (APPLY) {
  const stmt = db.prepare(`UPDATE pending_items SET auto_decision = 'deep_research_done' WHERE id = ?`);
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(id);
  });
  tx(toMarkDone);
  console.log(`Updated ${toMarkDone.length} rows.`);
} else {
  console.log("(dry run — pass --apply to update)");
}
