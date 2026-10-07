import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, appendFileSync, statSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { rotateFile, pruneArchives, trackGrowth, previousDay, LogRotationRunner } from "./log-rotation.ts";
import { setOpsAlertSender, resetOpsAlertsForTesting } from "../shared/ops-alerts.ts";

let db: Database;
let dir: string;
let sent: string[];

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM ops_state;");
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "psibot-logs-"));
  resetOpsAlertsForTesting();
  sent = [];
  setOpsAlertSender(async (t) => {
    sent.push(t);
    return true;
  });
});

describe("rotateFile", () => {
  it("gzips the current bytes and truncates the live file in place", async () => {
    const path = join(dir, "psibot.out.log");
    const body = "2026-09-25T10:00:00.000Z [INFO] a\n    at stack\n2026-09-25T11:00:00.000Z [INFO] b\n";
    writeFileSync(path, body);
    const inode = statSync(path).ino;

    const r = await rotateFile(path, join(dir, "archive"), "2026-09-25");
    expect(r.bytes).toBe(body.length);
    expect(r.archive).toBe(join(dir, "archive", "psibot.out.log.2026-09-25.gz"));
    expect(gunzipSync(readFileSync(r.archive!)).toString()).toBe(body);
    expect(statSync(path).size).toBe(0);
    expect(statSync(path).ino).toBe(inode); // same file launchd holds open

    // Appends after truncation land at the start, not after a hole.
    appendFileSync(path, "next\n");
    expect(readFileSync(path, "utf8")).toBe("next\n");
  });

  it("does not overwrite an archive with the same label", async () => {
    const path = join(dir, "psibot.err.log");
    writeFileSync(path, "one\n");
    await rotateFile(path, join(dir, "archive"), "2026-09-25");
    writeFileSync(path, "two\n");
    const r = await rotateFile(path, join(dir, "archive"), "2026-09-25");
    expect(r.archive).toBe(join(dir, "archive", "psibot.err.log.2026-09-25-2.gz"));
  });

  it("skips an empty or missing file", async () => {
    expect((await rotateFile(join(dir, "nope.log"), join(dir, "archive"), "2026-09-25")).archive).toBeNull();
    writeFileSync(join(dir, "empty.log"), "");
    expect((await rotateFile(join(dir, "empty.log"), join(dir, "archive"), "2026-09-25")).archive).toBeNull();
  });
});

describe("pruneArchives", () => {
  it("keeps 7 days of rotated files", () => {
    const archive = join(dir, "archive");
    rmSync(archive, { recursive: true, force: true });
    const names = ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-25", "2026-09-19-2"].map((d) => `psibot.out.log.${d}.gz`);
    mkdirSync(archive, { recursive: true });
    for (const n of names) writeFileSync(join(archive, n), "x");
    const removed = pruneArchives(archive, "2026-09-26").sort();
    expect(removed).toEqual(["psibot.out.log.2026-09-18.gz"]);
    expect(readdirSync(archive).sort()).toEqual([
      "psibot.out.log.2026-09-19-2.gz",
      "psibot.out.log.2026-09-19.gz",
      "psibot.out.log.2026-09-20.gz",
      "psibot.out.log.2026-09-25.gz",
    ]);
  });

  it("computes the previous day across month ends", () => {
    expect(previousDay("2026-10-01")).toBe("2026-09-30");
    expect(previousDay("2026-01-01")).toBe("2025-12-31");
  });
});

describe("trackGrowth", () => {
  const MB = 1024 * 1024;
  it("crosses once per day, resets on a new day, and treats a shrink as a rotation", () => {
    expect(trackGrowth("f", 10 * MB, "2026-09-26").crossed).toBe(false); // baseline
    expect(trackGrowth("f", 150 * MB, "2026-09-26")).toEqual({ growth: 140 * MB, crossed: false });
    expect(trackGrowth("f", 260 * MB, "2026-09-26").crossed).toBe(true);
    expect(trackGrowth("f", 900 * MB, "2026-09-26").crossed).toBe(false); // already alerted today
    expect(trackGrowth("f", 1 * MB, "2026-09-27").crossed).toBe(false); // new day, new baseline
    expect(trackGrowth("f", 0, "2026-09-27").growth).toBe(0); // rotated
    expect(trackGrowth("f", 201 * MB, "2026-09-27").crossed).toBe(true);
  });
});

describe("LogRotationRunner.check", () => {
  it("starts the cycle on first run, rotates once per new day, and alerts on runaway growth", async () => {
    const out = join(dir, "psibot.out.log");
    writeFileSync(out, "2026-09-26T12:00:00.000Z [INFO] hello\n");
    const runner = new LogRotationRunner(dir, ["psibot.out.log"]);

    await runner.check(new Date("2026-09-26T16:00:00Z")); // noon EDT, first run
    expect(existsSync(join(dir, "archive"))).toBe(false);

    await runner.check(new Date("2026-09-27T04:05:00Z")); // 00:05 EDT next day
    expect(readdirSync(join(dir, "archive"))).toEqual(["psibot.out.log.2026-09-26.gz"]);
    expect(statSync(out).size).toBe(0);

    await runner.check(new Date("2026-09-27T05:00:00Z")); // same day: no second rotation
    expect(readdirSync(join(dir, "archive"))).toHaveLength(1);

    // Runaway: >200 MB in the day (sparse write keeps the test cheap).
    const fd = openSync(out, "r+");
    writeSync(fd, "x", 201 * 1024 * 1024);
    closeSync(fd);
    await runner.check(new Date("2026-09-27T06:00:00Z"));
    await runner.check(new Date("2026-09-27T06:15:00Z"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("PsiBot log runaway: psibot.out.log");
  });
});
