#!/usr/bin/env bun
/**
 * archive-noteplan-content.ts
 *
 * One-off + repeatable ingest of PsiBot's NotePlan-pipeline markdown content
 * into the `noteplan_archive` SQLite table, so the files on disk can later be
 * pruned without losing their content.
 *
 * READ-ONLY against NotePlan in every mode EXCEPT `--delete` (which is the
 * later cleanup step and is gated separately). Ingest never modifies or deletes
 * any file under ~/Documents/NotePlan-Notes.
 *
 * Sources (only *.md files are ingested):
 *   00 - Inbox                -> inbox
 *   70 - Research/queued      -> research_queued
 *   70 - Research/completed   -> research_completed
 *   60 - Briefings            -> briefing
 *   @Trash (recursive)        -> trash
 *
 * Modes:
 *   (default)          dry-run: print the plan + counts, write nothing.
 *   --commit           perform inserts (idempotent via rel_path UNIQUE upsert).
 *   --delete           LATER cleanup step (retention prune). NOT for this run.
 *                      Supports `--delete --dry-run`. Only deletes a file whose
 *                      on-disk sha256 matches a stored noteplan_archive row.
 *
 * Dedup: research notes contain a runaway repeated "## Related" section (a
 * backlink-agent bug). We keep the FIRST "## Related" section and strip all
 * subsequent repetitions from the stored body, recording how many were removed
 * in dedup_related_removed. sha256 is the hash of the ORIGINAL raw file bytes
 * (not the cleaned body) so the later deletion step can verify against disk.
 */

import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, relative, dirname, basename } from "node:path";
import { homedir } from "node:os";

// Lazy imports so this module can be imported by a test without booting the DB.
import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import {
  insertNoteplanArchive,
  countNoteplanArchive,
} from "../src/db/queries.ts";
import type { NoteplanSourceKind } from "../src/shared/types.ts";

const NOTES_ROOT = join(homedir(), "Documents/NotePlan-Notes/Notes");

interface SourceDef {
  kind: NoteplanSourceKind;
  /** Path relative to NOTES_ROOT. */
  relDir: string;
  recursive: boolean;
}

const SOURCES: SourceDef[] = [
  { kind: "inbox", relDir: "00 - Inbox", recursive: false },
  { kind: "research_queued", relDir: "70 - Research/queued", recursive: false },
  { kind: "research_completed", relDir: "70 - Research/completed", recursive: false },
  { kind: "briefing", relDir: "60 - Briefings", recursive: false },
  { kind: "trash", relDir: "@Trash", recursive: true },
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Collapse the runaway "## Related" duplication bug. Keeps the FIRST
 * "## Related" section verbatim and drops every subsequent "## Related"
 * header (and its bullets) from the body.
 *
 * Returns the cleaned body and the number of repeated sections removed
 * (= total "## Related" headers minus the one we kept).
 */
export function collapseRelatedSections(body: string): {
  body: string;
  removed: number;
} {
  const headerRe = /^## Related[ \t]*$/gm;
  const matches = [...body.matchAll(headerRe)];
  if (matches.length <= 1) return { body, removed: 0 };

  const secondStart = matches[1].index!;
  // Everything up to (but not including) the second "## Related" header — this
  // preserves the head and the first, consolidated Related section. Trim the
  // whitespace that separated it from the repeated block, then re-terminate.
  const cleaned = body.slice(0, secondStart).replace(/\s+$/, "") + "\n";
  return { body: cleaned, removed: matches.length - 1 };
}

interface ParsedNote {
  frontmatterRaw: Record<string, unknown> | null;
  title: string | null;
  tags: string[];
  captured: string | null;
  researched: string | null;
  body: string;
}

/**
 * Split a `---\n...\n---\n` YAML frontmatter block from the body and parse it
 * tolerantly (scalars, block lists, and flow lists). Files with no frontmatter
 * (e.g. briefings) return frontmatterRaw=null and the full content as body.
 */
export function parseNote(content: string): ParsedNote {
  let frontmatterRaw: Record<string, unknown> | null = null;
  let body = content;

  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const yaml = content.slice(4, end);
      // Skip the closing fence line (\n---) and the blank line(s) after it.
      body = content.slice(end + 4).replace(/^\n+/, "");
      frontmatterRaw = parseSimpleYaml(yaml);
    }
  }

  const fm = frontmatterRaw ?? {};
  const title =
    typeof fm.title === "string" && fm.title.trim()
      ? String(fm.title).trim()
      : firstHeading(body);

  const tags = Array.isArray(fm.tags)
    ? (fm.tags as unknown[]).map((t) => String(t)).filter(Boolean)
    : [];

  const captured = scalarOrNull(fm.captured);
  const researched = scalarOrNull(fm.researched);

  return { frontmatterRaw, title, tags, captured, researched, body };
}

function scalarOrNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

/**
 * Minimal tolerant YAML parser for NotePlan frontmatter. Handles top-level
 * `key: value` scalars, block sequences (`key:` then `  - item` lines), and
 * flow sequences (`key: [a, b]`). Everything else is ignored, not thrown.
 */
export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    // A block-list item belonging to the previous key is consumed below, so a
    // leading-indent "- " line here is a stray; skip it.
    if (/^\s+-\s+/.test(raw)) continue;

    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();

    if (value === "") {
      // Possible block list on following indented "- " lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      if (items.length > 0) {
        out[key] = items;
        i = j - 1;
      } else {
        out[key] = "";
      }
    } else if (value.startsWith("[")) {
      const inner = value.replace(/^\[|\]\s*$/g, "");
      out[key] = inner.trim()
        ? inner.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : [];
    } else {
      out[key] = stripQuotes(value);
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Derive captured_at for briefings (no frontmatter) from filename date prefix. */
export function dateFromFilename(name: string): string | null {
  const m = name.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

interface FileEntry {
  absPath: string;
  relPath: string; // relative to NOTES_ROOT
  folderRel: string; // directory relative to NOTES_ROOT
}

/** Structural subset of fs.Dirent that the walks rely on. */
export interface WalkEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Injected seam so the suite can pin EPERM-skip behaviour without the live fs
 * (mirrors src/heartbeat/inbox-watcher.ts InboxScanDeps).
 */
export interface WalkDeps {
  readdir?: (dir: string, opts: { withFileTypes: true }) => WalkEntry[];
  exists?: (path: string) => boolean;
}

/** Directories skipped this run because macOS TCC denied the scandir (EPERM). */
const epermSkippedDirs: string[] = [];

function readdirEntries(dir: string, deps: WalkDeps): WalkEntry[] | null {
  const readdir = deps.readdir ?? readdirSync;
  try {
    return readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Per-dir macOS TCC (com.apple.macl) scandirs fail EPERM: skip just that
    // subtree and record it, so the sweep phase completes with a named
    // TCC-denial instead of dying hard (same check as inbox-watcher).
    if (err instanceof Error && "code" in err && err.code === "EPERM") {
      if (!epermSkippedDirs.includes(dir)) epermSkippedDirs.push(dir);
      return null;
    }
    throw err;
  }
}

/** One named line per TCC-denied directory (dir + reason); drains the list. */
export function drainEpermSkipLines(): string[] {
  return epermSkippedDirs.splice(0).map(
    (dir) =>
      `noteplan-sweep skipping NotePlan directory it cannot list (EPERM, macOS TCC): ${dir} — owner-side fix: grant Full Disk Access or re-save`,
  );
}

export function walkMd(absDir: string, recursive: boolean, deps: WalkDeps = {}): FileEntry[] {
  const out: FileEntry[] = [];
  const exists = deps.exists ?? existsSync;
  if (!exists(absDir)) return out;
  const entries = readdirEntries(absDir, deps);
  if (entries === null) return out;
  for (const e of entries) {
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...walkMd(abs, true, deps));
      continue;
    }
    if (!e.isFile() || !e.name.endsWith(".md")) continue;
    out.push({
      absPath: abs,
      relPath: relative(NOTES_ROOT, abs),
      folderRel: relative(NOTES_ROOT, dirname(abs)),
    });
  }
  return out;
}

export function walkNonMd(absDir: string, recursive: boolean, deps: WalkDeps = {}): string[] {
  const out: string[] = [];
  const exists = deps.exists ?? existsSync;
  if (!exists(absDir)) return out;
  const entries = readdirEntries(absDir, deps);
  if (entries === null) return out;
  for (const e of entries) {
    const abs = join(absDir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...walkNonMd(abs, true, deps));
      continue;
    }
    if (e.isFile() && !e.name.endsWith(".md")) out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

interface KindStats {
  kind: NoteplanSourceKind;
  mdFiles: number;
  ingested: number;
  dedupFilesAffected: number;
  dedupSectionsRemoved: number;
  bytesSaved: number;
  matchedPendingItems: number;
  nonMdFiles: string[];
}

function lookupPendingItemId(absPath: string): number | null {
  const row = getDb()
    .prepare<{ id: number }, [string]>(
      `SELECT id FROM pending_items WHERE noteplan_path = ? LIMIT 1`,
    )
    .get(absPath);
  return row?.id ?? null;
}

function runIngest(commit: boolean): KindStats[] {
  const allStats: KindStats[] = [];

  for (const src of SOURCES) {
    const absDir = join(NOTES_ROOT, src.relDir);
    const files = walkMd(absDir, src.recursive);
    const nonMd = walkNonMd(absDir, src.recursive);

    const stats: KindStats = {
      kind: src.kind,
      mdFiles: files.length,
      ingested: 0,
      dedupFilesAffected: 0,
      dedupSectionsRemoved: 0,
      bytesSaved: 0,
      matchedPendingItems: 0,
      nonMdFiles: nonMd,
    };

    for (const f of files) {
      const rawBuf = readFileSync(f.absPath);
      const rawSize = rawBuf.byteLength;
      const sha = sha256Hex(rawBuf);
      const content = rawBuf.toString("utf-8");

      const parsed = parseNote(content);
      const { body: cleanedBody, removed } = collapseRelatedSections(parsed.body);

      if (removed > 0) {
        stats.dedupFilesAffected++;
        stats.dedupSectionsRemoved += removed;
        stats.bytesSaved += Buffer.byteLength(parsed.body, "utf-8") -
          Buffer.byteLength(cleanedBody, "utf-8");
      }

      const fname = basename(f.absPath);
      const title = parsed.title ?? fname.replace(/\.md$/, "");
      const captured =
        parsed.captured ?? (src.kind === "briefing" ? dateFromFilename(fname) : null);

      const pendingItemId = lookupPendingItemId(f.absPath);
      if (pendingItemId != null) stats.matchedPendingItems++;

      const mtime = statSync(f.absPath).mtime.toISOString();

      if (commit) {
        insertNoteplanArchive({
          rel_path: f.relPath,
          folder: f.folderRel,
          source_kind: src.kind,
          title,
          frontmatter: parsed.frontmatterRaw
            ? JSON.stringify(parsed.frontmatterRaw)
            : null,
          tags: JSON.stringify(parsed.tags),
          body: cleanedBody,
          raw_size: rawSize,
          cleaned_size: Buffer.byteLength(cleanedBody, "utf-8"),
          sha256: sha,
          file_mtime: mtime,
          captured_at: captured,
          researched_at: parsed.researched,
          pending_item_id: pendingItemId,
          dedup_related_removed: removed,
        });
      }
      stats.ingested++;
    }

    allStats.push(stats);
  }

  return allStats;
}

// ---------------------------------------------------------------------------
// Delete (LATER cleanup step — retention prune). Never run during ingest.
// ---------------------------------------------------------------------------

const ZIP_ARCHIVE_DIR = join(homedir(), "Documents/40_Archive/noteplan-extracted-zips");
const DAY_MS = 24 * 60 * 60 * 1000;

function withinDays(mtimeMs: number, days: number): boolean {
  return Date.now() - mtimeMs <= days * DAY_MS;
}

interface DeletePlan {
  kind: NoteplanSourceKind | "zips";
  del: number;
  keep: number;
  skippedNoDbMatch: number;
  notes: string[];
}

function shaMatchesDb(absPath: string): boolean {
  if (!existsSync(absPath)) return false;
  const sha = sha256Hex(readFileSync(absPath));
  const relPath = relative(NOTES_ROOT, absPath);
  const row = getDb()
    .prepare<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM noteplan_archive WHERE rel_path = ? AND sha256 = ?`,
    )
    .get(relPath, sha);
  return (row?.n ?? 0) > 0;
}

function runDelete(dryRun: boolean, force: boolean): DeletePlan[] {
  const plans: DeletePlan[] = [];

  for (const src of SOURCES) {
    const absDir = join(NOTES_ROOT, src.relDir);
    const files = walkMd(absDir, src.recursive);
    const plan: DeletePlan = {
      kind: src.kind,
      del: 0,
      keep: 0,
      skippedNoDbMatch: 0,
      notes: [],
    };

    for (const f of files) {
      const st = statSync(f.absPath);
      const mtimeMs = st.mtimeMs;

      let shouldDelete: boolean;
      switch (src.kind) {
        case "inbox": {
          const pid = lookupPendingItemId(f.absPath);
          let keepForStatus = false;
          if (pid != null) {
            const row = getDb()
              .prepare<{ status: string }, [number]>(
                `SELECT status FROM pending_items WHERE id = ?`,
              )
              .get(pid);
            keepForStatus = row?.status === "pending" || row?.status === "triaged";
          }
          shouldDelete = !(keepForStatus || withinDays(mtimeMs, 14));
          break;
        }
        case "research_queued":
          shouldDelete = true;
          break;
        case "research_completed":
          shouldDelete = !withinDays(mtimeMs, 30);
          break;
        case "briefing":
          shouldDelete = !withinDays(mtimeMs, 14);
          break;
        case "trash":
          shouldDelete = true;
          break;
        default:
          shouldDelete = false;
      }

      if (!shouldDelete) {
        plan.keep++;
        continue;
      }

      // Safety: only delete a file whose content is provably in the DB.
      if (!shaMatchesDb(f.absPath)) {
        plan.skippedNoDbMatch++;
        plan.keep++;
        continue;
      }

      plan.del++;
      if (!dryRun) {
        if (force) {
          unlinkSync(f.absPath);
          plan.notes.push(`DELETED: ${f.relPath}`);
        } else {
          // Live mode requires the additional --force flag as a second gate.
          plan.notes.push(`WOULD DELETE (live mode disabled, pass --force): ${f.relPath}`);
        }
      }
    }

    plans.push(plan);
  }

  // Zips in queued/ -> MOVE to the archive dir (not deleted).
  const queuedZips = walkNonMd(join(NOTES_ROOT, "70 - Research/queued"), false).filter(
    (p) => p.endsWith(".zip"),
  );
  const zipPlan: DeletePlan = {
    kind: "zips",
    del: 0,
    keep: 0,
    skippedNoDbMatch: 0,
    notes: [],
  };
  for (const z of queuedZips) {
    zipPlan.del++;
    const dest = join(ZIP_ARCHIVE_DIR, basename(z));
    if (!dryRun && force) {
      if (!existsSync(ZIP_ARCHIVE_DIR)) mkdirSync(ZIP_ARCHIVE_DIR, { recursive: true });
      renameSync(z, dest);
      zipPlan.notes.push(`MOVED ${relative(NOTES_ROOT, z)} -> ${dest}`);
    } else {
      zipPlan.notes.push(`MOVE (plan only${!dryRun ? ", pass --force" : ""}) ${relative(NOTES_ROOT, z)} -> ${dest}`);
    }
  }
  plans.push(zipPlan);

  return plans;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const del = args.includes("--delete");
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run") || (!commit && !del);

  loadConfig();
  initDb();

  if (del) {
    const live = !dryRun && force;
    console.log(`\n=== NotePlan archive DELETE ${live ? "(LIVE — FORCE)" : dryRun ? "(DRY RUN)" : "(PLAN ONLY — pass --force to execute)"} ===`);
    console.log("Retention: inbox keep(pending/triaged|<=14d) | queued delete-all |");
    console.log("           completed keep<=30d | briefings keep<=14d | trash delete-all |");
    console.log("           queued zips MOVE -> ~/Documents/40_Archive/noteplan-extracted-zips/\n");
    const plans = runDelete(dryRun, force);
    let totalDel = 0;
    let totalKeep = 0;
    for (const p of plans) {
      totalDel += p.del;
      totalKeep += p.keep;
      const skip = p.skippedNoDbMatch > 0 ? `  (skipped ${p.skippedNoDbMatch}: no DB sha match)` : "";
      console.log(`  ${p.kind.padEnd(20)} delete ${String(p.del).padStart(4)}  keep ${String(p.keep).padStart(4)}${skip}`);
    }
    console.log(`  ${"TOTAL".padEnd(20)} delete ${String(totalDel).padStart(4)}  keep ${String(totalKeep).padStart(4)}`);
    if (!live) {
      console.log("\nNOTE: no files were touched. Run with `--delete --force` (no --dry-run) to execute.\n");
    } else {
      console.log("\nLIVE deletion complete — files unlinked, zips moved.\n");
    }
    // Tail-safe: skip lines go last so the daemon's 12-line phase tail keeps them.
    for (const line of drainEpermSkipLines()) console.log(line);
    return;
  }

  console.log(`\n=== NotePlan archive INGEST ${commit ? "(COMMIT)" : "(DRY RUN)"} ===`);
  console.log(`Notes root: ${NOTES_ROOT}\n`);

  const stats = runIngest(commit);

  let totMd = 0;
  let totIngest = 0;
  let totDedupFiles = 0;
  let totDedupSections = 0;
  let totBytes = 0;
  let totMatched = 0;

  for (const s of stats) {
    totMd += s.mdFiles;
    totIngest += s.ingested;
    totDedupFiles += s.dedupFilesAffected;
    totDedupSections += s.dedupSectionsRemoved;
    totBytes += s.bytesSaved;
    totMatched += s.matchedPendingItems;
    console.log(
      `  ${s.kind.padEnd(20)} md ${String(s.mdFiles).padStart(4)}  ` +
        `${commit ? "ingested" : "would ingest"} ${String(s.ingested).padStart(4)}  ` +
        `dedup ${String(s.dedupFilesAffected).padStart(4)} files / ${String(s.dedupSectionsRemoved).padStart(6)} secs  ` +
        `pending-matched ${String(s.matchedPendingItems).padStart(4)}`,
    );
    if (s.nonMdFiles.length > 0) {
      console.log(`      non-md (NOT ingested): ${s.nonMdFiles.length}`);
      for (const nf of s.nonMdFiles) console.log(`        - ${relative(NOTES_ROOT, nf)}`);
    }
  }

  console.log(
    `\n  ${"TOTAL".padEnd(20)} md ${String(totMd).padStart(4)}  ` +
      `${commit ? "ingested" : "would ingest"} ${String(totIngest).padStart(4)}  ` +
      `dedup ${totDedupFiles} files / ${totDedupSections} secs  ` +
      `saved ${(totBytes / 1024 / 1024).toFixed(1)} MB  pending-matched ${totMatched}`,
  );

  if (commit) {
    console.log(`\n  noteplan_archive rows now: ${countNoteplanArchive()}`);
    for (const src of SOURCES) {
      console.log(`    ${src.kind.padEnd(20)} ${countNoteplanArchive(src.kind)}`);
    }
  }
  // Tail-safe: skip lines go last so the daemon's 12-line phase tail keeps them.
  for (const line of drainEpermSkipLines()) console.log(line);
  console.log();
}

if (import.meta.main) {
  main();
}
