import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RESEARCH_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research/completed");
const APPLY = process.argv.includes("--apply");

const files = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith(".md"));
const existingTitles = new Set(files.map((f) => f.replace(/\.md$/, "")));

interface Stats {
  file: string;
  beforeBytes: number;
  afterBytes: number;
  relatedSectionsRemoved: number;
  wikilinksExtracted: number;
  wikilinksKept: number;
  wikilinksOrphaned: number;
}

const results: Stats[] = [];
let totalBytesRecovered = 0;

function cleanFile(filename: string): Stats | null {
  const path = join(RESEARCH_DIR, filename);
  const original = readFileSync(path, "utf-8");
  const beforeBytes = original.length;

  const firstRelated = original.indexOf("\n## Related");
  if (firstRelated === -1) return null;

  const trailingRegion = original.slice(firstRelated);
  const head = original.slice(0, firstRelated).replace(/\s+$/, "");

  const sectionCount = (trailingRegion.match(/^## Related\s*$/gm) || []).length;
  const wikilinkMatches = [...trailingRegion.matchAll(/\[\[([^\]]+)\]\]/g)];
  const wikilinkTitles = wikilinkMatches.map((m) => m[1].trim());

  const uniqueTitles = Array.from(new Set(wikilinkTitles));
  const kept = uniqueTitles.filter((t) => existingTitles.has(t));
  const orphaned = uniqueTitles.length - kept.length;

  let rebuilt = head;
  if (kept.length > 0) {
    rebuilt += "\n\n## Related\n";
    for (const title of kept.sort()) {
      rebuilt += `- [[${title}]]\n`;
    }
  } else {
    rebuilt += "\n";
  }

  const afterBytes = rebuilt.length;

  if (APPLY) {
    writeFileSync(path, rebuilt, "utf-8");
  }

  return {
    file: filename,
    beforeBytes,
    afterBytes,
    relatedSectionsRemoved: sectionCount,
    wikilinksExtracted: wikilinkTitles.length,
    wikilinksKept: kept.length,
    wikilinksOrphaned: orphaned,
  };
}

for (const f of files) {
  const r = cleanFile(f);
  if (r) {
    results.push(r);
    totalBytesRecovered += r.beforeBytes - r.afterBytes;
  }
}

results.sort((a, b) => b.relatedSectionsRemoved - a.relatedSectionsRemoved);

console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write changes)"}`);
console.log(`Files scanned: ${files.length}`);
console.log(`Files with Related sections: ${results.length}`);
console.log(`Total ## Related sections: ${results.reduce((s, r) => s + r.relatedSectionsRemoved, 0)}`);
console.log(`Total wikilinks extracted: ${results.reduce((s, r) => s + r.wikilinksExtracted, 0)}`);
console.log(`Kept (point to existing notes): ${results.reduce((s, r) => s + r.wikilinksKept, 0)}`);
console.log(`Orphaned (dropped): ${results.reduce((s, r) => s + r.wikilinksOrphaned, 0)}`);
console.log(`Bytes recovered: ${(totalBytesRecovered / 1024 / 1024).toFixed(1)} MB`);
console.log();
console.log("Top 10 offenders:");
for (const r of results.slice(0, 10)) {
  console.log(
    `  ${r.relatedSectionsRemoved.toString().padStart(4)} sections  ${(
      (r.beforeBytes - r.afterBytes) / 1024
    )
      .toFixed(1)
      .padStart(7)} KB recovered  kept ${r.wikilinksKept.toString().padStart(3)}  ${r.file}`,
  );
}
