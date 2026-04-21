#!/usr/bin/env bun
/**
 * Recover missing research notes from Claude Agent SDK session files.
 *
 * Scans ~/.claude session JSONL files for research results that match
 * pending_items with deep_research_done but no valid noteplan_path.
 * Creates NotePlan notes in the completed/ folder.
 *
 * Usage: bun run scripts/recover-research.ts [--dry-run]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import Database from "bun:sqlite";

const DRY_RUN = process.argv.includes("--dry-run");
const DB_PATH = join(import.meta.dir, "../data/app.db");
const NOTEPLAN_BASE = join(homedir(), "Documents/NotePlan-Notes/Notes");
const COMPLETED_DIR = join(NOTEPLAN_BASE, "70 - Research/completed");
const SESSION_DIR = join(
  homedir(),
  ".claude/projects/-Users-davidmcgregor-Documents-2-Code-2026-telegram-claude-code"
);

interface PendingItem {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  source: string;
  platform: string | null;
  priority: number | null;
  triage_summary: string | null;
  auto_decision: string | null;
  noteplan_path: string | null;
}

interface ResearchResult {
  title: string;
  summary: string;
  keyFindings: string[];
  relevance: string;
  suggestedActions: string[];
  sources: string[];
}

// --- DB ---

const db = new Database(DB_PATH);

function getMissingItems(): PendingItem[] {
  return db
    .prepare<PendingItem, []>(
      `SELECT * FROM pending_items
       WHERE auto_decision = 'deep_research_done'
       AND (noteplan_path IS NULL OR noteplan_path LIKE '%....md')`
    )
    .all();
}

function updateNoteplanPath(id: number, path: string): void {
  db.prepare("UPDATE pending_items SET noteplan_path = ? WHERE id = ?").run(
    path,
    id
  );
}

// --- JSON extraction ---

function extractJson<T>(text: string): T | null {
  // Try code block first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }

  // Find balanced braces
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1) {
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (char === "\\") {
        escapeNext = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") braceCount++;
      else if (char === "}") {
        braceCount--;
        if (braceCount === 0) {
          try {
            return JSON.parse(text.slice(firstBrace, i + 1)) as T;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// --- NotePlan ---

function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\n\r]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function buildNotePlanContent(
  item: PendingItem,
  research: ResearchResult
): string {
  const today = new Date().toISOString().split("T")[0];
  const title = research.title || item.title || "Untitled Research";
  const tags = ["research", "recovered"];
  if (item.platform) tags.push(item.platform);
  const tagsYaml = tags.map((t) => `  - ${t}`).join("\n");

  return `---
title: ${title.replace(/:/g, " -")}
url: ${item.url}
source: ${item.source}
researched: ${today}
priority: ${item.priority ?? 3}
tags:
${tagsYaml}
---

# ${title}

## Summary
${research.summary}

## Key Findings
${research.keyFindings.map((f) => `- ${f}`).join("\n")}

## Relevance
${research.relevance}

## Suggested Actions
${research.suggestedActions.map((a) => `- ${a}`).join("\n")}

## Sources
${research.sources.map((s) => `- ${s}`).join("\n")}

---
*Research recovered from session files by PsiBot on ${today}*
`;
}

// --- Session scanner ---

function scanSessionsForUrl(url: string): ResearchResult | null {
  const sessionFiles = readdirSync(SESSION_DIR).filter((f) =>
    f.endsWith(".jsonl")
  );

  for (const file of sessionFiles) {
    const filePath = join(SESSION_DIR, file);
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    if (!content.includes(url)) continue;

    // Parse JSONL — only look at ASSISTANT messages that contain JSON results
    const lines = content.split("\n").filter(Boolean);

    // Track whether the prompt mentioned this URL (to know this is the right session)
    let isResearchSession = false;

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        const role = msg?.message?.role;
        const msgContent = msg?.message?.content;

        if (!Array.isArray(msgContent)) continue;

        // Check if this is a user/system prompt containing the research URL
        if (role === "user") {
          for (const block of msgContent) {
            if (
              block?.type === "text" &&
              block.text.includes(url) &&
              block.text.includes("Research the following")
            ) {
              isResearchSession = true;
            }
          }
          continue;
        }

        // Only process assistant messages in confirmed research sessions
        if (role !== "assistant" || !isResearchSession) continue;

        for (const block of msgContent) {
          if (block?.type !== "text") continue;
          const text = block.text as string;

          // Must contain actual JSON with research fields — not just mentions in prompt text
          // Look for JSON objects with these keys as actual JSON keys
          if (!text.includes("{")) continue;

          const parsed = extractJson<{
            title?: string;
            summary?: string;
            keyFindings?: string[];
            key_findings?: string[];
            relevance?: string;
            suggestedActions?: string[];
            suggested_actions?: string[];
            sources?: string[];
          }>(text);

          if (parsed && parsed.summary && parsed.summary.length > 20) {
            return {
              title: parsed.title || "",
              summary: parsed.summary,
              keyFindings: parsed.keyFindings ?? parsed.key_findings ?? [],
              relevance: parsed.relevance ?? "",
              suggestedActions:
                parsed.suggestedActions ?? parsed.suggested_actions ?? [],
              sources: parsed.sources ?? [url],
            };
          }
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

// --- Main ---

async function main() {
  const items = getMissingItems();
  console.log(
    `Found ${items.length} items needing recovery`
  );
  console.log(DRY_RUN ? "(DRY RUN)\n" : "");

  if (!existsSync(COMPLETED_DIR)) {
    mkdirSync(COMPLETED_DIR, { recursive: true });
  }

  let recovered = 0;
  let notFound = 0;
  const notFoundItems: PendingItem[] = [];

  for (const item of items) {
    const shortTitle = (item.title ?? item.url).slice(0, 60);
    process.stdout.write(`[${item.id}] ${shortTitle}... `);

    const research = scanSessionsForUrl(item.url);

    if (research) {
      // Use research title, fall back to item title
      const noteTitle =
        research.title || item.title || `Research ${item.id}`;
      const sanitized = sanitizeFilename(noteTitle);

      if (sanitized.length < 5) {
        // Fallback for titles that sanitize too aggressively
        const fallback = sanitizeFilename(
          item.title ?? `Research item ${item.id}`
        );
        const fileName =
          fallback.length >= 5 ? fallback : `Research-${item.id}`;
        const filePath = join(COMPLETED_DIR, `${fileName}.md`);

        if (DRY_RUN) {
          console.log(`WOULD CREATE: ${basename(filePath)}`);
        } else {
          writeFileSync(
            filePath,
            buildNotePlanContent(item, {
              ...research,
              title: noteTitle || item.title || "Untitled",
            }),
            "utf-8"
          );
          updateNoteplanPath(item.id, filePath);
          console.log(`RECOVERED -> ${basename(filePath)}`);
        }
      } else {
        const filePath = join(COMPLETED_DIR, `${sanitized}.md`);

        if (DRY_RUN) {
          console.log(`WOULD CREATE: ${basename(filePath)}`);
        } else {
          writeFileSync(
            filePath,
            buildNotePlanContent(item, research),
            "utf-8"
          );
          updateNoteplanPath(item.id, filePath);
          console.log(`RECOVERED -> ${basename(filePath)}`);
        }
      }
      recovered++;
    } else {
      console.log("NOT FOUND");
      notFound++;
      notFoundItems.push(item);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Recovered: ${recovered}`);
  console.log(`Not found: ${notFound}`);

  if (notFoundItems.length > 0) {
    console.log(`\nItems needing re-research:`);
    for (const item of notFoundItems) {
      console.log(
        `  [${item.id}] ${(item.title ?? item.url).slice(0, 80)}`
      );
    }
  }

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
