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

  test("new-skill boost: brand-new unused skill scores ~1.0, fades by 2 weeks", () => {
    expect(computeScore(rec({ created_at: daysAgo(0) }), OPTS)).toBeCloseTo(1.0, 3);
    expect(computeScore(rec({ created_at: daysAgo(14) }), OPTS)).toBeCloseTo(0.5, 3);
    expect(computeScore(rec({ created_at: daysAgo(90) }), OPTS)).toBeLessThan(0.02);
  });

  test("legacy fallback: counts+timestamps score without events, capped", () => {
    const heavy = rec({ view_count: 50, last_viewed_at: daysAgo(0) });
    const oneUse = rec({ use_count: 1, last_used_at: daysAgo(0) });
    // 50 stale-ish views (capped at 5x0.15=0.75) must not outrank one real use (1.0).
    expect(computeScore(heavy, OPTS)).toBeLessThan(computeScore(oneUse, OPTS));
    expect(computeScore(heavy, OPTS)).toBeGreaterThan(0);
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
});
