import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { upsertMemoryEntry, searchMemory } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("memory");

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

function safePath(filePath: string): string {
  const resolved = resolve(KNOWLEDGE_DIR, filePath);
  if (!resolved.startsWith(KNOWLEDGE_DIR)) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return resolved;
}

export class MemorySystem {
  private memoryPath: string;

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

  indexAll(): void {
    const files = this.listKnowledgeFiles();
    for (const file of files) {
      this.indexFile(file);
    }
    log.info("Indexed all knowledge files", { count: files.length });
  }

  private indexFile(filePath: string): void {
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
}
