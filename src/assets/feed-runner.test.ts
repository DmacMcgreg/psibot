import { describe, it, expect, beforeAll, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { AssetFeedRunner, checkFeedHealth } from "./feed-runner.ts";
import { newStats, getFeedMemo, type FeedStats } from "./feeds/common.ts";
import { setOpsAlertSender, resetOpsAlertsForTesting } from "../shared/ops-alerts.ts";
import type { FeedDef } from "./feeds/index.ts";

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
});
afterEach(() => resetOpsAlertsForTesting());
afterAll(() => db.close());

function stats(over: Partial<FeedStats>): FeedStats {
  return { ...newStats("t"), finished_at: new Date().toISOString(), ...over };
}

describe("checkFeedHealth", () => {
  it("alerts once on a run with no data, then throttles a repeat within 24h", () => {
    const sent: string[] = [];
    setOpsAlertSender(async (text) => { sent.push(text); return true; });
    checkFeedHealth({ name: "nodata-1" }, stats({ seen: 0, candidates: 0 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("nodata-1");
    checkFeedHealth({ name: "nodata-1" }, stats({ seen: 0, candidates: 0 }));
    expect(sent).toHaveLength(1); // deduped by sendOpsAlert's own 24h window
  });

  it("alerts on a thrown-error run even when seen > 0", () => {
    const sent: string[] = [];
    setOpsAlertSender(async (text) => { sent.push(text); return true; });
    checkFeedHealth({ name: "errored" }, stats({ seen: 26, candidates: 0, errors: ["no programs parsed: the page layout may have changed"] }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("no programs parsed");
  });

  it("needs two consecutive empty-candidate runs before alerting, and resets the streak on a good run", () => {
    const sent: string[] = [];
    setOpsAlertSender(async (text) => { sent.push(text); return true; });
    checkFeedHealth({ name: "quiet" }, stats({ seen: 40, candidates: 0 }));
    expect(sent).toHaveLength(0); // first empty run: not yet
    checkFeedHealth({ name: "quiet" }, stats({ seen: 35, candidates: 0 }));
    expect(sent).toHaveLength(1); // second in a row: alert
    expect(sent[0]).toMatch(/0 candidates/);

    checkFeedHealth({ name: "quiet2" }, stats({ seen: 40, candidates: 0 }));
    checkFeedHealth({ name: "quiet2" }, stats({ seen: 40, candidates: 5 })); // a real run in between resets the streak
    checkFeedHealth({ name: "quiet2" }, stats({ seen: 40, candidates: 0 }));
    expect(sent).toHaveLength(1); // still just the "quiet" alert from above; quiet2 has only 1 in its new streak
  });

  it("never alerts on a healthy run, and doesn't touch the streak once it's back to normal", () => {
    const sent: string[] = [];
    setOpsAlertSender(async (text) => { sent.push(text); return true; });
    checkFeedHealth({ name: "healthy" }, stats({ seen: 900, candidates: 48 }));
    expect(sent).toHaveLength(0);
    expect(getFeedMemo<{ consecutiveEmptyCandidates: number }>("healthy", "health")?.consecutiveEmptyCandidates).toBe(0);
  });
});

describe("AssetFeedRunner scheduling", () => {
  function fakeFeed(name: string, series: Partial<FeedStats>[]): FeedDef {
    let i = 0;
    return {
      name, schedule: "0 0 * * *", everyHours: 24,
      run: async () => stats({ feed: name, ...series[Math.min(i++, series.length - 1)] }),
    };
  }

  it("runOnce (a manual/HTTP-triggered run) never counts towards the consecutive-empty streak or alerts", async () => {
    const sent: string[] = [];
    setOpsAlertSender(async (text) => { sent.push(text); return true; });
    const feed = fakeFeed("manual-only", [{ seen: 0, candidates: 0 }]);
    const runner = new AssetFeedRunner([feed]);
    await runner.runOnce("manual-only");
    await runner.runOnce("manual-only");
    await runner.runOnce();
    expect(sent).toHaveLength(0);
    expect(getFeedMemo("manual-only", "health")).toBeNull();
  });
});
