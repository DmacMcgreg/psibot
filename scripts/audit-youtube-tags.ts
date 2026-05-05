import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { getAllTagsWithCounts } from "../src/youtube/db.ts";

loadConfig();
initDb();

const tags = getAllTagsWithCounts();
const totalVideos = tags.reduce((s, t) => s + t.count, 0);
const singletons = tags.filter((t) => t.count === 1).length;

console.log(`Unique tags: ${tags.length}`);
console.log(`Total tag-video assignments: ${totalVideos}`);
console.log(`Singletons (count=1): ${singletons}`);
console.log(`\nTop 30 tags by video count:`);
for (const t of tags.slice(0, 30)) {
  console.log(`  ${t.count.toString().padStart(4)}  ${t.tag}`);
}

console.log(`\nLength distribution:`);
const bySize: Record<string, number> = { "1-10": 0, "11-20": 0, "21-30": 0, "31+": 0 };
for (const t of tags) {
  const len = t.tag.length;
  if (len <= 10) bySize["1-10"]++;
  else if (len <= 20) bySize["11-20"]++;
  else if (len <= 30) bySize["21-30"]++;
  else bySize["31+"]++;
}
for (const [bucket, n] of Object.entries(bySize)) {
  console.log(`  ${bucket} chars: ${n}`);
}
