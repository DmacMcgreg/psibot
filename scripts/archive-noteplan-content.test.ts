import { describe, it, expect } from "bun:test";
import {
  collapseRelatedSections,
  parseNote,
  parseSimpleYaml,
  dateFromFilename,
  walkMd,
  walkNonMd,
  drainEpermSkipLines,
  type WalkEntry,
} from "./archive-noteplan-content.ts";

describe("collapseRelatedSections", () => {
  it("returns body unchanged when there is no Related section", () => {
    const body = "# Title\n\nSome content.\n";
    const r = collapseRelatedSections(body);
    expect(r.removed).toBe(0);
    expect(r.body).toBe(body);
  });

  it("returns body unchanged when there is exactly one Related section", () => {
    const body =
      "# Title\n\nContent.\n\n## Related\n- [[Note A]]\n- [[Note B]]\n";
    const r = collapseRelatedSections(body);
    expect(r.removed).toBe(0);
    expect(r.body).toBe(body);
  });

  it("keeps the first Related section and strips the runaway repeats", () => {
    // Synthetic bloated fixture: one real consolidated Related list followed by
    // many single-bullet repeated "## Related" sections (the backlink-bug shape).
    const head = "# Big Note\n\n## Summary\nStuff.\n\n";
    const firstRelated =
      "## Related\n- [[Real One]]\n- [[Real Two]]\n- [[Real Three]]\n";
    const repeats = Array.from(
      { length: 1000 },
      (_, i) => `\n## Related\n- [[Dupe ${i}]]\n`,
    ).join("");

    const body = head + firstRelated + repeats;
    const r = collapseRelatedSections(body);

    // 1 kept + 1000 repeats = 1001 headers total, 1000 removed.
    expect(r.removed).toBe(1000);
    // First section preserved verbatim.
    expect(r.body).toContain("- [[Real One]]");
    expect(r.body).toContain("- [[Real Three]]");
    // Exactly one "## Related" header remains.
    expect((r.body.match(/^## Related[ \t]*$/gm) || []).length).toBe(1);
    // No repeated bullets leaked through.
    expect(r.body).not.toContain("[[Dupe 0]]");
    expect(r.body).not.toContain("[[Dupe 999]]");
    // Substantial byte reduction.
    expect(r.body.length).toBeLessThan(body.length / 10);
  });

  it("collapses two adjacent Related headers to one", () => {
    const body = "x\n\n## Related\n- [[A]]\n\n## Related\n- [[A]]\n";
    const r = collapseRelatedSections(body);
    expect(r.removed).toBe(1);
    expect((r.body.match(/^## Related[ \t]*$/gm) || []).length).toBe(1);
  });
});

describe("parseNote", () => {
  it("parses frontmatter, tags, captured and body", () => {
    const content = [
      "---",
      'title: "AndyMik90/Aperant: Autonomous multi-session AI coding"',
      "url: https://github.com/AndyMik90/Aperant",
      "source: github",
      "captured: 2025-12-19T18:11:41.000Z",
      "priority: 2",
      "tags:",
      "  - inbox-capture",
      "  - github",
      "  - action/research",
      "---",
      "",
      "# Heading",
      "",
      "Body text.",
      "",
    ].join("\n");

    const p = parseNote(content);
    expect(p.title).toBe("AndyMik90/Aperant: Autonomous multi-session AI coding");
    expect(p.tags).toEqual(["inbox-capture", "github", "action/research"]);
    expect(p.captured).toBe("2025-12-19T18:11:41.000Z");
    expect(p.researched).toBeNull();
    expect(p.body.startsWith("# Heading")).toBe(true);
    expect(p.frontmatterRaw?.priority).toBe("2");
  });

  it("handles notes with no frontmatter (briefings)", () => {
    const content = "# Morning Brief - Monday\n\n## MARKETS\nData.\n";
    const p = parseNote(content);
    expect(p.frontmatterRaw).toBeNull();
    expect(p.title).toBe("Morning Brief - Monday");
    expect(p.tags).toEqual([]);
    expect(p.body).toBe(content);
  });

  it("reads researched date on completed-report frontmatter", () => {
    const content = [
      "---",
      "title: Some Report",
      "researched: 2026-04-22",
      "tags: [research, github]",
      "---",
      "",
      "# Some Report",
    ].join("\n");
    const p = parseNote(content);
    expect(p.researched).toBe("2026-04-22");
    expect(p.tags).toEqual(["research", "github"]);
  });
});

describe("parseSimpleYaml", () => {
  it("parses flow-list tags", () => {
    const y = parseSimpleYaml('tags: [research, "x.com"]\npriority: 1');
    expect(y.tags).toEqual(["research", "x.com"]);
    expect(y.priority).toBe("1");
  });
});

describe("dateFromFilename", () => {
  it("extracts the YYYY-MM-DD prefix", () => {
    expect(dateFromFilename("2026-07-05-nightly-brief.md")).toBe("2026-07-05");
    expect(dateFromFilename("no-date-here.md")).toBeNull();
  });
});

describe("walkMd/walkNonMd EPERM scandir skip", () => {
  const entry = (name: string, kind: "dir" | "file"): WalkEntry => ({
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
  });

  /** The live error class: EPERM on scandir of a TCC-denied directory. */
  const epermScandir = (dir: string): Error =>
    Object.assign(new Error(`EPERM: operation not permitted, scandir '${dir}'`), {
      code: "EPERM",
    });

  it("skips an EPERM-denied child dir, walks siblings, and emits one named skip line", () => {
    const root = "/nptest/root";
    const denied = `${root}/denied`;
    const good = `${root}/good`;
    const readdir = (dir: string): WalkEntry[] => {
      if (dir === denied) throw epermScandir(dir);
      if (dir === good) return [entry("b.md", "file")];
      return [entry("good", "dir"), entry("denied", "dir"), entry("a.md", "file")];
    };
    const deps = { readdir, exists: () => true };

    const files = walkMd(root, true, deps);

    expect(files.map((f) => f.absPath).sort()).toEqual([
      `${root}/a.md`,
      `${root}/good/b.md`,
    ]);
    const lines = drainEpermSkipLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(denied);
    expect(lines[0]).toContain("EPERM");
    expect(lines[0]).toContain("TCC");
  });

  it("skips the whole source when the top-level scandir is EPERM (live error class)", () => {
    const root = "/Users/x/Documents/NotePlan-Notes/Notes/00 - Inbox";
    const readdir = (dir: string): WalkEntry[] => {
      throw epermScandir(dir);
    };

    const files = walkMd(root, true, { readdir, exists: () => true });

    expect(files).toEqual([]);
    const lines = drainEpermSkipLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("00 - Inbox");
  });

  it("walkNonMd skips the same denied dir without a second skip line", () => {
    const root = "/nptest/root2";
    const readdir = (dir: string): WalkEntry[] => {
      throw epermScandir(dir);
    };
    const deps = { readdir, exists: () => true };

    walkMd(root, true, deps);
    walkNonMd(root, true, deps);

    expect(drainEpermSkipLines()).toHaveLength(1);
  });

  it("still throws for non-EPERM readdir failures", () => {
    const readdir = (): WalkEntry[] => {
      throw Object.assign(new Error("EACCES: permission denied, scandir '/x'"), {
        code: "EACCES",
      });
    };

    expect(() => walkMd("/nptest/root3", true, { readdir, exists: () => true })).toThrow(
      "EACCES",
    );
  });
});
