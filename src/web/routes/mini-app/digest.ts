import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import {
  tmaDigestListPage,
  tmaDigestFileViewPage,
  type DigestFile,
} from "../../views/mini-app/digest.ts";
import { errorState, escapeHtml } from "../../views/mini-app/components.ts";
import { miniAppLayout } from "../../views/mini-app/shell.ts";
import { type MiniAppEnv } from "./shared.ts";

const KNOWLEDGE_DIR = pathResolve(process.cwd(), "knowledge");
const DIGESTS_DIR = pathJoin(KNOWLEDGE_DIR, "digests");

/** Only accept the ISO-week filename shape, e.g. 2026-W27. */
const WEEK_RE = /^\d{4}-W\d{2}$/;

function listDigestFiles(): DigestFile[] {
  const files: DigestFile[] = [];
  if (!existsSync(DIGESTS_DIR)) return files;
  for (const entry of readdirSync(DIGESTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const week = entry.replace(/\.md$/, "");
    const full = pathJoin(DIGESTS_DIR, entry);
    files.push({
      week,
      path: `knowledge/digests/${entry}`,
      mtime: statSync(full).mtimeMs,
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function readDigest(week: string): string | null {
  if (!WEEK_RE.test(week)) return null;
  const full = pathJoin(DIGESTS_DIR, `${week}.md`);
  // Confinement check — the week regex already blocks traversal, but keep the
  // same defensive prefix check the synthesis reader uses.
  if (!full.startsWith(DIGESTS_DIR + "/")) return null;
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf-8");
}

export function registerDigestRoutes(app: Hono<MiniAppEnv>): void {
  // List page — archived digests newest-first.
  app.get("/digest", (c) => {
    try {
      const files = listDigestFiles();
      return c.html(tmaDigestListPage({ files }));
    } catch (err) {
      return c.html(
        miniAppLayout(
          "digest",
          errorState(`Failed to load digests: ${escapeHtml(String(err))}`),
          false,
        ),
      );
    }
  });

  // Single digest view.
  app.get("/digest/:week", (c) => {
    try {
      const week = c.req.param("week");
      if (!WEEK_RE.test(week)) return c.text("Bad week", 400);
      const content = readDigest(week);
      if (content === null) return c.text("Digest not found", 404);
      const full = pathJoin(DIGESTS_DIR, `${week}.md`);
      const mtime = existsSync(full) ? statSync(full).mtimeMs : Date.now();
      return c.html(
        tmaDigestFileViewPage({
          file: { week, path: `knowledge/digests/${week}.md`, mtime },
          content,
        }),
      );
    } catch (err) {
      return c.html(
        miniAppLayout(
          "digest",
          errorState(`Failed to load digest: ${escapeHtml(String(err))}`),
          false,
        ),
      );
    }
  });
}
