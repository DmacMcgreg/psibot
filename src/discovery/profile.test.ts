import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
// Importing index.ts calls Database.setCustomSQLite once (module load).
import { setDbForTesting } from "../db/index.ts";
import {
  computeTopicWeights,
  rankInterestWeights,
  recencyDecay,
  isNonTopic,
  decodeVecBlob,
  decodeProfileTopics,
  encodeProfileTopics,
  weightedCentroid,
  buildInterestProfile,
  loadCentroid,
  loadProfileTopics,
  loadVideoTopicSignals,
  EMBEDDING_DIMENSIONS,
  FEEDBACK_WEIGHTS,
  USER_CHOSEN_VIDEO_WEIGHT,
  type VideoTopicSignal,
  type FeedbackTopicSignal,
} from "./profile.ts";
import { getInterestWeights } from "./db.ts";

// --- Pure weighting rules ------------------------------------------------------

const video = (topicId: number, provenance: VideoTopicSignal["provenance"], ageDays = 0, topicName = `topic ${topicId}`): VideoTopicSignal =>
  ({ topicId, topicName, provenance, ageDays });
const feedback = (topicId: number, sentiment: FeedbackTopicSignal["sentiment"], ageDays = 0, topicName = `topic ${topicId}`): FeedbackTopicSignal =>
  ({ topicId, topicName, sentiment, ageDays });

describe("computeTopicWeights", () => {
  it("counts sent and Watch Later videos", () => {
    const w = computeTopicWeights([video(1, "sent"), video(2, "watch_later")], []);
    expect(w.get(1)).toBeCloseTo(USER_CHOSEN_VIDEO_WEIGHT, 5);
    expect(w.get(2)).toBeCloseTo(USER_CHOSEN_VIDEO_WEIGHT, 5);
  });

  it("ignores discovery-processed videos that have no feedback", () => {
    const w = computeTopicWeights([video(1, "discovery"), video(1, "discovery"), video(2, "sent")], []);
    expect(w.has(1)).toBe(false);
    expect(w.get(2)).toBeCloseTo(1, 5);
  });

  it("lets an 'interested' rating on a discovery video add weight", () => {
    const w = computeTopicWeights([video(1, "discovery")], [feedback(1, "interested")]);
    expect(w.get(1)).toBeCloseTo(FEEDBACK_WEIGHTS.interested, 5);
  });

  it("pushes topics negative on 'not_interested'", () => {
    const w = computeTopicWeights([], [feedback(1, "not_interested")]);
    expect(w.get(1)).toBeCloseTo(FEEDBACK_WEIGHTS.not_interested, 5);
    expect(w.get(1)!).toBeLessThan(0);
  });

  it("subtracts a rejection from a topic the user also picked", () => {
    const w = computeTopicWeights(
      [video(1, "sent"), video(1, "sent"), video(1, "watch_later")],
      [feedback(1, "not_interested")],
    );
    // 3 picks (+3) and one rejection (−2) → still positive, but lower.
    expect(w.get(1)).toBeCloseTo(1, 5);
  });

  it("treats 'skipped' as no signal", () => {
    const w = computeTopicWeights([], [feedback(1, "skipped")]);
    expect(w.has(1)).toBe(false);
  });

  it("applies recency decay to both videos and feedback", () => {
    const w = computeTopicWeights([video(1, "sent", 30)], [feedback(2, "interested", 30)]);
    expect(w.get(1)).toBeCloseTo(Math.exp(-1), 5);
    expect(w.get(2)).toBeCloseTo(FEEDBACK_WEIGHTS.interested * Math.exp(-1), 5);
  });

  it("drops non-topics entirely, whatever the signal", () => {
    const w = computeTopicWeights(
      [video(1, "sent", 0, "General Content"), video(2, "watch_later", 0, "Generic Content Catchall")],
      [feedback(3, "interested", 0, "Transcript Unavailable / Music-Only Content")],
    );
    expect(w.size).toBe(0);
  });
});

describe("recencyDecay", () => {
  it("is 1 today, e^-1 at 30 days, and floored at 0.1", () => {
    expect(recencyDecay(0)).toBeCloseTo(1, 5);
    expect(recencyDecay(30)).toBeCloseTo(Math.exp(-1), 5);
    expect(recencyDecay(365)).toBeCloseTo(0.1, 5);
  });

  it("treats negative / non-finite ages as fresh", () => {
    expect(recencyDecay(-5)).toBeCloseTo(1, 5);
    expect(recencyDecay(Number.NaN)).toBeCloseTo(1, 5);
  });
});

describe("rankInterestWeights", () => {
  it("normalizes positives to max 1, keeps top-K, and keeps negatives on the same scale", () => {
    const ranked = rankInterestWeights(new Map([[1, 4], [2, 2], [3, 1], [4, -2], [5, -40]]), 2);
    expect(ranked).toEqual([
      { topicId: 1, weight: 1 },
      { topicId: 2, weight: 0.5 },
      { topicId: 5, weight: -1 }, // clamped
      { topicId: 4, weight: -0.5 },
    ]);
  });
});

describe("isNonTopic", () => {
  it.each([
    "General Content",
    "Generic Content Catchall",
    "Transcript Unavailable / Music-Only Content",
    "general topics",
    "Catch-all Themes",
    "Miscellaneous",
    "Uncategorized",
    "No Spoken Content",
    "",
  ])("flags %p", (name) => {
    expect(isNonTopic(name)).toBe(true);
  });

  it.each([
    "Claude Code General-Purpose Agent",
    "General-purpose Harness",
    "Music Generation",
    "Sound & Music Design",
    "Weaponized Inspectors General",
    "WWII General Battlefield Deaths",
    "Open Source AI Models",
  ])("keeps real topic %p", (name) => {
    expect(isNonTopic(name)).toBe(false);
  });
});

// --- Vector plumbing -------------------------------------------------------------

function vecWithOne(dim: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  v[dim] = 1;
  return v;
}

describe("decodeVecBlob", () => {
  it("decodes the raw bytes bun:sqlite returns for a vec0 float[768] column", () => {
    const f = new Float32Array(EMBEDDING_DIMENSIONS).map((_, i) => i / 1000 - 0.3);
    const bytes = new Uint8Array(f.buffer.slice(0));
    const decoded = decodeVecBlob(bytes)!;
    expect(decoded.length).toBe(EMBEDDING_DIMENSIONS);
    expect(decoded[0]).toBeCloseTo(-0.3, 5);
    expect(decoded[767]).toBeCloseTo(0.467, 5);
  });

  it("rejects blobs of the wrong size", () => {
    expect(decodeVecBlob(new Uint8Array(100))).toBeNull();
    expect(decodeVecBlob(null)).toBeNull();
  });
});

describe("profile topic codec + centroid", () => {
  it("round-trips per-topic vectors", () => {
    const topics = [
      { topicId: 7, weight: 1, vector: vecWithOne(0) },
      { topicId: 9, weight: 0.25, vector: vecWithOne(3) },
    ];
    const back = decodeProfileTopics(encodeProfileTopics(topics));
    expect(back.map((t) => [t.topicId, t.weight])).toEqual([[7, 1], [9, 0.25]]);
    expect(back[1].vector[3]).toBe(1);
  });

  it("returns [] for missing or corrupt cache", () => {
    expect(decodeProfileTopics(null)).toEqual([]);
    expect(decodeProfileTopics("not json")).toEqual([]);
  });

  it("builds a unit-length weighted centroid", () => {
    const c = weightedCentroid([
      { topicId: 1, weight: 1, vector: vecWithOne(0) },
      { topicId: 2, weight: 1, vector: vecWithOne(1) },
    ])!;
    expect(c[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

// --- buildInterestProfile against a temp DB ---------------------------------------

describe("buildInterestProfile (in-memory DB)", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    sqliteVec.load(db);
    for (const sql of MIGRATIONS) db.exec(sql);
    setDbForTesting(db);

    const topic = db.prepare(`INSERT INTO youtube_topics (id, name, display_name) VALUES (?, ?, ?)`);
    topic.run(1, "claude code", "Claude Code");
    topic.run(2, "desert fathers", "Desert Fathers");
    topic.run(3, "revenge drama", "Revenge Drama");
    topic.run(4, "general content", "General Content");
    topic.run(5, "agent tooling", "Agent Tooling");
    topic.run(6, "gaming", "Gaming");
    for (const id of [1, 2, 3, 4, 5, 6]) {
      db.prepare(`INSERT INTO youtube_topic_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(id), vecWithOne(id));
    }

    const addVideo = (videoId: string, opts: { watchLater?: boolean; topics: number[] }) => {
      db.prepare(
        `INSERT INTO youtube_videos (video_id, title, channel_title, url, markdown_summary, analysis_json, transcript_text, playlist_item_id)
         VALUES (?, ?, 'ch', 'u', '', '{}', '', ?)`,
      ).run(videoId, videoId, opts.watchLater ? `pl-${videoId}` : null);
      for (const t of opts.topics) {
        db.prepare(`INSERT INTO youtube_topic_links (topic_id, video_id) VALUES (?, ?)`).run(t, videoId);
      }
    };
    const addCandidate = (videoId: string, status: string, source = "search", reason: string | null = null) =>
      db.prepare(`INSERT INTO discovery_candidates (video_id, source, status, reason) VALUES (?, ?, ?, ?)`)
        .run(videoId, source, status, reason);
    const addFeedback = (videoId: string, sentiment: string) => {
      const atlas = db.prepare(
        `INSERT INTO atlas_items (kind, source_table, source_id, title, captured_at) VALUES ('youtube', 'youtube_videos', ?, ?, '2026-09-01') RETURNING id`,
      ).get(videoId, videoId) as { id: number };
      db.prepare(`INSERT INTO discover_feedback (atlas_item_id, sentiment) VALUES (?, ?)`).run(atlas.id, sentiment);
    };

    // User-chosen
    addVideo("sent1", { topics: [1, 4] });           // sent manually; also linked to the catch-all
    addVideo("wl1", { watchLater: true, topics: [2] });
    // Sent manually, but RSS later re-found it (never processed by discovery) → still user-chosen
    addVideo("sent2", { topics: [5] });
    addCandidate("sent2", "candidate", "rss");
    // Discovery-processed, no feedback → ignored (×3 so it would dominate under the old rules)
    for (const id of ["d1", "d2", "d3"]) {
      addVideo(id, { topics: [3, 4] });
      addCandidate(id, "surfaced");
    }
    // Discovery-processed, rated interested / not_interested
    addVideo("d_yes", { topics: [5] });
    addCandidate("d_yes", "surfaced");
    addFeedback("d_yes", "interested");
    addVideo("d_no", { topics: [6] });
    addCandidate("d_no", "surfaced");
    addFeedback("d_no", "not_interested");
    // Dropped in Telegram → counts as not_interested
    addVideo("d_drop", { topics: [3] });
    addCandidate("d_drop", "dismissed");
  });

  afterAll(() => db.close());

  it("classifies provenance by what discovery actually processed", () => {
    const prov = new Map(loadVideoTopicSignals().map((s) => [`${s.topicId}`, s.provenance]));
    expect(prov.get("2")).toBe("watch_later");
    expect(prov.get("6")).toBe("discovery");
    const sent2 = loadVideoTopicSignals().filter((s) => s.topicId === 5).map((s) => s.provenance).sort();
    expect(sent2).toEqual(["discovery", "sent"]); // sent2 is 'sent', d_yes is 'discovery'
  });

  it("weights only user-chosen + rated videos and caches the profile", async () => {
    const result = await buildInterestProfile();
    expect(result.centroidRecomputed).toBe(true);

    const weights = new Map(getInterestWeights().map((w) => [w.topic_id, w.weight]));
    // Agent Tooling: sent2 (+1) + interested d_yes (+1.5) = 2.5 → strongest
    expect(weights.get(5)).toBeCloseTo(1, 5);
    expect(weights.get(1)).toBeCloseTo(1 / 2.5, 5);
    expect(weights.get(2)).toBeCloseTo(1 / 2.5, 5);
    // Discovery-only, catch-all, and rejected topics are not interests
    expect(weights.has(3)).toBe(false);
    expect(weights.has(4)).toBe(false);
    expect(weights.has(6)).toBe(false);

    // Rejected topics are stored with negative weight
    const neg = db.prepare(`SELECT topic_id, weight FROM discovery_interest_weights WHERE weight < 0 ORDER BY topic_id`).all() as Array<{ topic_id: number; weight: number }>;
    expect(neg.map((r) => r.topic_id)).toEqual([3, 6]);
    expect(neg.every((r) => r.weight < 0)).toBe(true);

    // Profile cache: decoded vectors (not raw bytes), unit centroid
    const topics = loadProfileTopics();
    expect(topics.map((t) => t.topicId).sort()).toEqual([1, 2, 5]);
    const t5 = topics.find((t) => t.topicId === 5)!;
    expect(t5.vector[5]).toBeCloseTo(1, 5);
    const c = loadCentroid()!;
    let norm = 0;
    for (const x of c) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 4);
    expect(c[5]).toBeGreaterThan(c[1]);
  });
});
