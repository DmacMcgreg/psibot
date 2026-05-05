import { writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { getAllTagsWithCounts } from "../src/youtube/db.ts";

loadConfig();
initDb();

const OUT = "/tmp/yt_tags_for_llm.tsv";
const tags = getAllTagsWithCounts();
const lines = ["count\ttag"];
for (const t of tags) {
  lines.push(`${t.count}\t${t.tag}`);
}
writeFileSync(OUT, lines.join("\n") + "\n");
console.log(`Wrote ${tags.length} tags to ${OUT}`);
console.log(`Singletons: ${tags.filter((t) => t.count === 1).length}`);
console.log(`Total assignments: ${tags.reduce((s, t) => s + t.count, 0)}`);
