import { describe, it, expect } from "bun:test";
import { selectEligibleTabs, decideClose, hasUsableSettings, ageDays } from "./sweep.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-21T12:00:00.000Z").getTime();

function baseSettings(overrides = {}) {
  return {
    archiveAfterDays: 14,
    tabBudget: 50,
    sweepBatchLimit: 10,
    excludedDomains: [],
    requireIdle: true,
    ...overrides,
  };
}

function daysAgo(n) {
  return new Date(NOW - n * DAY_MS).toISOString();
}

function tab(id, url, overrides = {}) {
  return { id, url, pinned: false, audible: false, active: false, windowId: 1, ...overrides };
}

function activity(entries) {
  const map = {};
  for (const [id, lastActiveAt] of entries) {
    map[id] = { url: `https://example.com/${id}`, lastActiveAt };
  }
  return map;
}

// Windows always have an active tab in real browser usage; a lone
// background candidate in an otherwise-empty window would trip the
// last-tab-of-window guard, which is a separate concern tested below. Give
// single-candidate tests company via an anchor active tab in the same
// window so they isolate the rule actually under test.
function anchorTab(windowId = 1) {
  return tab(-windowId, `https://anchor.example.com/${windowId}`, { windowId, active: true });
}

describe("selectEligibleTabs — age rule (ISC-2)", () => {
  it("selects a tab older than archiveAfterDays", () => {
    const tabs = [tab(1, "https://example.com/1"), anchorTab()];
    const act = activity([[1, daysAgo(20)]]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible.map((t) => t.id)).toEqual([1]);
  });

  it("does not select a tab younger than archiveAfterDays", () => {
    const tabs = [tab(1, "https://example.com/1"), anchorTab()];
    const act = activity([[1, daysAgo(5)]]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible).toEqual([]);
  });

  it("treats an untracked tab (no activity record) as maximally old", () => {
    const tabs = [tab(1, "https://example.com/1"), anchorTab()];
    const { eligible } = selectEligibleTabs(tabs, {}, baseSettings(), NOW);
    expect(eligible.map((t) => t.id)).toEqual([1]);
  });

  it("is exactly at the boundary (not > archiveAfterDays) — not eligible", () => {
    const tabs = [tab(1, "https://example.com/1"), anchorTab()];
    const act = activity([[1, daysAgo(14)]]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings({ archiveAfterDays: 14 }), NOW);
    expect(eligible).toEqual([]);
  });
});

describe("selectEligibleTabs — budget rule, oldest first (ISC-3)", () => {
  it("selects only the oldest tabs beyond budget when total open exceeds it", () => {
    // All in one window so the last-tab-of-window rule (tested separately)
    // never engages here.
    const tabs = [1, 2, 3, 4, 5].map((n) => tab(n, `https://example.com/${n}`, { windowId: 1 }));
    // Ages: 1 is oldest ... 5 is newest, all under the 14-day age rule.
    const act = activity([
      [1, daysAgo(10)],
      [2, daysAgo(8)],
      [3, daysAgo(6)],
      [4, daysAgo(4)],
      [5, daysAgo(2)],
    ]);
    const settings = baseSettings({ tabBudget: 3, archiveAfterDays: 14 });
    const { eligible } = selectEligibleTabs(tabs, act, settings, NOW);
    // 5 open, budget 3 -> 2 oldest must go: tabs 1 and 2.
    expect(eligible.map((t) => t.id)).toEqual([1, 2]);
  });

  it("does not apply the budget rule when under budget", () => {
    const tabs = [tab(1, "https://example.com/1"), tab(2, "https://example.com/2", { windowId: 1 })];
    const act = activity([
      [1, daysAgo(1)],
      [2, daysAgo(1)],
    ]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings({ tabBudget: 50 }), NOW);
    expect(eligible).toEqual([]);
  });

  it("counts ALL open tabs toward budget, not just candidates", () => {
    // 1 pinned tab + 4 regular tabs = 5 open, one shared window; budget 4 ->
    // exactly 1 over.
    const tabs = [
      tab(1, "https://example.com/1", { pinned: true, windowId: 1 }),
      tab(2, "https://example.com/2", { windowId: 1 }),
      tab(3, "https://example.com/3", { windowId: 1 }),
      tab(4, "https://example.com/4", { windowId: 1 }),
      tab(5, "https://example.com/5", { windowId: 1 }),
    ];
    const act = activity([
      [2, daysAgo(10)],
      [3, daysAgo(8)],
      [4, daysAgo(6)],
      [5, daysAgo(4)],
    ]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings({ tabBudget: 4 }), NOW);
    expect(eligible.map((t) => t.id)).toEqual([2]);
  });
});

describe("selectEligibleTabs — exclusions", () => {
  it("never selects a pinned tab", () => {
    const tabs = [tab(1, "https://example.com/1", { pinned: true })];
    const act = activity([[1, daysAgo(30)]]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible).toEqual([]);
  });

  it("never selects an audible tab", () => {
    const tabs = [tab(1, "https://example.com/1", { audible: true })];
    const act = activity([[1, daysAgo(30)]]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible).toEqual([]);
  });

  it("never selects the active tab in its window", () => {
    const tabs = [tab(1, "https://example.com/1", { active: true })];
    const act = activity([[1, daysAgo(30)]]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible).toEqual([]);
  });

  it("never selects a non-http(s) scheme (chrome://, file://, about:)", () => {
    const tabs = [
      tab(1, "chrome://extensions"),
      tab(2, "file:///Users/dave/notes.txt", { windowId: 2 }),
      tab(3, "about:blank", { windowId: 3 }),
    ];
    const act = activity([
      [1, daysAgo(30)],
      [2, daysAgo(30)],
      [3, daysAgo(30)],
    ]);
    const { eligible } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible).toEqual([]);
  });

  it("never selects a tab matching an excludedDomains entry (exact host or subdomain)", () => {
    const tabs = [
      tab(1, "https://mail.google.com/mail/u/0", { windowId: 1 }),
      tab(2, "https://sub.bank.example.com/accounts", { windowId: 1 }),
      tab(3, "https://unrelated.com", { windowId: 1 }),
    ];
    const act = activity([
      [1, daysAgo(30)],
      [2, daysAgo(30)],
      [3, daysAgo(30)],
    ]);
    const settings = baseSettings({ excludedDomains: ["mail.google.com", "bank.example.com"] });
    const { eligible } = selectEligibleTabs(tabs, act, settings, NOW);
    expect(eligible.map((t) => t.id)).toEqual([3]);
  });

  it("flags (does not close) the last remaining tab of a window", () => {
    const tabs = [tab(1, "https://example.com/1", { windowId: 1 })];
    const act = activity([[1, daysAgo(30)]]);
    const { eligible, flaggedLastTab } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible).toEqual([]);
    expect(flaggedLastTab.length).toBe(1);
    expect(flaggedLastTab[0].needsBlankTab).toBe(true);
  });

  it("does NOT flag a tab whose window still has other tabs", () => {
    const tabs = [
      tab(1, "https://example.com/1", { windowId: 1 }),
      tab(2, "https://example.com/2", { windowId: 1, active: true }),
    ];
    const act = activity([[1, daysAgo(30)]]);
    const { eligible, flaggedLastTab } = selectEligibleTabs(tabs, act, baseSettings(), NOW);
    expect(eligible.map((t) => t.id)).toEqual([1]);
    expect(flaggedLastTab).toEqual([]);
  });
});

describe("selectEligibleTabs — batch cap", () => {
  it("caps results at sweepBatchLimit, oldest first", () => {
    const tabs = [1, 2, 3, 4, 5].map((n) => tab(n, `https://example.com/${n}`, { windowId: 1 }));
    const act = activity([
      [1, daysAgo(50)],
      [2, daysAgo(40)],
      [3, daysAgo(30)],
      [4, daysAgo(20)],
      [5, daysAgo(15)],
    ]);
    const settings = baseSettings({ sweepBatchLimit: 2 });
    const { eligible } = selectEligibleTabs(tabs, act, settings, NOW);
    expect(eligible.map((t) => t.id)).toEqual([1, 2]);
  });
});

describe("decideClose — ISC-1 durable capture", () => {
  it("closes on 200 with a non-empty string id", () => {
    expect(decideClose({ status: 200, body: { id: "abc123" } })).toBe(true);
  });

  it("closes on 200 with deduped:true (still an acknowledged durable write)", () => {
    expect(decideClose({ status: 200, body: { id: "abc123", deduped: true } })).toBe(true);
  });

  it("never closes on non-200 status", () => {
    expect(decideClose({ status: 500, body: { id: "abc123" } })).toBe(false);
    expect(decideClose({ status: 404, body: { id: "abc123" } })).toBe(false);
    expect(decideClose({ status: 401, body: { id: "abc123" } })).toBe(false);
  });

  it("never closes on 200 without an id", () => {
    expect(decideClose({ status: 200, body: {} })).toBe(false);
    expect(decideClose({ status: 200, body: { id: "" } })).toBe(false);
    expect(decideClose({ status: 200, body: { id: null } })).toBe(false);
    expect(decideClose({ status: 200, body: { id: 12345 } })).toBe(false);
  });

  it("never closes on a missing/null response (network error)", () => {
    expect(decideClose(null)).toBe(false);
    expect(decideClose(undefined)).toBe(false);
  });

  it("never closes when body is missing entirely", () => {
    expect(decideClose({ status: 200 })).toBe(false);
  });
});

describe("hasUsableSettings — no-settings-no-sweep guard", () => {
  it("rejects null/undefined settings", () => {
    expect(hasUsableSettings(null)).toBe(false);
    expect(hasUsableSettings(undefined)).toBe(false);
  });

  it("rejects settings missing required numeric fields", () => {
    expect(hasUsableSettings({ archiveAfterDays: 14 })).toBe(false);
    expect(hasUsableSettings({})).toBe(false);
  });

  it("accepts a complete settings object", () => {
    expect(
      hasUsableSettings({ archiveAfterDays: 14, tabBudget: 50, sweepBatchLimit: 10 }),
    ).toBe(true);
  });
});

describe("ageDays", () => {
  it("computes fractional days correctly", () => {
    expect(ageDays(NOW, daysAgo(7))).toBeCloseTo(7, 5);
  });

  it("returns Infinity for unparsable/missing timestamps", () => {
    expect(ageDays(NOW, undefined)).toBe(Infinity);
    expect(ageDays(NOW, "not-a-date")).toBe(Infinity);
  });
});
