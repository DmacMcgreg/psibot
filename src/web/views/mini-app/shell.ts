/**
 * Mini App HTML shell. Renders the <head>, the page body, and the bottom tab
 * bar (4 primary tabs + More). All shared client logic lives in
 * /tma/static/tma.js — this file emits no behavioural inline script.
 *
 * Primary pages carry `data-tma-root` on .tma-main so tma.js hides the
 * Telegram BackButton; secondary/detail pages omit it (pass isPrimary=false)
 * so the BackButton is shown.
 */

interface Tab {
  id: string;
  label: string;
  href: string;
  icon: string;
}

// Inline SVG icons — stroke uses currentColor so the active tint applies.
function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

const ICONS = {
  chat: icon(`<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`),
  review: icon(`<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`),
  jobs: icon(`<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>`),
  library: icon(`<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`),
  agents: icon(`<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01M16 14h.01"/>`),
  more: icon(`<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>`),
};

const TABS: Tab[] = [
  { id: "review", label: "Review", href: "/tma/review", icon: ICONS.review },
  { id: "jobs", label: "Jobs", href: "/tma/jobs", icon: ICONS.jobs },
  { id: "library", label: "Library", href: "/tma/library", icon: ICONS.library },
  { id: "agents", label: "Agents", href: "/tma/agents", icon: ICONS.agents },
  { id: "more", label: "More", href: "/tma/more", icon: ICONS.more },
];

// Secondary pages surfaced under "More" light up the More tab.
const MORE_PAGES = new Set([
  "more",
  "chat",
  "digest",
  "youtube",
  "memory",
  "logs",
  "sessions",
  "skills",
]);

function tabBar(activePage: string): string {
  return TABS.map((t) => {
    const active =
      t.id === activePage || (t.id === "more" && MORE_PAGES.has(activePage));
    return `<a href="${t.href}" class="tma-tab ${active ? "tma-tab-active" : ""}">${t.icon}<span>${t.label}</span></a>`;
  }).join("\n    ");
}

/**
 * @param activePage  tab/page id used for tab highlighting
 * @param body        page HTML (already escaped by the page)
 * @param isPrimary   when true (default for the 4 primary tabs), marks the page
 *                    as a root so the Telegram BackButton is hidden.
 *                    Detail/secondary pages should pass false.
 */
export function miniAppLayout(
  activePage: string,
  body: string,
  isPrimary = true,
): string {
  const rootAttr = isPrimary ? " data-tma-root" : "";
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
  <div class="tma-main"${rootAttr}>
    ${body}
  </div>
  <nav class="tma-tab-bar">
    ${tabBar(activePage)}
  </nav>
  <script src="/tma/static/tma.js"></script>
</body>
</html>`;
}
