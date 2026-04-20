export function miniAppLayout(activePage: string, body: string): string {
  const tabs = [
    { id: "chat", label: "Chat", href: "/tma/chat" },
    { id: "jobs", label: "Jobs", href: "/tma/jobs" },
    { id: "agents", label: "Agents", href: "/tma/agents" },
    { id: "youtube", label: "YouTube", href: "/tma/youtube" },
    { id: "memory", label: "Memory", href: "/tma/memory" },
    { id: "logs", label: "Logs", href: "/tma/logs" },
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
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
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
    // Markdown rendering: process [data-md] elements. Raw source stays in textContent until rendered.
    window.renderMarkdown = function() {
      if (typeof marked === 'undefined') return;
      document.querySelectorAll('[data-md]:not([data-md-done])').forEach(function(el) {
        var raw = el.getAttribute('data-md-src') || el.textContent || '';
        el.innerHTML = marked.parse(raw);
        el.setAttribute('data-md-done', '1');
      });
    };
    document.addEventListener('htmx:afterSwap', window.renderMarkdown);
    document.addEventListener('htmx:load', window.renderMarkdown);
    document.addEventListener('DOMContentLoaded', window.renderMarkdown);
    // Toggle rendered <-> raw view. Looks for .md-rendered / .md-raw within the same container.
    window.toggleMdView = function(btn) {
      var card = btn.closest('[data-md-toggle-root]');
      if (!card) return;
      var rendered = card.querySelector('.md-rendered');
      var raw = card.querySelector('.md-raw');
      if (!rendered || !raw) return;
      var isRaw = raw.style.display !== 'none';
      raw.style.display = isRaw ? 'none' : 'block';
      rendered.style.display = isRaw ? 'block' : 'none';
      btn.textContent = isRaw ? 'Raw' : 'Rendered';
    };
  </script>
</body>
</html>`;
}
