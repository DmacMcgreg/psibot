/**
 * Shared server-rendered HTML components + helpers for the Telegram Mini App.
 *
 * Single home for ALL shared HTML builders and formatting helpers. Every page
 * MUST use these — no page-local reimplementations of escape/format/truncate,
 * cards, badges, filter bars, empty/error states, etc.
 *
 * All builders return HTML strings (template-literal pattern; no JSX).
 * All dynamic text goes through escapeHtml; all attribute interpolation
 * through escapeAttr.
 */

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escape text for safe insertion into HTML element content. */
export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for safe insertion into a double-quoted HTML attribute. */
export function escapeAttr(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Truncate to n chars, appending an ellipsis if cut. */
export function truncate(s: string | null | undefined, n: number): string {
  const str = String(s ?? "");
  if (str.length <= n) return str;
  return str.slice(0, Math.max(0, n - 1)).trimEnd() + "…";
}

/**
 * Flatten markdown to a plain-text preview snippet: strips headings, code
 * fences, emphasis markers, and links (keeps link text), then collapses to
 * one line. Optionally drops a leading `skipPrefix` (e.g. a title the card
 * already shows) so the preview doesn't just repeat it.
 */
export function markdownSnippet(md: string | null | undefined, maxLen: number, skipPrefix?: string): string {
  if (!md) return "";
  let cleaned = md
    .replace(/^#+\s.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (skipPrefix) {
    const prefix = skipPrefix.replace(/[*_`>#]/g, "").trim();
    if (prefix && cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleaned = cleaned.slice(prefix.length).replace(/^[\s:—–-]+/, "");
    }
  }
  return truncate(cleaned, maxLen);
}

function toDate(ts: number | string | Date | null | undefined): Date | null {
  if (ts == null) return null;
  if (ts instanceof Date) return isNaN(ts.getTime()) ? null : ts;
  // Numbers: treat < 1e12 as seconds, otherwise ms.
  if (typeof ts === "number") {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

/** Absolute date/time, e.g. "Jul 2, 14:30". */
export function formatDate(ts: number | string | Date | null | undefined): string {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Relative time, e.g. "3m ago", "2h ago", "just now". */
export function formatAgo(ts: number | string | Date | null | undefined): string {
  const d = toDate(ts);
  if (!d) return "—";
  const diff = Date.now() - d.getTime();
  // Future timestamps (e.g. a job's next run) render as "in Xm/Xh/Xd".
  if (diff < -30_000) {
    const fmin = Math.round(-diff / 60_000);
    if (fmin < 60) return `in ${Math.max(1, fmin)}m`;
    const fhr = Math.round(fmin / 60);
    if (fhr < 24) return `in ${fhr}h`;
    return `in ${Math.round(fhr / 24)}d`;
  }
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.round(mon / 12)}y ago`;
}

/** Format a USD cost. Always shows a value ("$0.00", never "–"). */
export function formatCost(usd: number | null | undefined): string {
  const n = typeof usd === "number" && isFinite(usd) ? usd : 0;
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Page header
// ---------------------------------------------------------------------------

export interface PageHeaderOpts {
  subtitle?: string;
  /** Raw HTML for action buttons (already escaped). */
  actions?: string;
}

export function pageHeader(title: string, opts: PageHeaderOpts = {}): string {
  const subtitle = opts.subtitle
    ? `<div class="tma-page-subtitle">${escapeHtml(opts.subtitle)}</div>`
    : "";
  const actions = opts.actions
    ? `<div class="tma-page-actions">${opts.actions}</div>`
    : "";
  return `<header class="tma-page-header">
  <div>
    <h1>${escapeHtml(title)}</h1>
    ${subtitle}
  </div>
  ${actions}
</header>`;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CardOpts {
  /** JS onclick handler (raw). */
  onclick?: string;
  /** Anchor href — renders the card as an <a>. */
  href?: string;
  /** Extra classes appended to .tma-card. */
  className?: string;
  /** Extra raw attributes (already escaped), e.g. hx-get="...". */
  attrs?: string;
}

/** A .tma-card container. `inner` is raw HTML (caller escapes its own text). */
export function card(inner: string, opts: CardOpts = {}): string {
  const cls = `tma-card${opts.className ? " " + opts.className : ""}`;
  const attrs = opts.attrs ? " " + opts.attrs : "";
  if (opts.href) {
    return `<a href="${escapeAttr(opts.href)}" class="${cls}"${attrs}>${inner}</a>`;
  }
  if (opts.onclick) {
    return `<div class="${cls}" onclick="${escapeAttr(opts.onclick)}"${attrs}>${inner}</div>`;
  }
  return `<div class="${cls}"${attrs}>${inner}</div>`;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type BadgeKind = "ok" | "warn" | "err" | "muted" | "accent";

export function badge(label: string, kind: BadgeKind = "muted"): string {
  return `<span class="tma-badge tma-badge-${kind}">${escapeHtml(label)}</span>`;
}

/**
 * Map a job/agent/skill/run status string to a badge. Unknown statuses render
 * as muted with the raw label.
 */
export function statusBadge(status: string | null | undefined): string {
  const s = String(status ?? "").toLowerCase();
  const map: Record<string, BadgeKind> = {
    // ok / success
    enabled: "ok",
    active: "ok",
    success: "ok",
    completed: "ok",
    installed: "ok",
    approved: "ok",
    watching: "ok",
    // warn / paused / pending
    paused: "warn",
    pending: "warn",
    queued: "warn",
    running: "accent",
    // err
    error: "err",
    failed: "err",
    rejected: "err",
    // muted / disabled
    disabled: "muted",
    inactive: "muted",
    archived: "muted",
    dropped: "muted",
  };
  const kind = map[s] ?? "muted";
  const label = status ? String(status) : "unknown";
  return badge(label, kind);
}

// ---------------------------------------------------------------------------
// Filter chips (horizontal scroll row, HTMX-driven)
// ---------------------------------------------------------------------------

export interface ChipOption {
  value: string;
  label: string;
  /** Optional raw HTMX attrs override; if omitted an hx-get is built from href. */
  href?: string;
}

/**
 * Horizontal scroll chip row. If an option has `href`, chips are links
 * (server-round-trip filter, state in URL). Otherwise emits data-tma-filter
 * chips for the client-side `tmaFilter` helper keyed by `name`.
 */
export function filterChips(
  name: string,
  options: ChipOption[],
  active: string,
): string {
  const chips = options
    .map((o) => {
      const isActive = o.value === active;
      const cls = `tma-chip${isActive ? " tma-chip-active" : ""}`;
      if (o.href) {
        return `<a href="${escapeAttr(o.href)}" class="${cls}">${escapeHtml(o.label)}</a>`;
      }
      return `<button type="button" class="${cls}" data-tma-filter="${escapeAttr(name)}" data-tma-value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</button>`;
    })
    .join("");
  return `<div class="tma-chip-row" role="group" aria-label="${escapeAttr(name)}">${chips}</div>`;
}

// ---------------------------------------------------------------------------
// Search bar
// ---------------------------------------------------------------------------

/**
 * Standard search input. If `action` is set, issues an hx-get on keyup
 * (debounced). Otherwise emits a plain input wired for the client `tmaFilter`
 * helper (targets rows via data-tma-filter-target).
 */
export function searchBar(
  action: string,
  placeholder = "Search…",
  value = "",
): string {
  if (action) {
    return `<div class="tma-search">
  <input type="search" name="q" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(value)}"
    hx-get="${escapeAttr(action)}" hx-trigger="keyup changed delay:300ms, search"
    hx-target="closest .tma-search-scope" hx-swap="innerHTML" autocomplete="off">
</div>`;
  }
  return `<div class="tma-search">
  <input type="search" placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(value)}"
    oninput="tmaFilter(this)" autocomplete="off">
</div>`;
}

// ---------------------------------------------------------------------------
// Empty / error / skeleton states
// ---------------------------------------------------------------------------

export function emptyState(icon: string, title: string, hint?: string): string {
  const hintHtml = hint
    ? `<div class="tma-empty-hint">${escapeHtml(hint)}</div>`
    : "";
  return `<div class="tma-empty">
  <div class="tma-empty-icon">${escapeHtml(icon)}</div>
  <div class="tma-empty-title">${escapeHtml(title)}</div>
  ${hintHtml}
</div>`;
}

export function errorState(message: string, retryUrl?: string): string {
  const retry = retryUrl
    ? `<button class="tma-btn tma-btn-secondary" hx-get="${escapeAttr(retryUrl)}" hx-target="closest .tma-error-state" hx-swap="outerHTML">Retry</button>`
    : "";
  return `<div class="tma-error-state">
  <div class="tma-empty-icon">⚠️</div>
  <div>${escapeHtml(message)}</div>
  ${retry}
</div>`;
}

/** N shimmer skeleton rows for a loading placeholder. */
export function skeletonList(n = 3): string {
  return Array.from({ length: Math.max(1, n) }, () => `<div class="tma-skeleton"></div>`).join("\n");
}

// ---------------------------------------------------------------------------
// List row
// ---------------------------------------------------------------------------

export interface ListRowOpts {
  title: string;
  subtitle?: string;
  meta?: string;
  /** Raw badge HTML (use badge()/statusBadge()). */
  badge?: string;
  href?: string;
  /** HTMX get URL — renders row as a button-like element issuing hx-get. */
  hxGet?: string;
  /** hx-target for hxGet. */
  hxTarget?: string;
  /** Show a chevron affordance on the right. */
  chevron?: boolean;
}

const CHEVRON_SVG = `<svg class="tma-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;

/** Standard tappable row: title + subtitle + meta + optional badge/chevron. */
export function listRow(opts: ListRowOpts): string {
  const subtitle = opts.subtitle
    ? `<div class="tma-list-row-subtitle">${escapeHtml(opts.subtitle)}</div>`
    : "";
  const meta = opts.meta
    ? `<div class="tma-list-row-meta">${escapeHtml(opts.meta)}</div>`
    : "";
  const aside = opts.badge
    ? `<div class="tma-list-row-aside">${opts.badge}</div>`
    : "";
  const chevron = opts.chevron ? CHEVRON_SVG : "";
  const body = `<div class="tma-list-row-body">
    <div class="tma-list-row-title">${escapeHtml(opts.title)}</div>
    ${subtitle}
    ${meta}
  </div>
  ${aside}
  ${chevron}`;

  if (opts.href) {
    return `<a class="tma-list-row" href="${escapeAttr(opts.href)}">${body}</a>`;
  }
  if (opts.hxGet) {
    const target = opts.hxTarget ? ` hx-target="${escapeAttr(opts.hxTarget)}"` : "";
    return `<div class="tma-list-row" role="button" tabindex="0" hx-get="${escapeAttr(opts.hxGet)}"${target}>${body}</div>`;
  }
  return `<div class="tma-list-row">${body}</div>`;
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/** Titled group with consistent margins. `inner` is raw HTML. */
export function section(title: string, inner: string): string {
  return `<section class="tma-section">
  <div class="tma-section-title">${escapeHtml(title)}</div>
  ${inner}
</section>`;
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------

/** A labelled form field. `inputHtml` is a raw control (e.g. from an input). */
export function formField(label: string, inputHtml: string): string {
  return `<div class="tma-form-field">
  <label class="tma-field-label">${escapeHtml(label)}</label>
  ${inputHtml}
</div>`;
}

/** A row of action buttons. Each entry is raw button HTML. */
export function formActions(...buttons: string[]): string {
  return `<div class="tma-form-actions">${buttons.filter(Boolean).join("\n")}</div>`;
}

// ---------------------------------------------------------------------------
// Details panel
// ---------------------------------------------------------------------------

export interface DetailsOpts {
  open?: boolean;
}

/** Styled <details>. `summary` is escaped; `inner` is raw HTML. */
export function detailsPanel(
  summary: string,
  inner: string,
  opts: DetailsOpts = {},
): string {
  return `<details class="tma-details"${opts.open ? " open" : ""}>
  <summary>${escapeHtml(summary)}</summary>
  <div class="tma-details-body">${inner}</div>
</details>`;
}

// ---------------------------------------------------------------------------
// Button helper (convenience — used by headers/actions)
// ---------------------------------------------------------------------------

export interface ButtonOpts {
  kind?: "primary" | "secondary" | "danger";
  small?: boolean;
  href?: string;
  onclick?: string;
  /** Extra raw attrs (already escaped), e.g. hx-post="...". */
  attrs?: string;
}

export function button(label: string, opts: ButtonOpts = {}): string {
  const classes = ["tma-btn"];
  if (opts.kind) classes.push(`tma-btn-${opts.kind}`);
  if (opts.small) classes.push("tma-btn-sm");
  const cls = classes.join(" ");
  const attrs = opts.attrs ? " " + opts.attrs : "";
  if (opts.href) {
    return `<a class="${cls}" href="${escapeAttr(opts.href)}"${attrs}>${escapeHtml(label)}</a>`;
  }
  const onclick = opts.onclick ? ` onclick="${escapeAttr(opts.onclick)}"` : "";
  return `<button type="button" class="${cls}"${onclick}${attrs}>${escapeHtml(label)}</button>`;
}
