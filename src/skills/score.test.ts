import { describe, expect, test } from "bun:test";
import { computeScore, latestRealActivity } from "./score.ts";
import type { SkillUsageRecord } from "./types.ts";

const NOW = new Date("2026-07-04T12:00:00Z");
const OPTS = { halfLifeDays: 21, now: NOW };

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 3600 * 1000).toISOString();
}

function rec(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    created_by: null,
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: daysAgo(365),
    state: "active",
    pinned: false,
    archived_at: null,
    events: [],
    verdicts: { helped: 0, neutral: 0, misled: 0 },
    first_exposed_at: null,
    last_verified_at: null,
    needs_review: false,
    tier: "cold",
    score: 0,
    export_approved: false,
    exported: null,
    ...overrides,
  };
}

describe("computeScore", () => {
  test("a use today scores ~1.0", () => {
    const r = rec({ events: [{ kind: "use", at: daysAgo(0), actor: "workflow" }] });
    expect(computeScore(r, OPTS)).toBeCloseTo(1.0, 5);
  });

  test("a use one half-life ago scores ~0.5", () => {
    const r = rec({ events: [{ kind: "use", at: daysAgo(21), actor: "workflow" }] });
    expect(computeScore(r, OPTS)).toBeCloseTo(0.5, 5);
  });

  test("maintenance events carry zero weight", () => {
    const r = rec({
      events: [
        { kind: "view", at: daysAgo(0), actor: "maintenance" },
        { kind: "patch", at: daysAgo(0), actor: "maintenance" },
      ],
    });
    // Only the (long-decayed) new-skill boost remains — effectively zero.
    expect(computeScore(r, OPTS)).toBeLessThan(1e-6);
  });

  test("hub events count like real uses", () => {
    const r = rec({ events: [{ kind: "use", at: daysAgo(0), actor: "hub" }] });
    expect(computeScore(r, OPTS)).toBeCloseTo(1.0, 5);
  });

  test("new-skill boost: brand-new unused skill scores ~0.5 (capped below one real use), fades by 2 weeks", () => {
    expect(computeScore(rec({ created_at: daysAgo(0) }), OPTS)).toBeCloseTo(0.5, 3);
    expect(computeScore(rec({ created_at: daysAgo(14) }), OPTS)).toBeCloseTo(0.25, 3);
    expect(computeScore(rec({ created_at: daysAgo(90) }), OPTS)).toBeLessThan(0.02);
  });

  test("skill-4: a skill with real usage history outranks an untried brand-new skill", () => {
    const untried = rec({ created_at: daysAgo(0) }); // fresh, boost-only
    const used = rec({
      created_at: daysAgo(365),
      events: [{ kind: "use", at: daysAgo(10), actor: "workflow" }],
    });
    expect(computeScore(used, OPTS)).toBeGreaterThan(computeScore(untried, OPTS));
  });

  test("legacy-only record: counts+timestamps score without any events, capped", () => {
    const heavy = rec({ view_count: 50, last_viewed_at: daysAgo(0) });
    const oneUse = rec({ use_count: 1, last_used_at: daysAgo(0) });
    // 50 stale-ish views (capped at 5x0.15=0.75) must not outrank one real use (1.0).
    expect(computeScore(heavy, OPTS)).toBeLessThan(computeScore(oneUse, OPTS));
    expect(computeScore(heavy, OPTS)).toBeGreaterThan(0);
  });

  test("events-only record: legacy counters at zero contribute nothing beyond the event log", () => {
    const r = rec({
      use_count: 0,
      patch_count: 0,
      view_count: 0,
      events: [{ kind: "use", at: daysAgo(0), actor: "workflow" }],
    });
    expect(computeScore(r, OPTS)).toBeCloseTo(1.0 + 0.5 * Math.pow(2, -365 / 14), 5);
  });

  test("skill-1: mixed record — maintenance-only events must not zero out legacy usage " +
    "(docker-smart-home-setup regression: 2 real uses + 42 patches, only maintenance events)", () => {
    const r = rec({
      use_count: 2,
      last_used_at: daysAgo(52),
      patch_count: 42,
      last_patched_at: daysAgo(52),
      events: [
        { kind: "patch", at: daysAgo(1), actor: "maintenance" },
        { kind: "view", at: daysAgo(0), actor: "maintenance" },
      ],
    });
    // Before the fix, events.length > 0 switched to eventScore() exclusively,
    // and maintenance events weigh zero, so this scored ~0 (plus a long-decayed
    // new-skill boost). The legacy use/patch history must survive.
    expect(computeScore(r, OPTS)).toBeGreaterThan(0.5);
  });

  test("mixed record: legacy counters at/after the earliest real event are not double-counted", () => {
    const r = rec({
      use_count: 3,
      last_used_at: daysAgo(0),
      events: [{ kind: "use", at: daysAgo(0), actor: "workflow" }],
    });
    // The real event alone already scores ~1.0 (plus the long-decayed boost);
    // overlapping legacy counter activity must not stack an extra contribution.
    expect(computeScore(r, OPTS)).toBeCloseTo(1.0 + 0.5 * Math.pow(2, -365 / 14), 5);
  });
});

describe("latestRealActivity", () => {
  test("ignores maintenance events", () => {
    const r = rec({
      events: [
        { kind: "use", at: daysAgo(30), actor: "workflow" },
        { kind: "view", at: daysAgo(1), actor: "maintenance" },
      ],
    });
    expect(latestRealActivity(r)?.toISOString()).toBe(daysAgo(30));
  });

  test("null when only maintenance activity exists", () => {
    const r = rec({ events: [{ kind: "view", at: daysAgo(1), actor: "maintenance" }] });
    expect(latestRealActivity(r)).toBeNull();
  });

  test("skill-1: anchors to legacy last_used_at when events are maintenance-only " +
    "(same regression class as computeScore — events.length > 0 must not hide legacy usage)", () => {
    const r = rec({
      use_count: 2,
      last_used_at: daysAgo(52),
      patch_count: 42,
      last_patched_at: daysAgo(52),
      events: [
        { kind: "patch", at: daysAgo(1), actor: "maintenance" },
        { kind: "view", at: daysAgo(0), actor: "maintenance" },
      ],
    });
    // Before the fix, events.length > 0 switched to the event-only branch,
    // and with all events maintenance-only latestRealActivity returned null —
    // ignoring the real legacy usage and mis-anchoring the idle clock.
    expect(latestRealActivity(r)?.toISOString()).toBe(daysAgo(52));
  });

  test("takes the max when a real event is newer than legacy timestamps", () => {
    const r = rec({
      use_count: 5,
      last_used_at: daysAgo(60),
      events: [{ kind: "use", at: daysAgo(5), actor: "workflow" }],
    });
    expect(latestRealActivity(r)?.toISOString()).toBe(daysAgo(5));
  });
});
