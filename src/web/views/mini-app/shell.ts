export function miniAppLayout(activePage: string, body: string): string {
  const tabs = [
    { id: "chat", label: "Chat", href: "/tma/chat" },
    { id: "jobs", label: "Jobs", href: "/tma/jobs" },
    { id: "memory", label: "Memory", href: "/tma/memory" },
    { id: "sessions", label: "Sessions", href: "/tma/sessions" },
  ];

  const tabBar = tabs
    .map(
      (t) =>
        `<a href="${t.href}" class="tma-tab ${activePage === t.id ? "tma-tab-active" : ""}">${t.label}</a>`
    )
    .join("\n      ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/static/htmx.min.js"></script>
  <script src="/static/sse.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--tg-theme-bg-color, #fff);
      color: var(--tg-theme-text-color, #000);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .tma-main {
      flex: 1;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
    }
    .tma-tab-bar {
      display: flex;
      border-top: 1px solid var(--tg-theme-hint-color, #ccc);
      background: var(--tg-theme-secondary-bg-color, #f0f0f0);
      padding-bottom: env(safe-area-inset-bottom, 0);
      flex-shrink: 0;
    }
    .tma-tab {
      flex: 1;
      text-align: center;
      padding: 10px 4px 8px;
      font-size: 12px;
      color: var(--tg-theme-hint-color, #999);
      text-decoration: none;
      transition: color 0.2s;
    }
    .tma-tab-active {
      color: var(--tg-theme-button-color, #3390ec);
      font-weight: 600;
    }
    .tma-card {
      background: var(--tg-theme-secondary-bg-color, #f5f5f5);
      border-radius: 12px;
      padding: 12px;
      margin: 8px 16px;
    }
    .tma-btn {
      background: var(--tg-theme-button-color, #3390ec);
      color: var(--tg-theme-button-text-color, #fff);
      border: none;
      border-radius: 8px;
      padding: 8px 16px;
      font-size: 14px;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
    }
    .tma-btn-sm {
      padding: 4px 10px;
      font-size: 12px;
      border-radius: 6px;
    }
    .tma-btn-danger {
      background: #e53935;
    }
    .tma-btn-secondary {
      background: var(--tg-theme-hint-color, #999);
    }
    .tma-input {
      width: 100%;
      background: var(--tg-theme-secondary-bg-color, #f5f5f5);
      color: var(--tg-theme-text-color, #000);
      border: 1px solid var(--tg-theme-hint-color, #ccc);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }
    .tma-input:focus {
      border-color: var(--tg-theme-button-color, #3390ec);
    }
    .tma-hint {
      color: var(--tg-theme-hint-color, #999);
      font-size: 13px;
    }
    .tma-link {
      color: var(--tg-theme-link-color, #3390ec);
      text-decoration: none;
    }
    .tma-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
    }
    .tma-badge-enabled { background: #e8f5e9; color: #2e7d32; }
    .tma-badge-disabled { background: #fafafa; color: #999; }
    .tma-badge-paused { background: #fff3e0; color: #e65100; }
    .tma-bubble {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 16px;
      margin: 4px 16px;
      font-size: 14px;
      line-height: 1.4;
      word-break: break-word;
    }
    .tma-bubble-user {
      background: var(--tg-theme-button-color, #3390ec);
      color: var(--tg-theme-button-text-color, #fff);
      margin-left: auto;
      border-bottom-right-radius: 4px;
    }
    .tma-bubble-assistant {
      background: var(--tg-theme-secondary-bg-color, #f0f0f0);
      color: var(--tg-theme-text-color, #000);
      margin-right: auto;
      border-bottom-left-radius: 4px;
    }
    .tma-empty {
      text-align: center;
      padding: 40px 16px;
      color: var(--tg-theme-hint-color, #999);
    }
    .tma-meta {
      font-size: 11px;
      color: var(--tg-theme-hint-color, #999);
      margin-top: 4px;
    }
    /* Dark mode detection via Telegram variables */
    @media (prefers-color-scheme: dark) {
      .tma-badge-enabled { background: #1b5e20; color: #a5d6a7; }
      .tma-badge-disabled { background: #333; color: #999; }
      .tma-badge-paused { background: #bf360c; color: #ffcc80; }
    }
  </style>
</head>
<body>
  <div class="tma-main">
    ${body}
  </div>
  <nav class="tma-tab-bar">
    ${tabBar}
  </nav>
  <script>
    var tg = window.Telegram && window.Telegram.WebApp;
    if (tg) {
      tg.ready();
      tg.expand();
      // Back button handling
      tg.BackButton.onClick(function() { window.history.back(); });
      // Inject auth header for all HTMX requests
      document.body.addEventListener('htmx:configRequest', function(e) {
        e.detail.headers['X-Telegram-Init-Data'] = tg.initData || '';
      });
    }
    // Also inject for plain fetch
    var _origFetch = window.fetch;
    window.fetch = function(url, opts) {
      opts = opts || {};
      opts.headers = opts.headers || {};
      if (tg && tg.initData) {
        opts.headers['X-Telegram-Init-Data'] = tg.initData;
      }
      return _origFetch.call(this, url, opts);
    };
  </script>
</body>
</html>`;
}
