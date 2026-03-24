import { readdirSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("research:knowledge-linker");
const RESEARCH_DIR = join(homedir(), "Documents/NotePlan-Notes/Notes/70 - Research");

interface LinkResult {
  linkedNotes: string[];
  wikilinks: string[];
}

/**
 * Search existing research notes for related topics and add bidirectional wikilinks.
 */
export function linkToExistingResearch(
  newNoteTitle: string,
  newNotePath: string,
  keywords: string[]
): LinkResult {
  const linkedNotes: string[] = [];
  const wikilinks: string[] = [];

  if (!existsSync(RESEARCH_DIR)) return { linkedNotes, wikilinks };

  // Recursively find all .md files in research directory
  const researchFiles = findMarkdownFiles(RESEARCH_DIR);

  for (const filePath of researchFiles) {
    if (filePath === newNotePath) continue;

    const content = readFileSync(filePath, "utf-8");
    const fileName = filePath.split("/").pop()?.replace(".md", "") ?? "";

    // Check if any keywords appear in the existing note
    const contentLower = content.toLowerCase();
    const matchedKeywords = keywords.filter((kw) =>
      contentLower.includes(kw.toLowerCase())
    );

    if (matchedKeywords.length >= 2) {
      // Add backlink to existing note
      const backlinkSection = `\n\n## Related\n- [[${newNoteTitle}]]`;
      if (!content.includes(`[[${newNoteTitle}]]`)) {
        try {
          appendFileSync(filePath, backlinkSection, "utf-8");
          linkedNotes.push(fileName);
          log.info("Added backlink", { to: fileName, from: newNoteTitle });
        } catch (err) {
          log.warn("Failed to add backlink", { file: filePath, error: String(err) });
        }
      }

      // Collect wikilink for the new note
      wikilinks.push(`[[${fileName}]]`);
    }
  }

  return { linkedNotes, wikilinks };
}

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findMarkdownFiles(fullPath));
      } else if (entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }
  return results;
}
