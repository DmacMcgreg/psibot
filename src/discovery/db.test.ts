import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
// Importing index.ts calls Database.setCustomSQLite once (module load), so we
// must not call it again here.
import { setDbForTesting } from "../db/index.ts";

// Standup: build an in-memory DB with the full schema, then swap it in as the
// process-wide DB so the discovery db.ts functions target it. This verifies the
// new migration tables apply and that CRUD behaves correctly.

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  // Inject as the singleton DB used by getDb().
  setDbForTesting(db);
});

afterAll(() => {
  db.close();
});

describe("discovery schema migration", () => {
  it("creates the 5 discovery tables", () => {
    const names = db
      .prepare<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'discovery_%' ORDER BY name`,
      )
      .all().map((r) => r.name);
    expect(names).toContain("discovery_channels");
    expect(names).toContain("discovery_candidates");
    expect(names).toContain("discovery_interest_weights");
    expect(names).toContain("discovery_state");
    expect(names).toContain("discovery_runs");
  });

  it("enforces the discovery_candidates status CHECK constraint", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO discovery_candidates (video_id, source, status) VALUES ('x', 'rss', 'bogus')`,
      ).run()
    ).toThrow();
  });

  it("enforces the discovery_channels origin CHECK constraint", () => {
    expect(() =>
      db.prepare(
        `INSERT INTO discovery_channels (channel_id, channel_title, origin) VALUES ('UC1', 'C', 'bogus')`,
      ).run()
    ).toThrow();
  });
});

describe("discovery db CRUD", () => {
  beforeEach(() => {
    db.exec(`DELETE FROM discovery_candidates`);
    db.exec(`DELETE FROM discovery_channels`);
    db.exec(`DELETE FROM discovery_state`);
  });

  it("upserts a channel idempotently and tracks watch_count", async () => {
    const { upsertChannel, getChannel } = await import("./db.ts");
    upsertChannel({ channelId: "UCaaa", channelTitle: "AAA", origin: "history", watchCount: 3 });
    upsertChannel({ channelId: "UCaaa", channelTitle: "AAA", origin: "history", watchCount: 5 });
    const ch = getChannel("UCaaa")!;
    expect(ch).not.toBeNull();
    expect(ch.watch_count).toBe(5); // MAX, not overwrite
  });

  it("inserts candidates with dedup on (video_id, source)", async () => {
    const { insertCandidate } = await import("./db.ts");
    expect(insertCandidate({ videoId: "v1", source: "rss", title: "A" })).toBe(true);
    expect(insertCandidate({ videoId: "v1", source: "rss", title: "A" })).toBe(false); // dup
    expect(insertCandidate({ videoId: "v1", source: "search", title: "A" })).toBe(true); // different source OK
  });

  it("updates candidate score and status", async () => {
    const { insertCandidate, getTopUnscoredCandidates, updateCandidate, getCandidatesByStatus } = await import("./db.ts");
    insertCandidate({ videoId: "v2", source: "rss" });
    const [c] = getTopUnscoredCandidates(10);
    updateCandidate(c.id, { score: 0.87, status: "surfaced" });
    const surfaced = getCandidatesByStatus("surfaced", 10);
    expect(surfaced.length).toBe(1);
    expect(surfaced[0].score).toBeCloseTo(0.87, 5);
  });

  it("stores and retrieves state key/value", async () => {
    const { setState, getState } = await import("./db.ts");
    setState("topic_id", "42");
    expect(getState("topic_id")).toBe("42");
    expect(getState("missing")).toBeNull();
  });

  it("records a run with stats", async () => {
    const { startRun, completeRun, getRecentRuns } = await import("./db.ts");
    const id = startRun();
    completeRun(id, { channelsPolled: 5, processed: 2, surfaced: 2 });
    const [run] = getRecentRuns(1);
    expect(run.id).toBe(id);
    expect(run.channels_polled).toBe(5);
    expect(run.processed).toBe(2);
  });
});
