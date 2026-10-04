// sweep.js — PURE logic for the tab-archive sweep. No chrome.* APIs here on
// purpose: this file must stay unit-testable in isolation (see
// sweep.test.js) and is the single place that encodes the tab-archive safety
// invariants (ISC-1..4 from apps/tab-archive/ISA.md):
//
//   ISC-1 Durable capture — a tab is only closed on HTTP 200 + a row id.
//   ISC-2 Age invariant   — untouched-too-long tabs are eligible.
//   ISC-3 Budget invariant — oldest-first once over the open-tab budget.
//   ISC-4 Privacy exclusion — handled in archive.js (client-side check +
//         server-side blocklist do their own thing); this file only decides
//         *which tabs* get swept, not what gets sent for them.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isHttpUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function matchesExcludedDomain(url, excludedDomains) {
  const host = hostnameOf(url);
  if (!host) return false;
  return (excludedDomains || []).some((raw) => {
    const domain = String(raw || "").toLowerCase().trim();
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function toMs(value) {
  if (typeof value === "number") return value;
  if (!value) return NaN;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? NaN : parsed;
}

/** Age in days. Tabs with no tracked activity are treated as maximally old
 * (never touched since we started tracking) rather than skipped, so a tab
 * that predates tracking still eventually gets swept. */
function ageDays(now, lastActiveAt) {
  const last = toMs(lastActiveAt);
  if (Number.isNaN(last)) return Infinity;
  return (now - last) / MS_PER_DAY;
}

/**
 * Select which open tabs are eligible for this sweep.
 *
 * @param {Array<{id:number,url:string,pinned?:boolean,audible?:boolean,active?:boolean,windowId:number}>} tabs
 *   All currently open tabs (every window).
 * @param {Record<string|number,{url:string,lastActiveAt:string|number}>} activity
 *   tabId -> tracked activity record (see tracking.js).
 * @param {{archiveAfterDays:number,tabBudget:number,sweepBatchLimit:number,excludedDomains?:string[]}} settings
 * @param {number} now - ms epoch, injected so tests are deterministic.
 * @returns {{eligible: Array<object>, flaggedLastTab: Array<object>}}
 *   `eligible` is capped at settings.sweepBatchLimit, oldest first.
 *   `flaggedLastTab` holds tabs that would otherwise be eligible but are the
 *   sole remaining tab in their window — never auto-closed; each carries
 *   `needsBlankTab: true` so a caller could open about:blank first if it ever
 *   wants to sweep them (v1 just leaves them open, ISC-safe by construction).
 */
function selectEligibleTabs(tabs, activity, settings, now) {
  const excludedDomains = settings.excludedDomains || [];

  const windowTabCounts = new Map();
  for (const tab of tabs) {
    windowTabCounts.set(tab.windowId, (windowTabCounts.get(tab.windowId) || 0) + 1);
  }

  const candidates = [];
  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (tab.audible) continue;
    if (tab.active) continue; // active-in-window is never swept
    if (!isHttpUrl(tab.url)) continue;
    if (matchesExcludedDomain(tab.url, excludedDomains)) continue;

    const record = activity[tab.id];
    const lastActiveAt = record ? record.lastActiveAt : undefined;
    const age = ageDays(now, lastActiveAt);
    const lastActiveAtMs = toMs(lastActiveAt);
    candidates.push({
      tab,
      age,
      // Untracked tabs sort as oldest-of-all (-Infinity) so the budget rule
      // reclaims them first, matching "treat as maximally old" above.
      lastActiveAtMs: Number.isNaN(lastActiveAtMs) ? -Infinity : lastActiveAtMs,
    });
  }

  // Age rule: strictly older than the configured retention window.
  const byAge = candidates.filter((c) => c.age > settings.archiveAfterDays);

  // Budget rule: total OPEN tabs (not just candidates) over budget pulls in
  // the oldest candidates first, exactly enough to close the gap.
  let byBudget = [];
  const totalOpen = tabs.length;
  if (totalOpen > settings.tabBudget) {
    const overBudgetCount = totalOpen - settings.tabBudget;
    const sortedByAge = [...candidates].sort((a, b) => a.lastActiveAtMs - b.lastActiveAtMs);
    byBudget = sortedByAge.slice(0, overBudgetCount);
  }

  const merged = new Map();
  for (const c of [...byAge, ...byBudget]) merged.set(c.tab.id, c);
  const sortedMerged = [...merged.values()].sort((a, b) => a.lastActiveAtMs - b.lastActiveAtMs);

  const eligible = [];
  const flaggedLastTab = [];
  for (const c of sortedMerged) {
    const isLastTabOfWindow = windowTabCounts.get(c.tab.windowId) === 1;
    if (isLastTabOfWindow) {
      flaggedLastTab.push({ ...c.tab, needsBlankTab: true });
      continue;
    }
    if (eligible.length >= settings.sweepBatchLimit) break;
    eligible.push(c.tab);
  }

  return { eligible, flaggedLastTab };
}

/**
 * ISC-1: a tab is closed ONLY if the archive-tab call returned HTTP 200 with
 * a non-empty string `id`. `deduped: true` still closes — a dedup response
 * still proves a durable row exists for this URL. Any other outcome (network
 * error, non-200, missing/empty id) must never close the tab.
 *
 * @param {{status?: number, body?: {id?: unknown, deduped?: boolean}} | null | undefined} response
 */
function decideClose(response) {
  if (!response) return false;
  if (response.status !== 200) return false;
  const id = response.body && response.body.id;
  return typeof id === "string" && id.length > 0;
}

/**
 * "No settings → no sweep" guard: a sweep must never run against defaults
 * alone. Both a fresh server fetch AND a cached fallback missing means skip
 * entirely this cycle.
 *
 * @param {object | null | undefined} settings
 */
function hasUsableSettings(settings) {
  if (!settings || typeof settings !== "object") return false;
  return (
    typeof settings.archiveAfterDays === "number" &&
    typeof settings.tabBudget === "number" &&
    typeof settings.sweepBatchLimit === "number"
  );
}

export {
  selectEligibleTabs,
  decideClose,
  hasUsableSettings,
  ageDays,
  isHttpUrl,
  matchesExcludedDomain,
  hostnameOf,
};
