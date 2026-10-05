// archive.js — tab-archive capture + sweep orchestration. Talks to the
// tab-archive server (default http://localhost:4820) via its
// `_agent-native/actions/*` HTTP surface, using the pure eligibility logic
// in sweep.js and the activity map maintained by tracking.js.
//
// Wired into background.js via initArchiveAlarm() + the "archive-*" message
// branches; see background.js for the glue.

import { selectEligibleTabs, decideClose } from "./sweep.js";
import { getActivityMap, reconcileActivity, pruneClosedTabs } from "./tracking.js";
import {
  getLocalSettings,
  saveLocalSettings,
  getStatus,
  setStatus,
  recordTabFailure,
  clearStaleBackoffEntries,
  callAction,
  resolveSweepSettings,
  testConnection,
} from "./archive-settings.js";

// Settings keys, default settings, failure-backoff constant, storage helpers
// and the _agent-native server action calls moved to archive-settings.js
// (this file was 513 physical lines; cap 500). The background-facing
// settings functions are re-exported from here (see the export block).

const SWEEP_ALARM_NAME = "tab-archive-sweep";
const SWEEP_PERIOD_MINUTES = 30;
const IDLE_THRESHOLD_SECONDS = 300;
const MAX_INNER_TEXT = 500_000;
const TAB_SETTLE_MS = 800;
const TAB_LOAD_TIMEOUT_MS = 20_000;

// Mirrors apps/tab-archive/server/lib/tabs.ts DEFAULT_SENSITIVE_PATTERNS.
// Defense in depth: the server re-checks independently (ISC-4), but we never
// even attach a screenshot/innerText for these client-side.
const SENSITIVE_HOST_PATTERNS = [
  // Webmail
  /(^|\.)mail\.google\.com$/i,
  /(^|\.)outlook\.(live|office)\.com$/i,
  /(^|\.)mail\.(yahoo|proton|zoho)\.com$/i,
  /(^|\.)protonmail\.com$/i,
  /(^|\.)fastmail\.com$/i,
  // Banks / brokerages / payments
  /(^|\.)scotiabank\.com$/i,
  /(^|\.)scotiaonline\.scotiabank\.com$/i,
  /(^|\.)rbcroyalbank\.com$/i,
  /(^|\.)td\.com$/i,
  /(^|\.)bmo\.com$/i,
  /(^|\.)cibc\.com$/i,
  /(^|\.)tangerine\.ca$/i,
  /(^|\.)wise\.com$/i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)wealthsimple\.com$/i,
  /(^|\.)questrade\.com$/i,
  /(^|\.)interactivebrokers\.(com|ca)$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/(login|signin|sign-in|signup|sign-up|auth|oauth|sso|password|checkout|payment|billing)(\/|$|\?)/i,
];

function isSensitiveUrl(rawUrl, extraDomains) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  for (const pattern of SENSITIVE_HOST_PATTERNS) {
    if (pattern.test(host)) return true;
  }
  for (const domain of extraDomains || []) {
    const d = String(domain || "").toLowerCase().trim();
    if (d && (host === d || host.endsWith(`.${d}`))) return true;
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(u.pathname + u.search)) return true;
  }
  return false;
}

// ---- capture ------------------------------------------------------------

function tabsQuery(query) {
  return new Promise((resolve) => chrome.tabs.query(query, (tabs) => resolve(tabs || [])));
}

function tabsGet(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(chrome.runtime.lastError ? null : tab);
    });
  });
}

function tabsUpdate(tabId, updateProps) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, updateProps, (tab) => {
      void chrome.runtime.lastError;
      resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for the tab to reach status "complete", then settle briefly so late
 * JS-rendered content has a chance to paint. Capped at TAB_LOAD_TIMEOUT_MS —
 * on timeout we capture anyway rather than lose the tab to a slow page. */
async function waitForTabReady(tabId) {
  const deadline = Date.now() + TAB_LOAD_TIMEOUT_MS;
  // Fast path: already complete.
  const initial = await tabsGet(tabId);
  if (initial && initial.status === "complete") {
    await sleep(TAB_SETTLE_MS);
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
  });
  await sleep(TAB_SETTLE_MS);
}

function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 }, (dataUrl) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(dataUrl);
    });
  });
}

function extractPageContent(tabId) {
  return new Promise((resolve) => {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: () => {
          const meta = document.querySelector('meta[name="description"]');
          return {
            innerText: (document.body && document.body.innerText || "").slice(0, 500000),
            description: meta ? meta.getAttribute("content") || "" : "",
            title: document.title || "",
          };
        },
      },
      (results) => {
        if (chrome.runtime.lastError || !results || !results[0]) {
          resolve({ innerText: "", description: "", title: "" });
        } else {
          resolve(results[0].result || { innerText: "", description: "", title: "" });
        }
      },
    );
  });
}

/** VIVALDI SPIKE: Vivaldi stashes workspace/group metadata on the tab object
 * as a JSON string in `vivExtData` (undocumented, Vivaldi-only). Best-effort
 * read; absent or unparsable on any non-Vivaldi browser or older builds. */
function readVivExtData(tab) {
  const raw = tab && tab.vivExtData;
  if (typeof raw !== "string" || !raw.trim()) {
    return { found: false, workspaceId: undefined, group: undefined };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      found: true,
      workspaceId:
        parsed.workspaceId != null
          ? String(parsed.workspaceId)
          : parsed.workspace != null
            ? String(parsed.workspace)
            : undefined,
      group: parsed.group != null ? String(parsed.group) : undefined,
      raw: parsed,
    };
  } catch {
    return { found: true, workspaceId: undefined, group: undefined, unparsable: true };
  }
}

async function captureAndArchiveTab(tab, local, serverSettings) {
  const excluded = isSensitiveUrl(tab.url, serverSettings && serverSettings.excludedDomains);

  let screenshotDataUrl;
  let content = { innerText: "", description: "", title: tab.title || "" };
  if (!excluded) {
    await waitForTabReady(tab.id).catch(() => undefined);
    try {
      screenshotDataUrl = await captureVisibleTab(tab.windowId);
    } catch {
      screenshotDataUrl = undefined;
    }
    content = await extractPageContent(tab.id);
  }

  const freshTab = (await tabsGet(tab.id)) || tab;
  const viv = readVivExtData(freshTab);

  const payload = {
    url: tab.url,
    title: content.title || tab.title || "",
    description: excluded ? undefined : content.description || undefined,
    innerText: excluded ? undefined : (content.innerText || "").slice(0, MAX_INNER_TEXT),
    screenshotDataUrl: excluded ? undefined : screenshotDataUrl,
    favIconUrl: freshTab.favIconUrl || undefined,
    workspaceId: viv.workspaceId,
    windowId: String(tab.windowId),
    stackId:
      typeof freshTab.groupId === "number" && freshTab.groupId >= 0
        ? String(freshTab.groupId)
        : undefined,
    pinned: Boolean(tab.pinned),
    source: "extension",
    excluded,
  };

  const response = await callAction(local, "archive-tab", { body: payload });
  return response;
}

/** Sweeps eligible tabs: activate -> capture -> POST -> close only if
 * decideClose() says so -> restore the window's previously-active tab.
 * A per-tab failure is caught and backed off; it never aborts the sweep. */
async function sweepOnce() {
  const local = await getLocalSettings();
  const serverSettings = await resolveSweepSettings(local);
  if (!serverSettings) {
    await setStatus({ lastError: "No usable settings (server + cache both unavailable) — sweep skipped." });
    return { skipped: true, reason: "no-settings" };
  }

  if (serverSettings.requireIdle) {
    const idleState = await new Promise((resolve) =>
      chrome.idle.queryState(IDLE_THRESHOLD_SECONDS, resolve),
    );
    if (idleState !== "idle") {
      return { skipped: true, reason: "not-idle" };
    }
  }

  const allTabs = await tabsQuery({});
  await reconcileActivity(allTabs);
  await pruneClosedTabs(allTabs.map((t) => t.id).filter((id) => typeof id === "number"));

  const activity = await getActivityMap();
  const backoff = await clearStaleBackoffEntries(
    allTabs.map((t) => t.id).filter((id) => typeof id === "number"),
  );
  const now = Date.now();

  const plainTabs = allTabs.map((t) => ({
    id: t.id,
    url: t.url || "",
    pinned: Boolean(t.pinned),
    audible: Boolean(t.audible),
    active: Boolean(t.active),
    windowId: t.windowId,
  }));

  const { eligible } = selectEligibleTabs(plainTabs, activity, serverSettings, now);
  const swept = eligible.filter((t) => !backoff[t.id] || backoff[t.id] <= now);

  let closedCount = 0;
  for (const tab of swept) {
    let previouslyActive = null;
    try {
      const activeInWindow = await tabsQuery({ active: true, windowId: tab.windowId });
      previouslyActive = activeInWindow[0] || null;

      await tabsUpdate(tab.id, { active: true });
      const response = await captureAndArchiveTab(tab, local, serverSettings);

      if (decideClose(response)) {
        await tabsRemove(tab.id);
        closedCount += 1;
      }
    } catch (err) {
      await recordTabFailure(tab.id);
      console.warn("[tab-archive] sweep failed for tab", tab.id, err);
    } finally {
      if (previouslyActive && previouslyActive.id !== tab.id) {
        const stillOpen = await tabsGet(previouslyActive.id);
        if (stillOpen) await tabsUpdate(previouslyActive.id, { active: true });
      }
    }
  }

  await setStatus({
    lastSweepAt: new Date().toISOString(),
    lastSweepCount: closedCount,
    lastError: null,
  });

  return { skipped: false, eligibleCount: swept.length, closedCount };
}

let sweepInFlight = null;
function runSweep() {
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = sweepOnce().finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

function initArchiveAlarm() {
  chrome.alarms.create(SWEEP_ALARM_NAME, { periodInMinutes: SWEEP_PERIOD_MINUTES });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SWEEP_ALARM_NAME) {
      runSweep().catch((err) => console.warn("[tab-archive] sweep error", err));
    }
  });
}

// ---- popup-facing actions ----------------------------------------------

async function searchArchivedTabs(query, limit = 20) {
  const local = await getLocalSettings();
  const res = await callAction(local, "search-tabs", {
    method: "GET",
    query: { query, limit: String(limit) },
  });
  if (!res.ok) {
    throw new Error((res.body && res.body.error) || `search-tabs failed (${res.status})`);
  }
  return res.body;
}

async function restoreArchivedTab(id) {
  const local = await getLocalSettings();
  const res = await callAction(local, "restore-tab", { body: { id } });
  if (!res.ok || !res.body || !res.body.url) {
    throw new Error((res.body && res.body.error) || `restore-tab failed (${res.status})`);
  }
  return res.body;
}

export {
  getLocalSettings,
  saveLocalSettings,
  getStatus,
  testConnection,
  initArchiveAlarm,
  runSweep,
  searchArchivedTabs,
  restoreArchivedTab,
  isSensitiveUrl,
  readVivExtData,
};
