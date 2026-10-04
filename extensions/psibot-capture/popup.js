document.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");
  const statusText = document.getElementById("status-text");
  const dailyCountEl = document.getElementById("daily-count");
  const totalCountEl = document.getElementById("total-count");
  const saveBtn = document.getElementById("save-btn");
  const feedbackEl = document.getElementById("feedback");
  const lastCaptureEl = document.getElementById("last-capture");

  function showFeedback(message, type) {
    feedbackEl.textContent = message;
    feedbackEl.className = `feedback ${type}`;

    setTimeout(() => {
      feedbackEl.className = "feedback hidden";
    }, 3000);
  }

  function formatRelativeTime(isoString) {
    if (!isoString) return "";
    const diff = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "Last capture: just now";
    if (minutes < 60) return `Last capture: ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `Last capture: ${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `Last capture: ${days}d ago`;
  }

  function refreshStatus() {
    chrome.runtime.sendMessage({ action: "get-status" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusEl.className = "status status-unknown";
        statusText.textContent = "Unknown";
        return;
      }

      dailyCountEl.textContent = response.dailyCount;
      totalCountEl.textContent = response.totalCaptures;

      if (response.connected === true) {
        statusEl.className = "status status-connected";
        statusText.textContent = "Connected";
      } else if (response.connected === false) {
        statusEl.className = "status status-error";
        statusText.textContent = "Error";
      } else {
        statusEl.className = "status status-unknown";
        statusText.textContent = "Unknown";
      }

      lastCaptureEl.textContent = formatRelativeTime(response.lastCaptureAt);
    });
  }

  saveBtn.addEventListener("click", () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    chrome.runtime.sendMessage({ action: "save-page" }, (response) => {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save This Page";

      if (chrome.runtime.lastError) {
        showFeedback("Extension error", "error");
        return;
      }

      if (response?.success) {
        showFeedback("Saved to PsiBot", "success");
        refreshStatus();
      } else {
        showFeedback(response?.error || "Failed to save", "error");
        refreshStatus();
      }
    });
  });

  refreshStatus();

  // -- X bookmarks: popup fallback for when the in-page button is missing --

  const xBookmarksBtn = document.getElementById("x-bookmarks-btn");
  const X_BOOKMARKS_URL = /^https:\/\/(x|twitter)\.com\/i\/bookmarks(\/|\?|$)/;

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.url && X_BOOKMARKS_URL.test(tab.url)) {
      xBookmarksBtn.classList.remove("hidden");
    }
  });

  xBookmarksBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    xBookmarksBtn.disabled = true;
    try {
      // Inject in case the manifest content script never ran in this tab.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-x-bookmarks.js"],
      });
      const response = await chrome.tabs.sendMessage(tab.id, { action: "x-bookmarks-save-all" });
      if (response?.started) {
        showFeedback("Collecting bookmarks — progress shows on the page", "success");
      } else {
        showFeedback(response?.error || "Could not start", "error");
      }
    } catch (err) {
      showFeedback(err?.message || "Could not start", "error");
    } finally {
      xBookmarksBtn.disabled = false;
    }
  });

  // -- Tab-archive: Archive panel ---------------------------------------

  const tabCaptureBtn = document.getElementById("tab-capture");
  const tabArchiveBtn = document.getElementById("tab-archive");
  const panelCapture = document.getElementById("panel-capture");
  const panelArchive = document.getElementById("panel-archive");
  const searchForm = document.getElementById("archive-search-form");
  const searchInput = document.getElementById("archive-search-input");
  const resultsEl = document.getElementById("archive-results");
  const sweepStatusEl = document.getElementById("archive-sweep-status");
  const serverUrlInput = document.getElementById("archive-server-url");
  const tokenInput = document.getElementById("archive-token");
  const saveSettingsBtn = document.getElementById("archive-save-settings-btn");
  const testBtn = document.getElementById("archive-test-btn");
  const settingsFeedback = document.getElementById("archive-settings-feedback");

  function showTab(name) {
    const isCapture = name === "capture";
    panelCapture.classList.toggle("hidden", !isCapture);
    panelArchive.classList.toggle("hidden", isCapture);
    tabCaptureBtn.classList.toggle("active", isCapture);
    tabArchiveBtn.classList.toggle("active", !isCapture);
  }

  tabCaptureBtn?.addEventListener("click", () => showTab("capture"));
  tabArchiveBtn?.addEventListener("click", () => {
    showTab("archive");
    refreshSweepStatus();
    loadArchiveSettings();
  });

  function formatRelativeTimeShort(isoString) {
    if (!isoString) return "never";
    const diff = Date.now() - new Date(isoString).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function refreshSweepStatus() {
    chrome.runtime.sendMessage({ action: "archive-status" }, (status) => {
      if (chrome.runtime.lastError || !status) {
        sweepStatusEl.textContent = "Last sweep: unknown";
        return;
      }
      const when = formatRelativeTimeShort(status.lastSweepAt);
      const count = status.lastSweepCount || 0;
      sweepStatusEl.textContent = `Last sweep: ${when} (${count} archived)`;
      if (status.lastError) {
        sweepStatusEl.textContent += ` — ${status.lastError}`;
      }
    });
  }

  function loadArchiveSettings() {
    chrome.runtime.sendMessage({ action: "archive-get-settings" }, (settings) => {
      if (chrome.runtime.lastError || !settings) return;
      serverUrlInput.value = settings.serverUrl || "";
      tokenInput.value = settings.token || "";
    });
  }

  saveSettingsBtn?.addEventListener("click", () => {
    const serverUrl = serverUrlInput.value.trim();
    const token = tokenInput.value.trim();
    chrome.runtime.sendMessage(
      { action: "archive-save-settings", serverUrl, token },
      (response) => {
        settingsFeedback.textContent =
          chrome.runtime.lastError || !response?.success ? "Could not save settings." : "Saved.";
        setTimeout(() => {
          settingsFeedback.textContent = "";
        }, 2500);
      },
    );
  });

  testBtn?.addEventListener("click", () => {
    settingsFeedback.textContent = "Testing...";
    chrome.runtime.sendMessage({ action: "archive-test-connection" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        settingsFeedback.textContent = "Extension error.";
        return;
      }
      settingsFeedback.textContent = response.ok
        ? "Connected."
        : `Failed: ${response.error || "unknown error"}`;
    });
  });

  function renderResults(results) {
    resultsEl.innerHTML = "";
    if (!results || results.length === 0) {
      resultsEl.innerHTML = '<div class="archive-empty">No results.</div>';
      return;
    }
    for (const item of results) {
      const card = document.createElement("div");
      card.className = "archive-card";

      const title = document.createElement("div");
      title.className = "archive-card-title";
      title.textContent = item.title || item.url;
      card.appendChild(title);

      if (item.summary) {
        const summary = document.createElement("div");
        summary.className = "archive-card-summary";
        summary.textContent = item.summary;
        card.appendChild(summary);
      }

      const meta = document.createElement("div");
      meta.className = "archive-card-meta";
      const bits = [item.workspace, item.archivedAt ? formatRelativeTimeShort(item.archivedAt) : null].filter(
        Boolean,
      );
      meta.textContent = bits.join(" · ");
      card.appendChild(meta);

      const restoreBtn = document.createElement("button");
      restoreBtn.className = "archive-restore-btn";
      restoreBtn.type = "button";
      restoreBtn.textContent = "Restore";
      restoreBtn.addEventListener("click", () => {
        restoreBtn.disabled = true;
        restoreBtn.textContent = "Opening...";
        chrome.runtime.sendMessage({ action: "archive-restore", id: item.id }, (response) => {
          restoreBtn.disabled = false;
          restoreBtn.textContent = response?.success ? "Opened" : "Restore";
        });
      });
      card.appendChild(restoreBtn);

      resultsEl.appendChild(card);
    }
  }

  searchForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;
    resultsEl.innerHTML = '<div class="archive-empty">Searching...</div>';
    chrome.runtime.sendMessage({ action: "archive-search", query, limit: 20 }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        resultsEl.innerHTML = `<div class="archive-empty">${response?.error || "Search failed."}</div>`;
        return;
      }
      renderResults(response.result?.results);
    });
  });
});
