import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { getDb } from "../db/index.ts";
import { upsertMemoryEntry, searchMemory, deleteMemoryEntry } from "../db/queries.ts";
import { syncAtlasForDailyLog } from "../atlas/sync.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("memory");

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

/**
 * Concept boundary (2026-07-02 knowledge architecture cleanup):
 * Memory (`memory_entries` FTS) is scoped to AGENT-CONTEXT files only —
 * who the agent is and what it knows about you. Everything else the agent
 * captures or produces (daily logs, research notes, trading knowledge,
 * weekly rollups, digests, scan archives, ad-hoc project notes) is content,
 * not context — it stays on disk and is indexed exclusively by Atlas
 * (src/atlas/), surfaced via `atlas_search` / TMA Library.
 *
 * Included:
 *   - Root-level agent-context files: IDENTITY.md, USER.md, TOOLS.md,
 *     HEARTBEAT.md, memory.md
 *   - Per-agent memory dirs: agents/<slug>/*.md (subagent working memory)
 *
 * Explicitly excluded (indexed by Atlas instead, or not indexed at all):
 *   - memory/ (daily logs -> synced to atlas_items kind=daily_log)
 *   - research/, trading/, weekly/, digests/, scans/ and any other
 *     root-level content dirs or misc *.md files not in MEMORY_INCLUDE_FILES
 */
const MEMORY_INCLUDE_ROOT_FILES = ["IDENTITY.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "memory.md"];
const MEMORY_INCLUDE_AGENT_DIR_PREFIX = "agents/";

/** True if `filePath` (relative to knowledge/) is in-scope for the memory index. */
function isMemoryScopedFile(filePath: string): boolean {
  if (MEMORY_INCLUDE_ROOT_FILES.includes(filePath)) return true;
  if (filePath.startsWith(MEMORY_INCLUDE_AGENT_DIR_PREFIX) && filePath.endsWith(".md")) return true;
  return false;
}

function safePath(filePath: string): string {
  const resolved = resolve(KNOWLEDGE_DIR, filePath);
  if (!resolved.startsWith(KNOWLEDGE_DIR)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

export class MemorySystem {
  private memoryPath: string;
  private agentWriteLocks = new Map<string, Promise<void>>();

  constructor() {
    this.memoryPath = join(KNOWLEDGE_DIR, "memory.md");
  }

  readMemory(): string {
    try {
      return readFileSync(this.memoryPath, "utf-8");
    } catch {
      return "";
    }
  }

  writeSection(section: string, content: string): void {
    const current = this.readMemory();
    const heading = `## ${section}`;
    const lines = current.split("\n");
    const sectionStart = lines.findIndex((l) => l.trim() === heading);

    if (sectionStart === -1) {
      const newContent = `${current.trimEnd()}\n\n${heading}\n\n${content}\n`;
      writeFileSync(this.memoryPath, newContent);
    } else {
      let sectionEnd = lines.length;
      for (let i = sectionStart + 1; i < lines.length; i++) {
        if (lines[i].startsWith("## ")) {
          sectionEnd = i;
          break;
        }
      }
      const before = lines.slice(0, sectionStart + 1);
      const after = lines.slice(sectionEnd);
      const newLines = [...before, "", content, "", ...after];
      writeFileSync(this.memoryPath, newLines.join("\n"));
    }

    this.indexFile("memory.md");
    log.info("Updated memory section", { section });
  }

  appendToSection(section: string, content: string): void {
    const current = this.readMemory();
    const heading = `## ${section}`;
    const lines = current.split("\n");
    const sectionStart = lines.findIndex((l) => l.trim() === heading);

    if (sectionStart === -1) {
      this.writeSection(section, content);
      return;
    }

    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) {
        sectionEnd = i;
        break;
      }
    }

    const before = lines.slice(0, sectionEnd);
    const after = lines.slice(sectionEnd);
    const newLines = [...before, content, ...after];
    writeFileSync(this.memoryPath, newLines.join("\n"));
    this.indexFile("memory.md");
  }

  readKnowledgeFile(filePath: string): string {
    const fullPath = safePath(filePath);
    return readFileSync(fullPath, "utf-8");
  }

  readKnowledgeFileOptional(filePath: string): string | null {
    try {
      return this.readKnowledgeFile(filePath);
    } catch {
      return null;
    }
  }

  appendDailyLog(content: string): void {
    const memoryDir = join(KNOWLEDGE_DIR, "memory");
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }
    const date = new Date().toISOString().split("T")[0];
    const logPath = join(memoryDir, `${date}.md`);
    const existing = existsSync(logPath) ? readFileSync(logPath, "utf-8") : `# Daily Log - ${date}\n\n`;
    const updated = `${existing.trimEnd()}\n\n${content}\n`;
    writeFileSync(logPath, updated);
    // Daily logs are content, not agent-context — Atlas is their only index
    // (see MEMORY_INCLUDE_* above). No memory_entries indexing here.
    syncAtlasForDailyLog({
      filePath: `memory/${date}.md`,
      content: updated,
      capturedAt: new Date().toISOString(),
    });
    log.info("Appended daily log", { date });
  }

  writeKnowledgeFile(filePath: string, content: string): void {
    const fullPath = safePath(filePath);
    writeFileSync(fullPath, content);
    this.indexFile(filePath);
    log.info("Wrote knowledge file", { filePath });
  }

  listKnowledgeFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(join(dir, entry.name));
        } else if (entry.name.endsWith(".md")) {
          files.push(relative(KNOWLEDGE_DIR, join(dir, entry.name)));
        }
      }
    };
    walk(KNOWLEDGE_DIR);
    return files;
  }

  search(query: string): Array<{ path: string; title: string; snippet: string }> {
    const dbResults = searchMemory(query);
    return dbResults.map((r) => {
      const lines = r.content.split("\n");
      const matchLine = lines.find((l) =>
        l.toLowerCase().includes(query.toLowerCase())
      );
      return {
        path: r.file_path,
        title: r.title,
        snippet: matchLine ?? lines.slice(0, 3).join(" ").slice(0, 200),
      };
    });
  }

  /**
   * Index the agent-context file set (see MEMORY_INCLUDE_* above) and purge
   * any previously-indexed out-of-scope rows. The purge is idempotent — safe
   * to run on every startup — and is how existing installs (indexed before
   * this scoping rule existed) get cleaned up without a manual migration.
   */
  indexAll(): void {
    const files = this.listKnowledgeFiles().filter(isMemoryScopedFile);
    for (const file of files) {
      this.indexFile(file);
    }
    const removed = this.purgeOutOfScopeEntries();
    log.info("Indexed agent-context knowledge files", { count: files.length, purged: removed });
  }

  /**
   * One-time (per-startup) cleanup: delete any memory_entries row whose
   * file_path is no longer in scope per isMemoryScopedFile(). Idempotent.
   */
  private purgeOutOfScopeEntries(): number {
    const db = getDb();
    const rows = db.prepare<{ file_path: string }, []>(`SELECT file_path FROM memory_entries`).all();
    let removed = 0;
    for (const row of rows) {
      if (!isMemoryScopedFile(row.file_path)) {
        deleteMemoryEntry(row.file_path);
        removed++;
      }
    }
    return removed;
  }

  private indexFile(filePath: string): void {
    if (!isMemoryScopedFile(filePath)) {
      // Expected for knowledge_write targeting content dirs (research/,
      // trading/, etc.) — those files stay on disk, indexed by Atlas only.
      log.info("Skipping memory index for out-of-scope file", { filePath });
      return;
    }
    try {
      const fullPath = safePath(filePath);
      const content = readFileSync(fullPath, "utf-8");
      const firstLine = content.split("\n").find((l) => l.startsWith("# "));
      const title = firstLine?.replace(/^#+\s*/, "") ?? filePath;
      upsertMemoryEntry({ file_path: filePath, title, content });
    } catch (err) {
      log.error("Failed to index file", {
        filePath,
        error: String(err),
      });
    }
  }

  // --- Per-agent memory (Phase 2 of orchestration framework) ---

  /** Compose a memory_dir + file into a guarded path under the agent's own dir. */
  private agentMemoryPath(memoryDir: string, file: string): string {
    if (!memoryDir) throw new Error("memoryDir required");
    if (!file) throw new Error("file required");
    const dirResolved = safePath(memoryDir);
    const fullResolved = safePath(join(memoryDir, file));
    if (!fullResolved.startsWith(dirResolved + "/") && fullResolved !== dirResolved) {
      throw new Error(`Path escapes agent memory dir: ${file}`);
    }
    return fullResolved;
  }

  readAgentMemory(memoryDir: string, file: string): string {
    const fullPath = this.agentMemoryPath(memoryDir, file);
    return readFileSync(fullPath, "utf-8");
  }

  readAgentMemoryOptional(memoryDir: string, file: string): string | null {
    try {
      return this.readAgentMemory(memoryDir, file);
    } catch {
      return null;
    }
  }

  listAgentMemoryFiles(memoryDir: string): string[] {
    const dir = safePath(memoryDir);
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Per-slug write serialization so two concurrent jobs targeting the same
   * agent never trample each other's appends or clobber full writes.
   */
  private async withAgentLock(slug: string, fn: () => void): Promise<void> {
    const prev = this.agentWriteLocks.get(slug) ?? Promise.resolve();
    let done!: () => void;
    const next = new Promise<void>((resolve) => {
      done = resolve;
    });
    this.agentWriteLocks.set(slug, prev.then(() => next));
    try {
      await prev;
      fn();
    } finally {
      done();
      if (this.agentWriteLocks.get(slug) === prev.then(() => next)) {
        this.agentWriteLocks.delete(slug);
      }
    }
  }

  async writeAgentMemory(
    slug: string,
    memoryDir: string,
    file: string,
    content: string,
  ): Promise<void> {
    await this.withAgentLock(slug, () => {
      const fullPath = this.agentMemoryPath(memoryDir, file);
      const parent = safePath(memoryDir);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      writeFileSync(fullPath, content);
      this.indexFile(join(memoryDir, file));
      log.info("Wrote agent memory", { slug, file });
    });
  }

  async appendAgentMemory(
    slug: string,
    memoryDir: string,
    file: string,
    content: string,
  ): Promise<void> {
    await this.withAgentLock(slug, () => {
      const fullPath = this.agentMemoryPath(memoryDir, file);
      const parent = safePath(memoryDir);
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      const existing = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : "";
      const separator = existing && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(fullPath, `${existing}${separator}${content}\n`);
      this.indexFile(join(memoryDir, file));
      log.info("Appended agent memory", { slug, file });
    });
  }

  async deleteAgentMemory(
    slug: string,
    memoryDir: string,
    file: string,
  ): Promise<void> {
    await this.withAgentLock(slug, () => {
      const fullPath = this.agentMemoryPath(memoryDir, file);
      if (existsSync(fullPath)) unlinkSync(fullPath);
      deleteMemoryEntry(join(memoryDir, file));
      log.info("Deleted agent memory", { slug, file });
    });
  }
}
