#!/usr/bin/env bun
/**
 * One-time cleanup: Move auto-generated triage stub files from 30 - Resources
 * to NotePlan @Trash, and reset their pending_items records to "pending"
 * so they get re-triaged with the improved content extraction.
 *
 * Only touches flat files in the root — subdirectories (curated content) are left alone.
 */

import { readFileSync, readdirSync, renameSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import Database from "bun:sqlite";

const NOTEPLAN_NOTES = join(process.env.HOME ?? "/tmp", "Documents/NotePlan-Notes/Notes");
const RESOURCES_DIR = join(NOTEPLAN_NOTES, "30 - Resources");
const TRASH_DIR = join(NOTEPLAN_NOTES, "@Trash/30 - Resources");
const DB_PATH = join(import.meta.dir, "../data/app.db");

// Ensure trash directory exists
if (!existsSync(TRASH_DIR)) {
  mkdirSync(TRASH_DIR, { recursive: true });
}

// Open DB
const db = new Database(DB_PATH);

// Get all flat .md files (not in subdirectories)
const files = readdirSync(RESOURCES_DIR)
  .filter((f) => f.endsWith(".md"))
  .filter((f) => {
    const fullPath = join(RESOURCES_DIR, f);
    return statSync(fullPath).isFile();
  });

console.log(`Found ${files.length} flat stub files to process\n`);

let moved = 0;
let resetInDb = 0;
let urlsNotInDb: string[] = [];

for (const file of files) {
  const filePath = join(RESOURCES_DIR, file);
  const content = readFileSync(filePath, "utf-8");

  // Extract URL from frontmatter
  const urlMatch = content.match(/^url:\s*(.+)$/m);
  const url = urlMatch?.[1]?.trim();

  if (url) {
    // Reset pending_items record to "pending" status
    const result = db
      .prepare(
        `UPDATE pending_items SET status = 'pending', priority = NULL, category = NULL, triage_summary = NULL, noteplan_path = NULL WHERE url = ?`
      )
      .run(url);

    if (result.changes > 0) {
      resetInDb++;
    } else {
      urlsNotInDb.push(url);
    }
  }

  // Move to trash
  const trashPath = join(TRASH_DIR, file);
  try {
    renameSync(filePath, trashPath);
    moved++;
  } catch (err) {
    console.error(`Failed to move: ${basename(file)} — ${err}`);
  }
}

db.close();

console.log(`Moved ${moved} files to @Trash/30 - Resources`);
console.log(`Reset ${resetInDb} pending_items records to "pending"`);
if (urlsNotInDb.length > 0) {
  console.log(`\n${urlsNotInDb.length} URLs not found in pending_items (may need manual re-capture):`);
  for (const url of urlsNotInDb.slice(0, 10)) {
    console.log(`  - ${url}`);
  }
  if (urlsNotInDb.length > 10) {
    console.log(`  ... and ${urlsNotInDb.length - 10} more`);
  }
}
