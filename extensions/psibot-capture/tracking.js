// tracking.js — per-tab activity tracking for the tab-archive sweep.
// Persists {[tabId]: {url, lastActiveAt}} in chrome.storage.local under
// STORAGE_KEY. Chrome-API-dependent (unlike sweep.js), wired into
// background.js via initTracking().

const STORAGE_KEY = "tabActivity";

function nowIso() {
  return new Date().toISOString();
}

function getActivityMap() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve((data && data[STORAGE_KEY]) || {});
    });
  });
}

function setActivityMap(map) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: map }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/** Mark a tab as just-active-now. Called on activation, load-complete, and
 * window focus change. */
async function touchTab(tabId, url) {
  if (typeof tabId !== "number") return;
  const map = await getActivityMap();
  const prior = map[tabId];
  map[tabId] = { url: url || (prior && prior.url) || "", lastActiveAt: nowIso() };
  await setActivityMap(map);
}

/** Seed a tab the first time we see it (e.g. worker startup), using
 * tab.lastAccessed when Chrome provides it, else "now". Never overwrites an
 * existing record. */
async function seedTab(tab) {
  if (typeof tab.id !== "number") return;
  const map = await getActivityMap();
  if (map[tab.id]) return;
  const lastActiveAt = tab.lastAccessed
    ? new Date(tab.lastAccessed).toISOString()
    : nowIso();
  map[tab.id] = { url: tab.url || "", lastActiveAt };
  await setActivityMap(map);
}

async function pruneClosedTabs(openTabIds) {
  const map = await getActivityMap();
  const openSet = new Set(openTabIds);
  let changed = false;
  for (const key of Object.keys(map)) {
    if (!openSet.has(Number(key))) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) await setActivityMap(map);
}

/**
 * On worker/browser restart, tab ids can get reassigned. Re-key the
 * activity map by matching URL against currently open tabs, KEEPING THE
 * OLDER of the two timestamps whenever both an id-match and a url-match
 * exist for the same tab — reconciliation must never make a tab look
 * fresher than it actually is.
 */
async function reconcileActivity(openTabs) {
  const map = await getActivityMap();

  // Oldest record per URL, so a reassigned id can still find its history.
  const oldestByUrl = new Map();
  for (const record of Object.values(map)) {
    if (!record || !record.url) continue;
    const existing = oldestByUrl.get(record.url);
    if (!existing || toMs(record.lastActiveAt) < toMs(existing.lastActiveAt)) {
      oldestByUrl.set(record.url, record);
    }
  }

  const nextMap = {};
  for (const tab of openTabs) {
    if (typeof tab.id !== "number") continue;
    const byId = map[tab.id];
    const byUrl = tab.url ? oldestByUrl.get(tab.url) : undefined;

    let record;
    if (byId && byUrl) {
      record = toMs(byId.lastActiveAt) <= toMs(byUrl.lastActiveAt) ? byId : byUrl;
    } else {
      record = byId || byUrl;
    }

    nextMap[tab.id] = record
      ? { url: tab.url || record.url, lastActiveAt: record.lastActiveAt }
      : {
          url: tab.url || "",
          lastActiveAt: tab.lastAccessed
            ? new Date(tab.lastAccessed).toISOString()
            : nowIso(),
        };
  }

  await setActivityMap(nextMap);
}

function toMs(value) {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? Infinity : ms;
}

/** Wire up the listeners. Call once from background.js at service-worker
 * startup (safe to call multiple times — listeners are idempotent per Chrome
 * semantics for the lifetime of the worker instance). */
function initTracking() {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      touchTab(tabId, tab.url);
    });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") {
      touchTab(tabId, tab.url);
    }
  });

  chrome.windows.onFocusChanged.addListener((windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs.query({ active: true, windowId }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && typeof tab.id === "number") touchTab(tab.id, tab.url);
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    getActivityMap().then((map) => {
      if (map[tabId] !== undefined) {
        delete map[tabId];
        setActivityMap(map);
      }
    });
  });

  // Startup seed + reconcile: safe no-ops on a fresh install (empty map).
  chrome.tabs.query({}, (tabs) => {
    const list = tabs || [];
    Promise.all(list.map((tab) => seedTab(tab)))
      .then(() => reconcileActivity(list))
      .then(() => pruneClosedTabs(list.map((t) => t.id).filter((id) => typeof id === "number")))
      .catch(() => undefined);
  });
}

export {
  STORAGE_KEY,
  getActivityMap,
  setActivityMap,
  touchTab,
  seedTab,
  pruneClosedTabs,
  reconcileActivity,
  initTracking,
};
