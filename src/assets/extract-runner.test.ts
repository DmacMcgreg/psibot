import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import {
  processItems, nextWatermark, tsOf, inQuietHours, isHandled, classifyError, resetTransientCounts, TRANSIENT_GRACE, TRANSIENT_STOP,
} from "./extract-runner.ts";
import { getExtraction, getAsset } from "./store.ts";
import { EXTRACT_VERSION } from "./extract.ts";
import type { SourceItem } from "./sources/types.ts";
import type { GateDecision } from "./gate.ts";

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
});
afterAll(() => db.close());

const mk = (ref: string, created_at: string, text = "x".repeat(300)): SourceItem => ({
  source_kind: "tab", source_ref: ref, url: `https://example.com/${ref}`, title: `Item ${ref}`,
  published_at: null, created_at, explicit: false, gate_text: ref, loadText: async () => text,
});

const gate = async (xs: { text: string }[]): Promise<GateDecision[]> =>
  xs.map((x) => ({ score: x.text.startsWith("pass") ? 70 : 10, track: "video", pass: x.text.startsWith("pass"), sim: 0.7, neg: 0.5, kw: 0 }));

describe("processItems", () => {
  it("records gated items, extracts passers, upserts assets and never repeats work", async () => {
    let calls = 0;
    const extract = async () => {
      calls++;
      return {
        model: "mock", note: null, rejected: [],
        assets: [{
          kind: "tool" as const, title: "ffmpeg-ramp CLI for drone speed ramps", url: "https://github.com/acme/ffmpeg-ramp",
          summary: "CLI.", track: "video", value_score: 70, value_reason: "r", next_action: "Install it.", evidence: "quote",
        }],
      };
    };
    const items = [mk("pass-1", "2026-09-20T00:00:00Z"), mk("fail-1", "2026-09-21T00:00:00Z"), mk("pass-2", "2026-09-22T00:00:00Z", "short")];
    const rep = await processItems(items, { maxModelCalls: 5, concurrency: 2, gate, extract });
    expect(rep.gated).toBe(1);
    expect(rep.passed).toBe(2);
    expect(rep.extracted).toBe(1);
    expect(rep.empty).toBe(1); // "short" text never reaches the model
    expect(calls).toBe(1);
    expect(getExtraction("tab", "fail-1", EXTRACT_VERSION)?.status).toBe("gated");
    expect(getExtraction("tab", "pass-1", EXTRACT_VERSION)).toMatchObject({ status: "done", n_assets: 1 });
    const ev = db.query(`SELECT evidence FROM asset_sources WHERE source_ref = 'pass-1'`).get() as { evidence: string };
    expect(ev.evidence).toBe("quote");

    const again = await processItems(items, { maxModelCalls: 5, concurrency: 2, gate, extract });
    expect(again.alreadyHandled).toBe(3);
    expect(calls).toBe(1);
  });

  it("retries failures up to 3 attempts and does not burn attempts on quota errors", async () => {
    const item = mk("pass-flaky", "2026-09-23T00:00:00Z");
    const boom = async () => { throw new Error("model exploded"); };
    for (let i = 0; i < 3; i++) await processItems([item], { maxModelCalls: 1, concurrency: 1, gate, extract: boom });
    expect(getExtraction("tab", "pass-flaky", EXTRACT_VERSION)).toMatchObject({ status: "failed", attempts: 3 });
    expect(isHandled(item)).toBe(true);

    const q = mk("pass-quota", "2026-09-23T00:00:00Z");
    const rep = await processItems([q], { maxModelCalls: 1, concurrency: 1, gate, extract: async () => { throw new Error("429 Too Many Requests"); } });
    expect(rep.quotaStop).toBe(true);
    expect(getExtraction("tab", "pass-quota", EXTRACT_VERSION)).toBeNull();
  });

  it("dismisses assets the extractor marked as already owned", async () => {
    const extract = async () => ({
      model: "mock", note: null, rejected: [],
      assets: [
        {
          kind: "skill" as const, title: "cathrynlavery/diagram-design — diagram skill", url: "https://github.com/cathrynlavery/diagram-design",
          summary: "s", track: "client-sites", value_score: 60, value_reason: "r", next_action: "Install it.", evidence: null,
          details: { owned_reason: "cathrynlavery/diagram-design: diagram-design already installed" },
        },
        {
          kind: "tool" as const, title: "acme/brand-new CLI for landing pages", url: "https://github.com/acme/brand-new",
          summary: "s", track: "client-sites", value_score: 60, value_reason: "r", next_action: "Install it.", evidence: null,
        },
      ],
    });
    const rep = await processItems([mk("pass-owned", "2026-09-24T01:00:00Z")], { maxModelCalls: 1, concurrency: 1, gate, extract });
    expect(rep.created).toBe(2);
    expect(rep.owned).toBe(1);
    const rows = db.query(`SELECT id, status, outcome FROM assets WHERE url IN ('https://github.com/cathrynlavery/diagram-design', 'https://github.com/acme/brand-new') ORDER BY url`).all() as { id: number; status: string; outcome: string | null }[];
    expect(rows.map((r) => r.status)).toEqual(["new", "dismissed"]);
    expect(getAsset(rows[1].id)!.outcome).toBe("dismissed:already_have");
  });

  it("dry run records nothing", async () => {
    const rep = await processItems([mk("pass-dry", "2026-09-24T00:00:00Z")], { maxModelCalls: 5, concurrency: 1, dryRun: true, gate });
    expect(rep.passed).toBe(1);
    expect(getExtraction("tab", "pass-dry", EXTRACT_VERSION)).toBeNull();
  });

  it("defers passers beyond the model-call budget", async () => {
    const items = [mk("pass-a", "2026-09-25T00:00:00Z"), mk("pass-b", "2026-09-25T00:00:01Z")];
    const rep = await processItems(items, { maxModelCalls: 1, concurrency: 1, gate, extract: async () => ({ model: "m", note: null, rejected: [], assets: [] }) });
    expect(rep.deferred).toBe(1);
    expect(getExtraction("tab", "pass-b", EXTRACT_VERSION)).toBeNull();
  });
});

describe("transient model errors", () => {
  it("classifies errors: only item errors spend an attempt", () => {
    const cases: [string, string][] = [
      ["Claude Code returned an error result: API Error: 529 {\"type\":\"overloaded_error\"}", "transient"],
      ["API Error: 500 Internal Server Error", "transient"],
      ["HTTP 503 for https://api.z.ai", "transient"],
      ["The operation was aborted.", "transient"],
      ["Request timed out", "transient"],
      ["fetch failed", "transient"],
      ["read ECONNRESET", "transient"],
      ["Claude Code process exited with code 1", "transient"],
      ["429 Too Many Requests", "service"],
      ["Claude Code returned an error result: You've hit your weekly limit · resets 7am", "service"],
      ["Claude Code returned an error result: Not logged in · Please run /login", "service"],
      ["There's an issue with the selected model (glm-5.3-flash). It may not exist or you may not have access to it.", "service"],
      ["Claude Code returned an error result: Reached maximum number of turns (1)", "item"],
      ["no JSON in reply", "item"],
      ["JSON Parse error: Unexpected token at position 512", "item"],
      ["model exploded", "item"],
    ];
    for (const [msg, want] of cases) expect(`${msg} → ${classifyError(msg)}`).toBe(`${msg} → ${want}`);
  });

  it("retries transient failures next tick without spending an attempt", async () => {
    resetTransientCounts();
    const item = mk("pass-5xx", "2026-09-25T02:00:00Z");
    const rep = await processItems([item], { maxModelCalls: 1, concurrency: 1, gate, extract: async () => { throw new Error("API Error: 529 overloaded"); } });
    expect(rep.transient).toBe(1);
    expect(rep.failed).toBe(0);
    expect(getExtraction("tab", "pass-5xx", EXTRACT_VERSION)).toBeNull();
    expect(isHandled(item)).toBe(false);
    // Next tick the model answers: the item is extracted normally.
    const ok = await processItems([item], { maxModelCalls: 1, concurrency: 1, gate, extract: async () => ({ model: "m", note: "nothing", rejected: [], assets: [] }) });
    expect(ok.empty).toBe(1);
    expect(getExtraction("tab", "pass-5xx", EXTRACT_VERSION)).toMatchObject({ status: "empty", attempts: 1 });
  });

  it("stops the batch after repeated transient errors, like an outage", async () => {
    resetTransientCounts();
    let calls = 0;
    const items = ["pass-o1", "pass-o2", "pass-o3", "pass-o4"].map((r, i) => mk(r, `2026-09-25T03:00:0${i}Z`));
    const rep = await processItems(items, { maxModelCalls: 4, concurrency: 1, gate, extract: async () => { calls++; throw new Error("fetch failed"); } });
    expect(calls).toBe(TRANSIENT_STOP);
    expect(rep.quotaStop).toBe(true);
    expect(rep.stopReason).toBe("fetch failed");
    for (const it of items) expect(getExtraction("tab", it.source_ref, EXTRACT_VERSION)).toBeNull();
  });

  it("counts an item that keeps failing transiently, so it cannot loop forever", async () => {
    resetTransientCounts();
    const item = mk("pass-slow", "2026-09-25T04:00:00Z");
    const timeout = async () => { throw new Error("The operation was aborted."); };
    for (let i = 1; i < TRANSIENT_GRACE; i++) await processItems([item], { maxModelCalls: 1, concurrency: 1, gate, extract: timeout });
    expect(getExtraction("tab", "pass-slow", EXTRACT_VERSION)).toBeNull();
    await processItems([item], { maxModelCalls: 1, concurrency: 1, gate, extract: timeout });
    expect(getExtraction("tab", "pass-slow", EXTRACT_VERSION)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("stops on service errors (quota, auth) without spending attempts", async () => {
    resetTransientCounts();
    const item = mk("pass-login", "2026-09-25T05:00:00Z");
    const rep = await processItems([item], { maxModelCalls: 1, concurrency: 1, gate, extract: async () => { throw new Error("Not logged in · Please run /login"); } });
    expect(rep.quotaStop).toBe(true);
    expect(getExtraction("tab", "pass-login", EXTRACT_VERSION)).toBeNull();
  });
});

describe("watermarks", () => {
  it("parses both timestamp formats as UTC", () => {
    expect(tsOf("2026-09-26 13:10:14")).toBe(Date.parse("2026-09-26T13:10:14Z"));
    expect(tsOf("2026-09-25 22:11:05Z")).toBe(Date.parse("2026-09-25T22:11:05Z"));
    expect(tsOf("2026-07-22T15:15:25.296Z")).toBe(Date.parse("2026-07-22T15:15:25.296Z"));
  });

  it("advances to the newest fully-handled timestamp and keeps same-second bursts together", () => {
    const items = [{ created_at: "a3" }, { created_at: "a1" }, { created_at: "a2" }, { created_at: "a2" }].map((x, i) => ({ created_at: `2026-09-2${x.created_at[1]} 00:00:00`, i }));
    // handled: a1 yes, a2 one of two, a3 yes
    const handled = new Set([0, 1, 2]);
    expect(nextWatermark(items, (i) => handled.has(i), null)).toBe("2026-09-21 00:00:00");
    handled.add(3);
    expect(nextWatermark(items, (i) => handled.has(i), null)).toBe("2026-09-23 00:00:00");
    expect(nextWatermark([], () => true, "keep")).toBe("keep");
  });
});

describe("quiet hours", () => {
  it("is quiet from 23:00 to 07:00 Toronto", () => {
    expect(inQuietHours(new Date("2026-09-26T04:00:00Z"))).toBe(true);  // 00:00 EDT
    expect(inQuietHours(new Date("2026-09-26T10:30:00Z"))).toBe(true);  // 06:30 EDT
    expect(inQuietHours(new Date("2026-09-26T11:00:00Z"))).toBe(false); // 07:00 EDT
    expect(inQuietHours(new Date("2026-09-27T02:59:00Z"))).toBe(false); // 22:59 EDT
    expect(inQuietHours(new Date("2026-09-27T03:00:00Z"))).toBe(true);  // 23:00 EDT
  });
});
