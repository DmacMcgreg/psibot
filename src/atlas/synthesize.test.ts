import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMonthlySynthesis } from "./synthesize.ts";

// The 2026-10-02 prune deleted knowledge/trading/ (43,013 B injection surface).
// The monthly synthesis used to appendLines into knowledge/trading/{PLAYBOOK,
// LESSONS,MODELS,RESEARCH}.md with no mkdir — with the dir pruned the Nov 1
// 06:00 window died on ENOENT after LLM spend, and a recreated dir would
// regrow the injection surface. The product now lands as one durable artifact
// under archive/atlas-monthly/ (beside knowledge/archive/, never under knowledge/).

interface ReduceFixture {
  playbook_appends: string[];
  lessons_appends: string[];
  models_appends: string[];
  research_appends: string[];
}

function inTempDir(body: (tmp: string) => void, opts?: { withKnowledgeDir?: boolean }): void {
  const tmp = mkdtempSync(join(tmpdir(), "atlas-monthly-"));
  const prev = process.cwd();
  process.chdir(tmp);
  try {
    if (opts?.withKnowledgeDir) {
      mkdirSync(join(tmp, "knowledge"), { recursive: true });
      writeFileSync(join(tmp, "knowledge", "HEARTBEAT.md"), "heartbeat\n");
    }
    body(tmp);
  } finally {
    process.chdir(prev);
    rmSync(tmp, { recursive: true, force: true });
  }
}

const FULL_REDUCE: ReduceFixture = {
  playbook_appends: ["- breakout retest held twice (2026-09-03, 2026-09-17)"],
  lessons_appends: [],
  models_appends: ["- MTF + VWAP + sentiment score"],
  research_appends: ["- does RSI divergence predict regime flips?"],
};

describe("monthly synthesis archive routing", () => {
  it("succeeds with knowledge/ entirely absent, writing zero knowledge/ files", () => {
    inTempDir((tmp) => {
      const path = writeMonthlySynthesis(FULL_REDUCE);

      const month = new Date().toISOString().slice(0, 7);
      expect(path).toBe(join(realpathSync(tmp), "archive", "atlas-monthly", `${month}.md`));
      expect(existsSync(path!)).toBe(true);
      const body = readFileSync(path!, "utf-8");
      expect(body).toContain("# Monthly scan synthesis");
      expect(body).toContain("- breakout retest held twice");
      expect(body).toContain("- MTF + VWAP + sentiment score");
      // Only the non-empty categories are written.
      expect(body).not.toContain("monthly additions (failures)");
      // knowledge/ is never created.
      expect(existsSync(join(tmp, "knowledge"))).toBe(false);
    });
  });

  it("succeeds with knowledge/ present but trading pruned, leaving knowledge/ untouched", () => {
    inTempDir(
      (tmp) => {
        const path = writeMonthlySynthesis(FULL_REDUCE);

        expect(existsSync(path!)).toBe(true);
        expect(existsSync(join(tmp, "knowledge", "trading"))).toBe(false);
        expect(readdirSync(join(tmp, "knowledge"))).toEqual(["HEARTBEAT.md"]);
      },
      { withKnowledgeDir: true },
    );
  });

  it("returns null and writes nothing when the reduce produced no lines", () => {
    inTempDir((tmp) => {
      const path = writeMonthlySynthesis({
        playbook_appends: [],
        lessons_appends: [],
        models_appends: [],
        research_appends: [],
      });

      expect(path).toBeNull();
      expect(existsSync(join(tmp, "archive"))).toBe(false);
    });
  });

  it("re-runs in the same month append to the artifact instead of clobbering it", () => {
    inTempDir((tmp) => {
      const first = writeMonthlySynthesis(FULL_REDUCE);
      const second = writeMonthlySynthesis({
        playbook_appends: [],
        lessons_appends: ["- earnings-gap setup failed on low volume"],
        models_appends: [],
        research_appends: [],
      });

      expect(second).toBe(first);
      const body = readFileSync(first!, "utf-8");
      expect(body).toContain("- breakout retest held twice");
      expect(body).toContain("- earnings-gap setup failed on low volume");
    });
  });

  it("leaves no knowledge-anchored write path in the monthly pipeline (mutation: reintroducing the append reddens this)", () => {
    const source = readFileSync(new URL("./synthesize.ts", import.meta.url), "utf-8");
    const violations = ["appendLines", "PLAYBOOK.md", "LESSONS.md", "MODELS.md", "RESEARCH.md"].filter((m) =>
      source.includes(m),
    );
    expect(violations).toEqual([]);
    expect(source).toContain("writeMonthlySynthesis");

    const monthly = source.slice(source.indexOf("export async function synthesizeMonthly"));
    expect(monthly).not.toContain("writeFileSync");
    expect(monthly).toContain("writeMonthlySynthesis");
  });
});

afterAll(() => {
  const leftovers = readdirSync(tmpdir()).filter((d) => d.startsWith("atlas-monthly-"));
  expect(leftovers).toEqual([]);
});
