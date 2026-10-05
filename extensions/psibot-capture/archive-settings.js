// archive-settings.js — tab-archive settings/status/backoff storage and the
// _agent-native server action calls, split from archive.js (which was 513
// physical lines; cap 500). archive.js re-exports the background-facing
// surface so background.js keeps its single "./archive.js" import.

import { hasUsableSettings } from "./sweep.js";

const LOCAL_SETTINGS_KEY = "archiveLocalSettings"; // {serverUrl, token}
const SERVER_SETTINGS_CACHE_KEY = "archiveServerSettingsCache"; // last-known get-archive-settings
const FAILURE_BACKOFF_KEY = "archiveFailureBackoff"; // {[tabId]: nextRetryAtMs}
const STATUS_KEY = "archiveSweepStatus"; // {lastSweepAt, lastSweepCount, lastError}

const DEFAULT_LOCAL_SETTINGS = {
  serverUrl: "http://localhost:4820",
  token: "",
};

const FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h — a bad tab can't wedge the sweep

// ---- storage helpers --------------------------------------------------

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => resolve(data || {}));
  });
}

function storageSet(value) {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function getLocalSettings() {
  const data = await storageGet([LOCAL_SETTINGS_KEY]);
  return { ...DEFAULT_LOCAL_SETTINGS, ...(data[LOCAL_SETTINGS_KEY] || {}) };
}

async function saveLocalSettings(partial) {
  const current = await getLocalSettings();
  const next = { ...current, ...partial };
  await storageSet({ [LOCAL_SETTINGS_KEY]: next });
  return next;
}

async function getCachedServerSettings() {
  const data = await storageGet([SERVER_SETTINGS_CACHE_KEY]);
  return data[SERVER_SETTINGS_CACHE_KEY] || null;
}

async function getStatus() {
  const data = await storageGet([STATUS_KEY]);
  return data[STATUS_KEY] || { lastSweepAt: null, lastSweepCount: 0, lastError: null };
}

async function setStatus(partial) {
  const current = await getStatus();
  await storageSet({ [STATUS_KEY]: { ...current, ...partial } });
}

async function getFailureBackoff() {
  const data = await storageGet([FAILURE_BACKOFF_KEY]);
  return data[FAILURE_BACKOFF_KEY] || {};
}

async function recordTabFailure(tabId) {
  const backoff = await getFailureBackoff();
  backoff[tabId] = Date.now() + FAILURE_BACKOFF_MS;
  await storageSet({ [FAILURE_BACKOFF_KEY]: backoff });
}

async function clearStaleBackoffEntries(openTabIds) {
  const backoff = await getFailureBackoff();
  const openSet = new Set(openTabIds);
  let changed = false;
  for (const key of Object.keys(backoff)) {
    if (!openSet.has(Number(key))) {
      delete backoff[key];
      changed = true;
    }
  }
  if (changed) await storageSet({ [FAILURE_BACKOFF_KEY]: backoff });
  return backoff;
}

// ---- server action calls ----------------------------------------------

function actionUrl(serverUrl, name) {
  return `${serverUrl.replace(/\/+$/, "")}/_agent-native/actions/${name}`;
}

async function callAction(local, name, { method = "POST", query, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (local.token) headers.Authorization = `Bearer ${local.token}`;

  let url = actionUrl(local.serverUrl, name);
  if (query) {
    const params = new URLSearchParams(query);
    url += `?${params.toString()}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    cache: "no-store",
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });

  const text = await res.text().catch(() => "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: res.status, ok: res.ok, body: data };
}

async function fetchServerSettings(local) {
  const res = await callAction(local, "get-archive-settings", { method: "GET" });
  if (!res.ok || !res.body) return null;
  return res.body;
}

/** Resolves the settings to sweep with: fresh server fetch, else cached
 * copy, else null (meaning: skip this sweep entirely — never sweep on
 * defaults alone). */
async function resolveSweepSettings(local) {
  try {
    const fresh = await fetchServerSettings(local);
    if (hasUsableSettings(fresh)) {
      await storageSet({ [SERVER_SETTINGS_CACHE_KEY]: fresh });
      return fresh;
    }
  } catch {
    // fall through to cache
  }
  const cached = await getCachedServerSettings();
  return hasUsableSettings(cached) ? cached : null;
}

async function testConnection() {
  const local = await getLocalSettings();
  try {
    const settings = await fetchServerSettings(local);
    if (settings) return { ok: true, settings };
    return { ok: false, error: "Server responded but returned no settings." };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "Could not reach server." };
  }
}

export {
  getLocalSettings,
  saveLocalSettings,
  getStatus,
  setStatus,
  recordTabFailure,
  clearStaleBackoffEntries,
  callAction,
  resolveSweepSettings,
  testConnection,
};
