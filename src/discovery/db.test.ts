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

  describe("getScoringQueue", () => {
    const add = (videoId: string, score: number | null, discoveredAt: string, title: string | null = videoId) =>
      db.prepare(
        `INSERT INTO discovery_candidates (video_id, source, title, score, discovered_at) VALUES (?, 'rss', ?, ?, ?)`,
      ).run(videoId, title, score, discoveredAt);

    it("puts never-scored rows first, newest first, ahead of higher-scored rows", async () => {
      const { getScoringQueue } = await import("./db.ts");
      for (let i = 0; i < 5; i++) add(`scored${i}`, 0.9 - i * 0.1, "2026-09-25T00:00:00Z");
      add("old", null, "2026-09-01T00:00:00Z");
      add("new", null, "2026-09-20T00:00:00Z");
      // Old query (COALESCE(score,0) DESC) with limit 5 returned only scored0..4.
      const queue = getScoringQueue(5, 2).map((c) => c.video_id);
      expect(queue).toEqual(["new", "old", "scored0", "scored1", "scored2"]);
    });

    it("keeps rescoreSlots for the best scored rows when the backlog is large", async () => {
      const { getScoringQueue } = await import("./db.ts");
      for (let i = 0; i < 6; i++) add(`new${i}`, null, `2026-09-2${i}T00:00:00Z`);
      add("best", 0.8, "2026-09-01T00:00:00Z");
      add("worse", 0.3, "2026-09-01T00:00:00Z");
      const queue = getScoringQueue(4, 1).map((c) => c.video_id);
      expect(queue).toEqual(["new5", "new4", "new3", "best"]);
    });

    it("skips titleless rows and non-candidate statuses", async () => {
      const { getScoringQueue, updateCandidate } = await import("./db.ts");
      add("notitle", null, "2026-09-25T00:00:00Z", null);
      add("blank", null, "2026-09-25T00:00:00Z", "  ");
      add("gone", null, "2026-09-25T00:00:00Z");
      const gone = db.prepare(`SELECT id FROM discovery_candidates WHERE video_id = 'gone'`).get() as { id: number };
      updateCandidate(gone.id, { status: "rejected" });
      add("fine", null, "2026-09-24T00:00:00Z");
      expect(getScoringQueue(10, 2).map((c) => c.video_id)).toEqual(["fine"]);
    });
  });

  describe("rejectCandidatesAlreadyInLibrary", () => {
    const addVideo = (videoId: string) =>
      db.prepare(
        `INSERT INTO youtube_videos (video_id, title, channel_title, url, markdown_summary, analysis_json, transcript_text)
         VALUES (?, 't', 'c', 'u', 's', '{}', '')`,
      ).run(videoId);
    const statusOf = (videoId: string, source: string) =>
      db.prepare(`SELECT status, reason FROM discovery_candidates WHERE video_id = ? AND source = ?`)
        .get(videoId, source) as { status: string; reason: string | null };

    beforeEach(() => {
      db.exec(`DELETE FROM youtube_videos`);
    });

    it("rejects queued candidates whose video is already in the library, leaving others queued", async () => {
      const { insertCandidate, rejectCandidatesAlreadyInLibrary, getScoringQueue } = await import("./db.ts");
      addVideo("sent");
      insertCandidate({ videoId: "sent", source: "rss", title: "Sent by David" });
      insertCandidate({ videoId: "fresh", source: "rss", title: "Brand new" });

      expect(rejectCandidatesAlreadyInLibrary()).toBe(1);
      expect(statusOf("sent", "rss")).toEqual({ status: "rejected", reason: "already_in_library" });
      expect(statusOf("fresh", "rss").status).toBe("candidate");
      expect(getScoringQueue(10, 2).map((c) => c.video_id)).toEqual(["fresh"]);
    });

    it("only touches 'candidate' rows, so a processed row for the same video keeps its status", async () => {
      const { insertCandidate, updateCandidate, rejectCandidatesAlreadyInLibrary } = await import("./db.ts");
      addVideo("found");
      insertCandidate({ videoId: "found", source: "search", title: "Found by discovery" });
      insertCandidate({ videoId: "found", source: "rss", title: "Found by discovery" });
      const searchRow = db.prepare(`SELECT id FROM discovery_candidates WHERE video_id = 'found' AND source = 'search'`)
        .get() as { id: number };
      updateCandidate(searchRow.id, { status: "surfaced" });

      expect(rejectCandidatesAlreadyInLibrary()).toBe(1);
      expect(statusOf("found", "search")).toEqual({ status: "surfaced", reason: null });
      expect(statusOf("found", "rss").status).toBe("rejected");
      expect(rejectCandidatesAlreadyInLibrary()).toBe(0);
    });
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
