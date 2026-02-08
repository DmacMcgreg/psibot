import { escapeHtml } from "../../shared/html.ts";

export function layout(title: string, activePage: string, body: string): string {
  const navItems = [
    { href: "/chat", label: "Chat", id: "chat" },
    { href: "/jobs", label: "Jobs", id: "jobs" },
    { href: "/memory", label: "Memory", id: "memory" },
    { href: "/logs", label: "Logs", id: "logs" },
  ];

  const nav = navItems
    .map(
      (item) =>
        `<a href="${item.href}" class="px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
          activePage === item.id
            ? "bg-indigo-600 text-white"
            : "text-zinc-400 hover:text-white hover:bg-zinc-800"
        }">${escapeHtml(item.label)}</a>`
    )
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${escapeHtml(title)}</title>
  <script src="https://cdn.tailwindcss.com?plugins=typography"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            zinc: {
              850: '#1f1f23',
              950: '#09090b',
            }
          }
        }
      }
    }
  </script>
  <script src="/static/htmx.min.js"></script>
  <script src="/static/sse.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    body { background: #09090b; color: #fafafa; }
    .chat-messages { }
    .typing-indicator span {
      animation: blink 1.4s infinite both;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes blink {
      0%, 80%, 100% { opacity: 0.2; }
      40% { opacity: 1; }
    }
    .prose { max-width: none; }
    .prose pre { background: #18181b; border-radius: 0.5rem; padding: 1rem; overflow-x: auto; }
    .prose code { color: #a5b4fc; }
    .prose p { margin: 0.5em 0; }
  </style>
</head>
<body class="h-full dark">
  <div class="flex flex-col h-full">
    <nav class="flex items-center gap-1 px-3 py-2 border-b border-zinc-800 bg-zinc-950 shrink-0">
      <span class="text-indigo-400 font-bold text-sm mr-3">Agent</span>
      ${nav}
    </nav>
    <main class="flex-1 overflow-hidden">
      ${body}
    </main>
  </div>
  <script>
    // Auto-scroll chat on SSE events
    document.addEventListener('htmx:sseMessage', function() {
      const el = document.getElementById('messages');
      if (el) el.scrollTop = el.scrollHeight;
    });

    // Render markdown in .md-content elements after htmx swaps
    window.renderMarkdown = renderMarkdown;
    function renderMarkdown() {
      document.querySelectorAll('[data-md]').forEach(function(el) {
        if (el.dataset.rendered) return;
        el.innerHTML = marked.parse(el.textContent || '');
        el.dataset.rendered = '1';
      });
    }
    document.addEventListener('htmx:afterSwap', renderMarkdown);
    document.addEventListener('htmx:load', renderMarkdown);
    document.addEventListener('DOMContentLoaded', renderMarkdown);
  </script>
</body>
</html>`;
}
