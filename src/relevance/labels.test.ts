import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
// Side-effect import, must run before the first `new Database(...)` below:
// src/db/index.ts registers the Homebrew SQLite build (extension-capable)
// process-wide, and once ANY bun:sqlite Database is instantiated the
// registration is a silent no-op — later sqliteVec.load() calls in this or
// any other test file of the same bun-test process then fail with "This
// build of sqlite3 does not support dynamic extension loading".
import "../db/index.ts";
import {
  aliasReasonClass,
  dedupeAliasDecisions,
  feedbackActionLabel,
  isChosenVideo,
  loadArticles,
  loadEntities,
  loadVideos,
  normTs,
  sentimentLabel,
  summaryLead,
} from "./labels.ts";
import { buildProfile } from "./profile.ts";

describe("pure label rules", () => {
  it("maps triage actions to labels and keeps the reason", () => {
    expect(feedbackActionLabel("research")).toEqual({ label: 1, action: "research", reason: null });
    expect(feedbackActionLabel("watch")?.label).toBe(1);
    expect(feedbackActionLabel("archive:known")).toBeNull();
    expect(feedbackActionLabel("archive")).toBeNull();
    expect(feedbackActionLabel("archive:irrelevant")).toEqual({ label: 0, action: "archive", reason: "irrelevant" });
    expect(feedbackActionLabel("drop")).toEqual({ label: 0, action: "drop", reason: null });
    expect(feedbackActionLabel("drop:outdated")?.label).toBe(0);
    expect(feedbackActionLabel("retriage")).toBeNull();
    expect(feedbackActionLabel(null)).toBeNull();
  });

  it("treats skipped Discover feedback as neutral", () => {
    expect(sentimentLabel("interested")).toBe(1);
    expect(sentimentLabel("not_interested")).toBe(0);
    expect(sentimentLabel("skipped")).toBeNull();
  });

  it("normalises both SQLite timestamp styles", () => {
    expect(normTs("2026-07-02 01:04:26Z")).toBe("2026-07-02T01:04:26Z");
    expect(normTs("2026-07-02T01:04:26Z")).toBe("2026-07-02T01:04:26Z");
    expect(normTs("2026-07-02 01:04:26")).toBe("2026-07-02T01:04:26Z");
  });

  it("classifies chosen videos: Watch Later, never discovered, or stored before discovery", () => {
    expect(isChosenVideo({ created_at: "2026-08-01 00:00:00Z", playlist_item_id: "PL1", first_discovered_at: "2026-07-01T00:00:00Z" })).toBe(true);
    expect(isChosenVideo({ created_at: "2026-08-01 00:00:00Z", playlist_item_id: null, first_discovered_at: null })).toBe(true);
    expect(isChosenVideo({ created_at: "2026-06-01 00:00:00Z", playlist_item_id: null, first_discovered_at: "2026-07-01T00:00:00Z" })).toBe(true);
    expect(isChosenVideo({ created_at: "2026-08-01 00:00:00Z", playlist_item_id: null, first_discovered_at: "2026-07-01T00:00:00Z" })).toBe(false);
  });

  it("dedupes alias proposals: latest decision wins, flip-flops flagged", () => {
    const out = dedupeAliasDecisions([
      { entity_id: 1, alias_norm: "a", status: "rejected", decided_at: "2026-05-01T00:00:00Z", created_at: "x" },
      { entity_id: 1, alias_norm: "a", status: "approved", decided_at: "2026-06-01T00:00:00Z", created_at: "x" },
      { entity_id: 1, alias_norm: "a", status: "pending", decided_at: null, created_at: "x" },
      { entity_id: 2, alias_norm: "b", status: "pending", decided_at: null, created_at: "x" },
    ]);
    const a = out.find((d) => d.entity_id === 1)!;
    expect(a.status).toBe("approved");
    expect(a.conflicting).toBe(true);
    expect(a.duplicates).toBe(3);
    expect(out.find((d) => d.entity_id === 2)!.status).toBe("pending");
  });

  it("extracts the Overview lead and classifies alias reasons", () => {
    expect(summaryLead("## Overview\nHello   world.\n\n## Key Topics\n- x")).toBe("Hello world.");
    expect(summaryLead("x".repeat(50), 10).length).toBe(10);
    expect(aliasReasonClass("tail token of \"x y\"")).toBe("tail");
    expect(aliasReasonClass("plural variant")).toBe("plural");
  });
});

// ─── loaders against a tiny in-memory schema ───────────────────────────────

function fixtureDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE youtube_videos (id INTEGER PRIMARY KEY, video_id TEXT, title TEXT, channel_title TEXT, url TEXT,
      tags TEXT, markdown_summary TEXT, analysis_json TEXT, transcript_text TEXT, created_at TEXT, playlist_item_id TEXT);
    CREATE TABLE discovery_candidates (id INTEGER PRIMARY KEY, video_id TEXT, discovered_at TEXT, score REAL);
    CREATE TABLE pending_items (id INTEGER PRIMARY KEY, url TEXT, title TEXT, description TEXT, source TEXT, platform TEXT,
      profile TEXT, status TEXT, priority INTEGER, category TEXT, triage_summary TEXT, auto_decision TEXT, signal_score REAL,
      value_type TEXT, extracted_value TEXT);
    CREATE TABLE feedback_log (id INTEGER PRIMARY KEY, item_id INTEGER, user_action TEXT, source TEXT, created_at TEXT);
    CREATE TABLE atlas_items (id INTEGER PRIMARY KEY, kind TEXT, source_table TEXT, source_id TEXT, title TEXT);
    CREATE TABLE discover_feedback (id INTEGER PRIMARY KEY, atlas_item_id INTEGER, sentiment TEXT, reasons_json TEXT, note TEXT, created_at TEXT);
    CREATE TABLE discover_topic_groups (id INTEGER PRIMARY KEY, slug TEXT, label TEXT, sort_order INTEGER, item_count INTEGER);
    CREATE TABLE discover_item_groups (atlas_item_id INTEGER, group_id INTEGER);
    CREATE TABLE atlas_entities (id INTEGER PRIMARY KEY, kind TEXT, name_norm TEXT, display_name TEXT, mention_count INTEGER);
    CREATE TABLE atlas_alias_proposals (id INTEGER PRIMARY KEY, entity_id INTEGER, alias_norm TEXT, reason TEXT, status TEXT, created_at TEXT, decided_at TEXT);

    -- v1 chosen (never discovered); v2 discovery-found, no feedback; v3 discovery-found + not_interested;
    -- v4 discovery-found + research via triage
    INSERT INTO youtube_videos VALUES
      (1,'v1','Chosen','ChanA','u','["ai"]','## Overview\nAbout agents.','{}','','2026-07-10 00:00:00Z',NULL),
      (2,'v2','Unlabeled','ChanB','u','[]','## Overview\nSomething.','{}','','2026-07-10 00:00:00Z',NULL),
      (3,'v3','Rejected short','ChanC','u','[]','## Overview\nMeme.','{}','','2026-07-10 00:00:00Z',NULL),
      (4,'v4','Researched','ChanD','u','[]','## Overview\nTool.','{}','','2026-07-10 00:00:00Z',NULL);
    INSERT INTO discovery_candidates (video_id, discovered_at, score) VALUES
      ('v2','2026-07-01T00:00:00Z',0.3),('v3','2026-07-01T00:00:00Z',0.2),('v4','2026-07-01T00:00:00Z',0.4);
    INSERT INTO pending_items (id,url,title,source,platform,status,priority,value_type) VALUES
      (10,'https://www.youtube.com/watch?v=v4','Researched','youtube','youtube','archived',2,'tool'),
      (11,'https://www.youtube.com/watch?v=v2','Unlabeled','youtube','youtube','deleted',5,'no_value'),
      (20,'https://github.com/a/b','a/b','github','github','archived',2,'tool'),
      (21,'https://x.com/p','post','chrome-extension','x.com','archived',3,'technique'),
      (22,'https://github.com/c/d','c/d','github','github','deleted',5,'no_value');
    INSERT INTO feedback_log (item_id,user_action,created_at) VALUES
      (10,'research','2026-07-11 00:00:00Z'),(20,'watch','2026-07-11 00:00:00Z'),(21,'archive:irrelevant','2026-07-11 00:00:00Z');
    INSERT INTO atlas_items VALUES (100,'youtube','youtube_videos','v3','Rejected short');
    INSERT INTO discover_feedback (atlas_item_id,sentiment,reasons_json,note,created_at) VALUES
      (100,'not_interested','["Pure fluff content"]',NULL,'2026-07-12T00:00:00Z');
    INSERT INTO discover_topic_groups VALUES (1,'llms','LLMs',0,5);
    INSERT INTO atlas_entities VALUES (1,'name','everything claude code','Everything Claude Code',2),(2,'topic','claude code','Claude Code',400);
    INSERT INTO atlas_alias_proposals (entity_id,alias_norm,reason,status,created_at,decided_at) VALUES
      (1,'claude code','tail token of "everything claude code"','rejected','x','2026-07-01T00:00:00Z');
  `);
  return db;
}

describe("DB loaders", () => {
  const db = fixtureDb();

  it("labels videos: chosen / unlabeled / explicit (Discover + triage)", () => {
    const v = Object.fromEntries(loadVideos(db).map((i) => [i.key, i]));
    expect(v["video:v1"].labelKind).toBe("chosen");
    expect(v["video:v1"].label).toBe(1);
    expect(v["video:v2"].label).toBeNull(); // auto-deleted pending item is NOT a label
    expect(v["video:v3"].labelKind).toBe("explicit_neg");
    expect(v["video:v3"].reason).toBe("Pure fluff content");
    expect(v["video:v4"].labelKind).toBe("explicit_pos");
    expect(v["video:v4"].baselines.triage_priority).toBe(-2);
    expect(v["video:v2"].baselines.discovery_score).toBe(0.3);
  });

  it("labels articles only from human feedback and skips YouTube rows", () => {
    const a = loadArticles(db);
    expect(a.map((i) => i.key).sort()).toEqual(["article:20", "article:21"]);
    expect(a.find((i) => i.key === "article:21")!.reason).toBe("irrelevant");
    expect(loadArticles(db, true).length).toBe(3);
  });

  it("describes alias collisions with existing entities", () => {
    const { items } = loadEntities(db);
    expect(items[0].label).toBe(0);
    expect((items[0].content.alias_is_separate_entity as { name: string }).name).toBe("Claude Code");
    expect(items[0].baselines.heuristic_rule).toBe(0);
  });

  it("builds a profile from labels without describing unlabeled items as rejected", () => {
    const labeled = [...loadVideos(db), ...loadArticles(db)].filter((i) => i.label !== null);
    const p = buildProfile(labeled, { groupLabels: { llms: "LLMs" } });
    expect(p.text).toContain("Chosen");
    expect(p.text).toContain("Pure fluff content");
    expect(p.text).not.toContain("Unlabeled");
    expect(p.exemplarKeys).toContain("video:v1");
    expect(buildProfile(labeled).hash).toBe(buildProfile(labeled).hash);
  });
});
