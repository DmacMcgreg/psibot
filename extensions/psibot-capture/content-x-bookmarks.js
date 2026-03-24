(() => {
  const BUTTON_ID = "psibot-save-all-bookmarks";

  function createButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.textContent = "Save All to PsiBot";
    btn.style.cssText = [
      "position: fixed",
      "bottom: 24px",
      "right: 24px",
      "z-index: 999999",
      "padding: 10px 18px",
      "background: #6366f1",
      "color: #fff",
      "border: none",
      "border-radius: 8px",
      "font-size: 14px",
      "font-weight: 600",
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "cursor: pointer",
      "box-shadow: 0 4px 12px rgba(0,0,0,0.3)",
      "transition: background 0.15s, transform 0.1s",
    ].join(";");

    btn.addEventListener("mouseenter", () => {
      btn.style.background = "#4f46e5";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.background = "#6366f1";
    });

    btn.addEventListener("click", handleSaveAll);

    document.body.appendChild(btn);
  }

  function extractBookmarks() {
    const items = [];

    // X bookmarks are rendered as tweet articles within the timeline
    const tweetArticles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of tweetArticles) {
      const item = extractTweetData(article);
      if (item) {
        items.push(item);
      }
    }

    return items;
  }

  function extractTweetData(article) {
    // --- Tweet permalink ---
    const timeEl = article.querySelector("time");
    const linkEl = timeEl ? timeEl.closest("a") : null;
    let tweetUrl = "";

    if (linkEl) {
      const href = linkEl.getAttribute("href");
      if (href) {
        tweetUrl = href.startsWith("http") ? href : `https://x.com${href}`;
      }
    }

    if (!tweetUrl) {
      const allLinks = article.querySelectorAll('a[href*="/status/"]');
      for (const link of allLinks) {
        const href = link.getAttribute("href");
        if (href && /\/status\/\d+/.test(href)) {
          tweetUrl = href.startsWith("http") ? href : `https://x.com${href}`;
          break;
        }
      }
    }

    if (!tweetUrl) return null;

    // --- Author ---
    const authorEl = article.querySelector('[data-testid="User-Name"]');
    const authorParts = authorEl ? authorEl.innerText.split("\n") : [];
    const authorName = authorParts[0]?.trim() || "";
    const authorHandle = authorParts.find((p) => p.startsWith("@"))?.trim() || "";

    // --- Full tweet text (including "Show more" expanded content) ---
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const tweetText = tweetTextEl ? tweetTextEl.innerText.trim() : "";

    // --- Embedded links (URLs shared in the tweet) ---
    const embeddedLinks = [];
    if (tweetTextEl) {
      const anchors = tweetTextEl.querySelectorAll("a");
      for (const a of anchors) {
        const href = a.getAttribute("href") || "";
        // Skip internal X links (hashtags, mentions, t.co shortlinks pointing to same tweet)
        if (href.startsWith("http") && !href.includes("x.com/hashtag/")) {
          // Prefer the visible text if it looks like a URL (X shows expanded URLs)
          const visibleText = a.textContent.trim();
          const url = visibleText.startsWith("http") ? visibleText : href;
          if (!embeddedLinks.includes(url)) {
            embeddedLinks.push(url);
          }
        }
      }
    }

    // --- Card link (link preview card) ---
    const cardLink = article.querySelector('[data-testid="card.wrapper"] a[href]');
    if (cardLink) {
      const cardHref = cardLink.getAttribute("href");
      if (cardHref && cardHref.startsWith("http") && !embeddedLinks.includes(cardHref)) {
        embeddedLinks.push(cardHref);
      }
    }

    // --- Media detection ---
    const mediaTypes = [];
    if (article.querySelector('[data-testid="tweetPhoto"]')) mediaTypes.push("image");
    if (article.querySelector('[data-testid="videoPlayer"]') ||
        article.querySelector('[data-testid="videoComponent"]') ||
        article.querySelector("video")) mediaTypes.push("video");
    if (article.querySelector('[data-testid="card.wrapper"]')) mediaTypes.push("card");

    // --- Quoted tweet ---
    let quotedText = "";
    const quotedTweet = article.querySelector('[data-testid="quoteTweet"]') ||
                        article.querySelector('[role="link"][tabindex="0"]');
    if (quotedTweet) {
      const qtTextEl = quotedTweet.querySelector('[data-testid="tweetText"]');
      if (qtTextEl && qtTextEl !== tweetTextEl) {
        const qtAuthorEl = quotedTweet.querySelector('[data-testid="User-Name"]');
        const qtAuthor = qtAuthorEl ? qtAuthorEl.innerText.split("\n")[0].trim() : "";
        quotedText = qtAuthor
          ? `[Quoted: ${qtAuthor}] ${qtTextEl.innerText.trim()}`
          : `[Quoted] ${qtTextEl.innerText.trim()}`;
      }
    }

    // --- Reply context (who this is replying to) ---
    let replyContext = "";
    const replyingTo = article.querySelector('[data-testid="TextLabel"]');
    if (replyingTo && replyingTo.textContent.includes("Replying to")) {
      replyContext = replyingTo.textContent.trim();
    }

    // --- Engagement metrics ---
    const metrics = {};
    for (const label of ["reply", "retweet", "like", "bookmark"]) {
      const el = article.querySelector(`[data-testid="${label}"] span`);
      if (el && el.textContent.trim()) {
        metrics[label] = el.textContent.trim();
      }
    }

    // --- Build rich description ---
    const parts = [];

    if (replyContext) parts.push(replyContext);
    if (tweetText) parts.push(tweetText);
    if (quotedText) parts.push(quotedText);

    if (embeddedLinks.length > 0) {
      parts.push("Links: " + embeddedLinks.join(" | "));
    }

    if (mediaTypes.length > 0) {
      parts.push("Media: " + mediaTypes.join(", "));
    }

    const metricStr = Object.entries(metrics)
      .map(([k, v]) => `${v} ${k}s`)
      .join(", ");
    if (metricStr) {
      parts.push("Engagement: " + metricStr);
    }

    const description = parts.join("\n\n");

    // --- Title: include handle and media hint ---
    const mediaHint = mediaTypes.length > 0 ? ` [${mediaTypes.join("+")}]` : "";
    const title = authorName
      ? `${authorName} ${authorHandle ? "(" + authorHandle + ")" : ""} on X${mediaHint}`
      : `Post on X${mediaHint}`;

    return {
      url: tweetUrl,
      title,
      description: description.slice(0, 2000),
    };
  }

  async function scrollAndCollectAll(btn) {
    const collected = new Map(); // url -> item data
    let noNewCount = 0;
    const MAX_STALLS = 5;
    const SCROLL_DELAY = 1500;

    while (noNewCount < MAX_STALLS) {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      const beforeCount = collected.size;

      for (const article of articles) {
        const item = extractTweetData(article);
        if (item && !collected.has(item.url)) {
          collected.set(item.url, item);
        }
      }

      if (collected.size === beforeCount) {
        noNewCount++;
      } else {
        noNewCount = 0;
      }

      btn.textContent = `Scrolling... ${collected.size} found`;
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, SCROLL_DELAY));
    }

    window.scrollTo(0, 0);
    return Array.from(collected.values());
  }

  async function handleSaveAll() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;

    btn.disabled = true;
    btn.textContent = "Scrolling to load all...";
    btn.style.background = "#3f3f46";

    // Scroll and extract tweet data as we go (X virtualizes the DOM)
    const items = await scrollAndCollectAll(btn);

    if (items.length === 0) {
      btn.textContent = "No bookmarks found";
      btn.style.background = "#ef4444";
      setTimeout(() => resetButton(btn), 3000);
      return;
    }

    btn.textContent = `Saving ${items.length} items...`;

    chrome.runtime.sendMessage({ action: "save-items", items }, (response) => {
      if (chrome.runtime.lastError) {
        btn.textContent = "Extension error";
        btn.style.background = "#ef4444";
        setTimeout(() => resetButton(btn), 3000);
        return;
      }

      if (response?.success) {
        btn.textContent = `Saved ${response.saved}/${response.total}`;
        btn.style.background = "#22c55e";
      } else {
        btn.textContent = response?.error || "Failed to save";
        btn.style.background = "#ef4444";
      }

      setTimeout(() => resetButton(btn), 4000);
    });
  }

  function resetButton(btn) {
    btn.disabled = false;
    btn.textContent = "Save All to PsiBot";
    btn.style.background = "#6366f1";
  }

  // Inject button once the page is ready
  // Use a MutationObserver to wait for the timeline to load
  function waitForTimeline() {
    // Check if already loaded
    if (document.querySelector('article[data-testid="tweet"]')) {
      createButton();
      return;
    }

    const observer = new MutationObserver((_mutations, obs) => {
      if (document.querySelector('article[data-testid="tweet"]')) {
        obs.disconnect();
        createButton();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Safety timeout: inject button after 10s regardless
    setTimeout(() => {
      observer.disconnect();
      createButton();
    }, 10000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", waitForTimeline);
  } else {
    waitForTimeline();
  }
})();
