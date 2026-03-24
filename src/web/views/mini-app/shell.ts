export function miniAppLayout(activePage: string, body: string): string {
  const tabs = [
    { id: "chat", label: "Chat", href: "/tma/chat" },
    { id: "jobs", label: "Jobs", href: "/tma/jobs" },
    { id: "logs", label: "Logs", href: "/tma/logs" },
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
  <script src="/tma/static/htmx.min.js"></script>
  <script src="/tma/static/sse.js"></script>
  <link rel="stylesheet" href="/tma/static/tma.css">
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
