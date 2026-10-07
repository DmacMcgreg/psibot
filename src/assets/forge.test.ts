import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { SkillForgeRunner, forgeSummary, splitEntries, newSkillTracks } from "./forge.ts";
import { setHomesForTesting, resetHomes, HOMES } from "./homes.ts";
import type { AskOptions } from "./llm.ts";

let db: Database;
let root: string;
const SKILL = "---\nname: drone\n---\n# drone\nFly low.\n";
const entry = (d: string, t: string, lvl = "##") => `${lvl} ${d} · ${t} <!-- asset:1 -->\n\nDo the thing.\n\n1. step\n\n- Source: [x](https://x.y)\n`;

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
  root = realpathSync(mkdtempSync(join(tmpdir(), "forge-")));
  setHomesForTesting({
    hubSkillsDir: join(root, "hub"), hubManagedManifest: join(root, "none.json"), designKitSkillsDir: join(root, "dk"),
    agentsSkillsDir: join(root, "agents"), claudeSkillsDir: join(root, "claude"), forgeDir: join(root, "forge"),
  });
  mkdirSync(join(root, "agents/drone/references"), { recursive: true });
  writeFileSync(join(root, "agents/drone/SKILL.md"), SKILL);
  writeFileSync(join(root, "agents/drone/references/field-notes.md"), `# Field notes: drone\n\n${entry("2026-09-20", "Low pass")}\n${entry("2026-09-21", "Reveal")}`);
});

afterAll(() => {
  resetHomes();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("parsing", () => {
  it("splits entries and new-skill tracks", () => {
    expect(splitEntries(`# h\n\n${entry("2026-01-01", "a")}\n${entry("2026-01-02", "b")}`, 2)).toHaveLength(2);
    const t = newSkillTracks(`# x\n\n## track: social\n\n${entry("2026-01-01", "a", "###")}\n${entry("2026-01-02", "b", "###")}\n## track: data\n\n${entry("2026-01-03", "c", "###")}`);
    expect(t.get("social")).toHaveLength(2);
    expect(t.get("data")).toHaveLength(1);
  });
});

describe("SkillForgeRunner", () => {
  it("drafts proposals for new notes only, never touches SKILL.md, and proposes new skills at 3 entries", async () => {
    const calls: { prompt: string; opts: AskOptions }[] = [];
    const ask = async (prompt: string, opts: AskOptions) => { calls.push({ prompt, opts }); return "## Summary\nAdd a low-pass section.\n"; };
    const forge = new SkillForgeRunner(ask, () => new Date("2026-09-27T22:00:00Z"));

    const r1 = await forge.runOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ backend: "claude", tier: "sonnet" });
    expect(calls[0].prompt).toContain("Fly low.");
    expect(calls[0].prompt).toContain("Low pass");
    expect(r1.proposals).toEqual([{ kind: "skill", name: "drone", path: join(HOMES.forgeDir, "drone-2026-09-27.md"), entries: 2 }]);
    expect(readFileSync(r1.proposals[0].path, "utf-8")).toContain("Add a low-pass section.");
    expect(readFileSync(join(root, "agents/drone/SKILL.md"), "utf-8")).toBe(SKILL);

    // Nothing new → no model call.
    expect((await forge.runOnce()).proposals).toHaveLength(0);
    expect(calls).toHaveLength(1);

    appendFileSync(join(root, "agents/drone/references/field-notes.md"), `\n${entry("2026-09-25", "Orbit")}`);
    writeFileSync(join(HOMES.forgeDir, "new-skills.md"), `# New\n\n## track: social\n\n${entry("2026-09-20", "Hook A", "###")}\n${entry("2026-09-21", "Hook B", "###")}\n## track: data\n\n${entry("2026-09-21", "D", "###")}`);
    expect(forgeSummary()).toContain("drone 1");
    const r3 = await forge.runOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toMatch(/<new_field_notes>\n## 2026-09-25 · Orbit/);
    expect(r3.proposals.map((p) => p.kind)).toEqual(["skill"]);

    appendFileSync(join(HOMES.forgeDir, "new-skills.md"), `\n${entry("2026-09-26", "Hook C", "###")}`);
    const r4 = await forge.runOnce();
    // Appended at the end, "Hook C" lands in the data section: neither track reaches 3.
    expect(r4.proposals).toHaveLength(0);
    writeFileSync(join(HOMES.forgeDir, "new-skills.md"), `# New\n\n## track: social\n\n${entry("2026-09-20", "Hook A", "###")}\n${entry("2026-09-21", "Hook B", "###")}\n${entry("2026-09-26", "Hook C", "###")}\n## track: data\n\n${entry("2026-09-21", "D", "###")}`);
    const r5 = await forge.runOnce();
    expect(r5.proposals).toEqual([{ kind: "new-skill", name: "social", path: join(HOMES.forgeDir, "new-skill-social-2026-09-27.md"), entries: 3 }]);
    expect(calls.at(-1)!.prompt).toContain("Hook C");
    expect((await forge.runOnce()).proposals).toHaveLength(0);

    expect(forgeSummary()).toBe("");
    expect(readdirSync(HOMES.forgeDir).sort()).toEqual(["drone-2026-09-27.md", "new-skill-social-2026-09-27.md", "new-skills.md"]);
    expect(existsSync(join(root, "agents/drone/SKILL.md.orig"))).toBe(false);
  });

  it("records failures without advancing the watermark", async () => {
    appendFileSync(join(root, "agents/drone/references/field-notes.md"), `\n${entry("2026-09-26", "Dive")}`);
    const bad = new SkillForgeRunner(async () => { throw new Error("rate limited"); });
    const r = await bad.runOnce();
    expect(r.errors[0]).toContain("rate limited");
    expect(forgeSummary()).toContain("1 field note(s) waiting");
  });
});
