// Tab-archive module (added — see apps/tab-archive/ISA.md for the spec this
// implements). Kept as separate files and wired in here with the smallest
// possible edits to this existing capture flow, which is otherwise
// untouched.
import { initTracking } from "./tracking.js";
import {
  initArchiveAlarm,
  runSweep,
  getLocalSettings,
  saveLocalSettings,
  getStatus,
  testConnection,
  searchArchivedTabs,
  restoreArchivedTab,
} from "./archive.js";

const API_URL = "http://localhost:3141/api/inbox";

const PLATFORM_MAP = {
  "x.com": "x.com",
  "twitter.com": "x.com",
  "reddit.com": "reddit",
  "www.reddit.com": "reddit",
  "old.reddit.com": "reddit",
  "github.com": "github",
  "youtube.com": "youtube",
  "www.youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "news.ycombinator.com": "hackernews",
  "stackoverflow.com": "stackoverflow",
  "medium.com": "medium",
  "arxiv.org": "arxiv",
  "linkedin.com": "linkedin",
  "www.linkedin.com": "linkedin",
};

function detectPlatform(url) {
  try {
    const hostname = new URL(url).hostname;
    return PLATFORM_MAP[hostname] || null;
  } catch {
    return null;
  }
}

function buildPayload(url, title, description, platform) {
  return {
    url,
    title: title || "",
    description: description || "",
    source: "chrome-extension",
    profile: "default",
    platform: platform,
    captured_at: new Date().toISOString(),
  };
}

async function sendToInbox(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function incrementDailyCount() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await chrome.storage.local.get(["dailyCount", "dailyDate", "totalCaptures"]);

  let count = 0;
  if (data.dailyDate === today) {
    count = data.dailyCount || 0;
  }
  count += 1;

  const totalCaptures = (data.totalCaptures || 0) + 1;

  await chrome.storage.local.set({
    dailyCount: count,
    dailyDate: today,
    totalCaptures,
    lastCaptureAt: new Date().toISOString(),
  });

  await chrome.action.setBadgeText({ text: String(count) });
  await chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });

  return count;
}

async function updateConnectionStatus(connected) {
  await chrome.storage.local.set({
    connected,
    lastCheckAt: new Date().toISOString(),
  });
}

async function captureAndSend(url, title, description) {
  const platform = detectPlatform(url);
  const payload = buildPayload(url, title, description, platform);

  try {
    await sendToInbox(payload);
    await incrementDailyCount();
    await updateConnectionStatus(true);

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "PsiBot Capture",
      message: `Saved: ${title || url}`,
      requireInteraction: false,
    });

    return { success: true };
  } catch (err) {
    await updateConnectionStatus(false);

    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "PsiBot Capture - Error",
      message: `Failed to save: ${err.message}`,
      requireInteraction: false,
    });

    return { success: false, error: err.message };
  }
}

// -- Context menu --

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "psibot-save-selection",
    title: "Save to PsiBot",
    contexts: ["selection"],
  });

  chrome.contextMenus.create({
    id: "psibot-save-page",
    title: "Save Page to PsiBot",
    contexts: ["page"],
  });

  // Initialize badge
  const today = new Date().toISOString().slice(0, 10);
  chrome.storage.local.get(["dailyCount", "dailyDate"], (data) => {
    if (data.dailyDate === today && data.dailyCount > 0) {
      chrome.action.setBadgeText({ text: String(data.dailyCount) });
      chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  });
});

// Tab-archive: listener registration (tracking + the sweep alarm) must run
// at top level so it re-registers on every service-worker start, not just
// onInstalled — MV3 can spin the worker up fresh without re-firing
// onInstalled, and in-memory listeners don't survive a worker restart even
// though the alarm itself (stored by Chrome) does.
initTracking();
initArchiveAlarm();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "psibot-save-selection") {
    await captureAndSend(
      info.pageUrl || tab.url,
      tab.title || "",
      info.selectionText || ""
    );
  } else if (info.menuItemId === "psibot-save-page") {
    const description = await getMetaDescription(tab.id);
    await captureAndSend(tab.url, tab.title || "", description);
  }
});

// -- Keyboard shortcut --

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "save-page") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const description = await getMetaDescription(tab.id);
      await captureAndSend(tab.url, tab.title || "", description);
    }
  }
});

// -- Messages from popup and content scripts --

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "save-page") {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const description = await getMetaDescription(tab.id);
        const result = await captureAndSend(tab.url, tab.title || "", description);
        sendResponse(result);
      } else {
        sendResponse({ success: false, error: "No active tab" });
      }
    })();
    return true; // keep channel open for async response
  }

  if (message.action === "save-items") {
    (async () => {
      const items = message.items;
      if (!Array.isArray(items) || items.length === 0) {
        sendResponse({ success: false, error: "No items provided" });
        return;
      }

      let successCount = 0;
      let lastError = null;

      for (const item of items) {
        const platform = detectPlatform(item.url);
        const payload = buildPayload(item.url, item.title || "", item.description || "", platform);

        try {
          await sendToInbox(payload);
          await incrementDailyCount();
          await updateConnectionStatus(true);
          successCount++;
        } catch (err) {
          await updateConnectionStatus(false);
          lastError = err.message;
        }
      }

      if (successCount > 0) {
        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "PsiBot Capture",
          message: `Saved ${successCount}/${items.length} items from X bookmarks`,
          requireInteraction: false,
        });
      }

      sendResponse({
        success: successCount > 0,
        saved: successCount,
        total: items.length,
        error: lastError,
      });
    })();
    return true;
  }

  if (message.action === "get-status") {
    chrome.storage.local.get(
      ["connected", "dailyCount", "dailyDate", "totalCaptures", "lastCaptureAt"],
      (data) => {
        const today = new Date().toISOString().slice(0, 10);
        sendResponse({
          connected: data.connected ?? null,
          dailyCount: data.dailyDate === today ? (data.dailyCount || 0) : 0,
          totalCaptures: data.totalCaptures || 0,
          lastCaptureAt: data.lastCaptureAt || null,
        });
      }
    );
    return true;
  }

  // -- Tab-archive: popup "Archive" tab -----------------------------------

  if (message.action === "archive-get-settings") {
    getLocalSettings().then(sendResponse);
    return true;
  }

  if (message.action === "archive-save-settings") {
    saveLocalSettings({ serverUrl: message.serverUrl, token: message.token }).then((settings) =>
      sendResponse({ success: true, settings }),
    );
    return true;
  }

  if (message.action === "archive-test-connection") {
    testConnection().then(sendResponse);
    return true;
  }

  if (message.action === "archive-status") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.action === "archive-run-sweep-now") {
    runSweep()
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "archive-search") {
    searchArchivedTabs(message.query, message.limit)
      .then((result) => sendResponse({ success: true, result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.action === "archive-restore") {
    restoreArchivedTab(message.id)
      .then(({ url }) => {
        chrome.tabs.create({ url });
        sendResponse({ success: true, url });
      })
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// -- Helper: extract meta description from a tab --

async function getMetaDescription(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const meta =
          document.querySelector('meta[name="description"]') ||
          document.querySelector('meta[property="og:description"]');
        return meta ? meta.getAttribute("content") : "";
      },
    });
    return results?.[0]?.result || "";
  } catch {
    return "";
  }
}
