import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { syncAtlasForScan } from "../src/atlas/sync.ts";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

loadConfig();
initDb();

const SCAN_DIR = resolve(process.cwd(), "knowledge/trading/scans");
const BODY_MAX = 3000;

const TITLE_LINE_RE = /^#\s+(.+)$/m;

let indexed = 0;
try {
  const files = readdirSync(SCAN_DIR, { withFileTypes: true });
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    if (entry.name === ".gitkeep") continue;
    const filePath = join(SCAN_DIR, entry.name);
    const stat = statSync(filePath);
    const content = readFileSync(filePath, "utf-8");

    const match = TITLE_LINE_RE.exec(content);
    const title = match ? match[1].trim() : entry.name.replace(/\.md$/, "");

    syncAtlasForScan({
      filePath: `knowledge/trading/scans/${entry.name}`,
      title,
      body: content.slice(0, BODY_MAX),
      capturedAt: stat.mtime.toISOString(),
    });
    indexed++;
  }
} catch (err) {
  console.error("Scan backfill failed:", (err as Error).message);
  process.exit(1);
}

console.log(`Indexed ${indexed} scan files from ${SCAN_DIR}`);
