import { miniAppLayout } from "./shell.ts";
import { pageHeader, escapeHtml, escapeAttr } from "./components.ts";

interface MoreLink {
  href: string;
  label: string;
  hint: string;
  icon: string;
}

// Inline SVG icons — stroke uses currentColor, consistent with shell.ts tab icons.
function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="24" height="24">${paths}</svg>`;
}

const LINKS: MoreLink[] = [
  {
    href: "/tma/chat",
    label: "Chat",
    hint: "Talk to the agent",
    icon: icon(`<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`),
  },
  {
    href: "/tma/agents",
    label: "Agents",
    hint: "Agent roster & runs",
    icon: icon(`<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><path d="M8 14h.01M16 14h.01"/>`),
  },
  {
    href: "/tma/youtube",
    label: "YouTube",
    hint: "Summaries & channels",
    icon: icon(`<path d="M22.5 6.2a2.8 2.8 0 0 0-2-2C18.9 3.7 12 3.7 12 3.7s-6.9 0-8.5.5a2.8 2.8 0 0 0-2 2A29 29 0 0 0 1 12a29 29 0 0 0 .5 5.8 2.8 2.8 0 0 0 2 2c1.6.5 8.5.5 8.5.5s6.9 0 8.5-.5a2.8 2.8 0 0 0 2-2A29 29 0 0 0 23 12a29 29 0 0 0-.5-5.8Z"/><path d="m9.8 15.5 6-3.5-6-3.5v7Z"/>`),
  },
  {
    href: "/tma/memory",
    label: "Memory",
    hint: "Knowledge & notes",
    icon: icon(`<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>`),
  },
  {
    href: "/tma/logs",
    label: "Logs",
    hint: "Session activity",
    icon: icon(`<path d="M3 3h18v18H3z"/><path d="M8 8h8M8 12h8M8 16h5"/>`),
  },
  {
    href: "/tma/sessions",
    label: "Sessions",
    hint: "Resume or fork chats",
    icon: icon(`<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>`),
  },
  {
    href: "/tma/skills",
    label: "Skills",
    hint: "Agent capabilities",
    icon: icon(`<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>`),
  },
];

function moreCard(link: MoreLink): string {
  return `<a class="tma-card" href="${escapeAttr(link.href)}" style="display:flex; flex-direction:column; gap:var(--sp-2); align-items:flex-start; min-height:var(--touch); color:inherit; text-decoration:none;">
    <span style="color:var(--tma-accent);">${link.icon}</span>
    <span style="font-size:var(--fs-md); font-weight:600;">${escapeHtml(link.label)}</span>
    <span class="tma-hint">${escapeHtml(link.hint)}</span>
  </a>`;
}

export function tmaMorePage(): string {
  // Page-local responsive rule: 2-col grid collapses to 1 column below 400px.
  // (components.ts/tma.css are owned by other agents — kept minimal + scoped.)
  const style = `<style>
    .tma-more-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:var(--sp-3); padding:0 var(--sp-4) var(--sp-4); }
    @media (max-width: 400px) { .tma-more-grid { grid-template-columns:1fr; } }
  </style>`;
  const grid = `<div class="tma-more-grid">
    ${LINKS.map(moreCard).join("\n")}
  </div>`;
  const body = `
    ${style}
    ${pageHeader("More")}
    ${grid}
  `;
  return miniAppLayout("more", body);
}
