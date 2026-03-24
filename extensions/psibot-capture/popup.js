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
});
