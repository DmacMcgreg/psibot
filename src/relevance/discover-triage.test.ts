import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
// Side-effect import, must run before the first `new Database(...)` below:
// src/db/index.ts registers the Homebrew SQLite build (extension-capable)
// process-wide, and once ANY bun:sqlite Database is instantiated the
// registration is a silent no-op — later sqliteVec.load() calls in this or
// any other test file of the same bun-test process then fail with "This
// build of sqlite3 does not support dynamic extension loading".
import "../db/index.ts";
import { MIGRATIONS } from "../db/schema.ts";
import {
  buildQuestions,
  decide,
  DEFAULT_THRESHOLDS,
  loadRubric,
  isNewsChannel,
  loadTodo,
  NEWS_CHANNEL_RE,
  probsFrom,
  sampleChosen,
  type ChosenVideo,
  TRIAGE_DDL,
  triageDiscover,
  undoTriage,
  type TriageClient,
} from "./discover-triage.ts";
import type { JevResult, Payload, RawAnswer } from "./jev.ts";

describe("threshold mapping", () => {
  const t = DEFAULT_THRESHOLDS;
  const p = (pNot: number, pInterest: number, pProtected = 0) => ({ pNot, pInterest, pProtected });

  it("hides at or above the hide threshold", () => {
    expect(decide(p(0.85, 0.1), t)).toBe("hide");
    expect(decide(p(0.99, 0), t)).toBe("hide");
    expect(decide(p(0.8499, 0.1), t)).toBe("unsure");
  });

  it("picks at or above the pick threshold", () => {
    expect(decide(p(0.05, 0.8), t)).toBe("pick");
    expect(decide(p(0.1, 0.7999), t)).toBe("unsure");
  });

  it("never hides a protected-interest item", () => {
    expect(decide(p(0.97, 0, 0.5), t)).toBe("unsure");
    expect(decide(p(0.97, 0, 0.49), t)).toBe("hide");
  });

  it("uses the stricter bar for items David saved himself", () => {
    expect(decide(p(0.9, 0), t, { savedByDavid: true })).toBe("unsure");
    expect(decide(p(0.96, 0), t, { savedByDavid: true })).toBe("hide");
    expect(decide(p(0.9, 0), t, { savedByDavid: false })).toBe("hide");
  });

  it("never hides a channel David chose videos from, and leans it toward pick", () => {
    expect(decide(p(1, 0), t, { knownChannel: true })).toBe("unsure");
    const lean = { ...t, pickKnownChannel: 0.6 };
    expect(decide(p(0.3, 0.65), lean, { knownChannel: true })).toBe("pick");
    expect(decide(p(0.3, 0.65), lean)).toBe("unsure");
    expect(decide(p(0.3, 0.55), lean, { knownChannel: true })).toBe("unsure");
    expect(decide(p(0.1, 0.8), t, { knownChannel: true })).toBe("pick");
  });

  it("applies David's news rule to mainstream news channels", () => {
    expect(isNewsChannel("CTV News")).toBe(true);
    expect(isNewsChannel("CTV News Ottawa")).toBe(true);
    expect(isNewsChannel("DW News")).toBe(true);
    expect(isNewsChannel("AI News & Strategy Daily | Nate B Jones")).toBe(false);
    expect(isNewsChannel("Indie Hacker News")).toBe(false);
    // Relevant Canadian news: never hidden, picks at the lower news bar.
    expect(decide(p(0.95, 0.02), t, { pCanadianNews: 0.8 })).toBe("unsure");
    expect(decide(p(0.3, 0.65), t, { pCanadianNews: 0.8 })).toBe("pick");
    // Filler from elsewhere: normal rules, no channel protection.
    expect(decide(p(0.95, 0.02), t, { pCanadianNews: 0.1 })).toBe("hide");
    expect(decide(p(0.3, 0.65), t, { pCanadianNews: 0.1 })).toBe("unsure");
  });

  it("stays unsure if overlapping thresholds would both fire", () => {
    expect(decide(p(0.5, 0.5), { ...t, hide: 0.4, pick: 0.4 })).toBe("unsure");
  });

  it("reads probabilities from choice + noul answers", () => {
    const a: Record<string, RawAnswer> = {
      decision: { choice: "not_interested", probabilities: { not_interested: 0.9, interested: 0.04, unsure: 0.06 } },
      protected_interest: { noul: 0.12 },
    };
    expect(probsFrom(a)).toEqual({ pNot: 0.9, pInterest: 0.04, pProtected: 0.12 });
    expect(probsFrom({ decision: { choice: "interested", confidence: 0.7 } })).toEqual({ pNot: 0, pInterest: 0.7, pProtected: 0 });
  });
});

describe("chosen-video sample", () => {
  const v = (id: string, group: string | null, channel: string, atlasId: number | null = null): ChosenVideo =>
    ({ videoId: id, title: id, channel, tags: [], topic: group, topicGroup: group, atlasId });
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => v(`ai${i}`, "AI", `ai-ch${i % 2}`)),
    v("sp1", "Spirit", "s1"), v("sp2", "Spirit", "s2"),
    v("an1", "Ancient", "a1"),
    v("todo", "Ancient", "a2", 99),
  ];

  it("spreads across topic groups before repeating one, and is deterministic", () => {
    const s = sampleChosen(pool, 4);
    expect(new Set(s.map((x) => x.topic))).toEqual(new Set(["AI", "Spirit", "Ancient"]));
    expect(sampleChosen(pool, 4).map((x) => x.videoId)).toEqual(s.map((x) => x.videoId));
  });

  it("never uses an item that is still waiting for triage as an example", () => {
    expect(sampleChosen(pool, 50, new Set([99])).some((x) => x.videoId === "todo")).toBe(false);
    expect(sampleChosen(pool, 50).length).toBe(pool.length);
  });
});

// ─── fixture DB with the real migrations ─────────────────────────────────────

function fixture(): Database {
  const db = new Database(":memory:");
  const want = /CREATE TABLE IF NOT EXISTS (atlas_items|discover_topic_groups|discover_item_groups|discover_feedback|youtube_videos|discovery_candidates|feedback_log)\b/;
  for (const sql of MIGRATIONS) if (want.test(sql)) db.exec(sql);
  // Columns added by later ALTERs in the real DB.
  db.exec(`ALTER TABLE youtube_videos ADD COLUMN playlist_item_id TEXT`);
  db.exec(`INSERT INTO discover_topic_groups (id, slug, label) VALUES (1, 'viral', 'Viral Shorts & Clips'), (2, 'llm', 'LLMs & AI Engineering')`);
  const item = (id: number, title: string, group: number, source = "disc") => {
    db.run(`INSERT INTO atlas_items (id, kind, source_table, source_id, title, body, captured_at, metadata_json)
            VALUES (?, 'youtube', 'youtube_videos', ?, ?, '## Overview\nbody', '2026-09-01', '{"channel":"C"}')`, [id, `v${id}`, title]);
    db.run(`INSERT INTO youtube_videos (video_id, title, channel_title, url, markdown_summary, analysis_json, transcript_text, playlist_item_id)
            VALUES (?, ?, ?, 'u', '', '{}', 'transcript text', ?)`, [`v${id}`, title, source === "wl" ? "WL-channel" : "C", source === "wl" ? "PL" : null]);
    if (source === "disc") db.run(`INSERT INTO discovery_candidates (video_id, source, duration_seconds) VALUES (?, 'search', 600)`, [`v${id}`]);
    db.run(`INSERT INTO discover_item_groups (atlas_item_id, group_id) VALUES (?, ?)`, [id, group]);
  };
  item(1, "Revenge story", 1);
  item(2, "Harness engineering", 2);
  item(3, "Another revenge story", 1);
  item(4, "Agent harness deep dive", 2);
  item(5, "Ambiguous clip", 1, "wl");
  item(6, "Rated later by David", 1);
  db.run(`INSERT INTO discover_feedback (atlas_item_id, group_id, sentiment, reasons_json, note) VALUES (1, 1, 'not_interested', '["Formulaic revenge trope"]', NULL)`);
  db.run(`INSERT INTO discover_feedback (atlas_item_id, group_id, sentiment, reasons_json, note) VALUES (2, 2, 'interested', '["Exactly my interest"]', 'more like this')`);
  db.run(`INSERT INTO discover_feedback (atlas_item_id, group_id, sentiment, reasons_json) VALUES (6, 1, 'skipped', '["skipped"]')`);
  return db;
}

/** Guard: any write to a training-signal table aborts the statement. */
function lockTrainingTables(db: Database): void {
  for (const t of ["discover_feedback", "feedback_log"]) {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TEMP TRIGGER no_${op.toLowerCase()}_${t} BEFORE ${op} ON main.${t}
               BEGIN SELECT RAISE(ABORT, 'triage wrote ${t}'); END`);
    }
  }
}

function fakeClient(): TriageClient & { payloads: Payload[] } {
  const payloads: Payload[] = [];
  const answer = (title: string): Record<string, RawAnswer> => {
    if (/revenge/i.test(title)) {
      return {
        decision: { choice: "not_interested", probabilities: { not_interested: 0.95, interested: 0.01, unsure: 0.04 } },
        closest_rejected: { choice: "r_1" },
        closest_liked: { choice: "none" },
        protected_interest: { noul: 0.02 },
      };
    }
    if (/harness/i.test(title)) {
      return {
        decision: { choice: "interested", probabilities: { not_interested: 0.02, interested: 0.9, unsure: 0.08 } },
        closest_rejected: { choice: "none" },
        closest_liked: { choice: "l_2" },
        protected_interest: { noul: 0.9 },
      };
    }
    return {
      decision: { choice: "not_interested", probabilities: { not_interested: 0.9, interested: 0.02, unsure: 0.08 } },
      protected_interest: { noul: 0.1 },
    };
  };
  return {
    model: "test-model",
    payloads,
    askMany: async (ps: Payload[]) => {
      payloads.push(...ps);
      return ps.map((p) => ({
        answers: answer(String(((p.state as { item: { title: string } }).item).title)),
        source: "cache",
        cost: 0,
        inputTokens: 0,
        model: "test-model",
      }) as JevResult);
    },
  };
}

describe("triageDiscover", () => {
  it("builds the rubric from latest non-skip ratings", () => {
    const db = fixture();
    const r = loadRubric(db);
    expect(r.map((e) => [e.atlasId, e.verdict])).toEqual([[1, "not_interested"], [2, "interested"]]);
    expect(r[1].note).toBe("more like this");
    const qs = buildQuestions(r);
    expect(Object.keys((qs.payloadFor(r[0]).questions.closest_rejected as { criteria: object }).criteria)).toEqual(["r_1", "none"]);
    // Only unrated, eligible items are to do.
    expect(loadTodo(db).map((i) => i.atlasId).sort()).toEqual([3, 4, 5]);
  });

  it("writes only discover_jev_triage and never touches discover_feedback or feedback_log", async () => {
    const db = fixture();
    lockTrainingTables(db);
    const before = db.query(`SELECT * FROM discover_feedback ORDER BY id`).all();
    const client = fakeClient();
    const res = await triageDiscover(db, client, { runId: "run-a" });
    expect(res.errors).toEqual([]);
    expect(db.query(`SELECT * FROM discover_feedback ORDER BY id`).all()).toEqual(before);
    expect((db.query(`SELECT count(*) n FROM feedback_log`).get() as { n: number }).n).toBe(0);
    const rows = db.query(`SELECT atlas_item_id id, decision, reason, run_id FROM discover_jev_triage ORDER BY atlas_item_id`).all() as Array<{ id: number; decision: string; reason: string; run_id: string }>;
    expect(rows.map((r) => [r.id, r.decision])).toEqual([[3, "hide"], [4, "pick"], [5, "unsure"]]);
    expect(rows[0].reason).toContain("Formulaic revenge trope");
    expect(rows[1].reason).toContain("more like this");
    expect(rows.every((r) => r.run_id === "run-a")).toBe(true);
    // The rubric in the Jev state carries David's reasons and notes.
    expect(JSON.stringify(client.payloads[0].state)).toContain("Formulaic revenge trope");
  });

  it("skips items already triaged, and undo removes only its own run", async () => {
    const db = fixture();
    lockTrainingTables(db);
    for (const sql of TRIAGE_DDL) db.exec(sql);
    db.run(`INSERT INTO discover_jev_triage (atlas_item_id, decision, run_id) VALUES (3, 'unsure', 'old')`);
    const client = fakeClient();
    await triageDiscover(db, client, { runId: "run-b" });
    expect(client.payloads.length).toBe(2);
    expect(undoTriage(db, "run-b")).toBe(2);
    expect((db.query(`SELECT run_id FROM discover_jev_triage`).all() as Array<{ run_id: string }>).map((r) => r.run_id)).toEqual(["old"]);
    expect(undoTriage(db, "all")).toBe(1);
  });

  it("re-triages only the matching channel's rows and reports the previous decision", async () => {
    const db = fixture();
    lockTrainingTables(db);
    for (const sql of TRIAGE_DDL) db.exec(sql);
    db.run(`UPDATE youtube_videos SET channel_title = 'CTV News' WHERE video_id = 'v3'`);
    db.run(`INSERT INTO discover_jev_triage (atlas_item_id, decision, run_id) VALUES (3, 'hide', 'old'), (4, 'pick', 'old'), (5, 'unsure', 'old')`);
    const client = fakeClient();
    const res = await triageDiscover(db, client, { runId: "news", retriageChannels: NEWS_CHANNEL_RE });
    expect([...res.previous.entries()]).toEqual([[3, "hide"]]);
    expect(client.payloads.length).toBe(1);
    expect(JSON.stringify(client.payloads[0])).toContain("david_news_rule");
    const rows = db.query(`SELECT atlas_item_id id, run_id FROM discover_jev_triage ORDER BY 1`).all();
    expect(rows).toEqual([{ id: 3, run_id: "news" }, { id: 4, run_id: "old" }, { id: 5, run_id: "old" }]);
  });

  it("dry run writes nothing at all", async () => {
    const db = fixture();
    lockTrainingTables(db);
    const res = await triageDiscover(db, fakeClient(), { dryRun: true });
    expect(res.triaged.length).toBe(3);
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'discover_jev_triage'`).get()).toBeNull();
  });
});
