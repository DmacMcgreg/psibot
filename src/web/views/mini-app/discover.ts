import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  pageHeader,
  emptyState,
  filterChips,
  truncate,
  markdownSnippet,
} from "./components.ts";
import type { DiscoverGroup, DiscoverItem, DiscoverSource, ItemFilter } from "../../../discover/db.ts";
import type { GroupSummary } from "../../../discover/db.ts";

// ---------------------------------------------------------------------------
// Discover — a unified, topic-clustered content hub across four sources
// (YouTube discovery + watch-laters, GitHub stars, Reddit saved). Server-
// rendered HTML + HTMX; page-local styles are scoped with a `dv-` prefix so
// they don't collide with tma.css (owned elsewhere). Client-side search / sort
// / source-filter reuse the shared tmaFilter / tmaSort helpers in tma.js.
// ---------------------------------------------------------------------------

const SOURCE_EMOJI: Record<DiscoverSource, string> = {
  youtube_discovery: "🎬",
  youtube_watchlater: "⏰",
  github: "⭐",
  reddit: "👽",
};

// Which of the client source-filter chips a card belongs to.
const SOURCE_GROUP: Record<DiscoverSource, "yt" | "gh" | "rd"> = {
  youtube_discovery: "yt",
  youtube_watchlater: "yt",
  github: "gh",
  reddit: "rd",
};

const STYLE = `<style>
  /* Discover runs denser than the default tma spacing: the base .tma-card ships
     margin:8px 16px, which on top of the list container's own padding leaves
     cards double-indented and far apart. We zero that margin and let the flex
     container's gap own the rhythm, then tighten padding across the board. */
  .dv-tools { display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-2); padding:var(--sp-1) var(--sp-3) var(--sp-2); }
  .dv-tools .tma-search { flex:1 1 160px; margin:0; }
  .dv-tools .tma-search input { width:100%; box-sizing:border-box; padding:6px 10px; }
  .dv-sort { font:inherit; font-size:var(--fs-sm); padding:6px 8px; border-radius:var(--rad-sm); border:1px solid var(--tma-border, rgba(128,128,128,.3)); background:var(--tma-bg-secondary); color:var(--tma-text); }
  .dv-srcrow { display:flex; flex-wrap:wrap; gap:var(--sp-1); padding:0 var(--sp-3) var(--sp-2); }

  .dv-groups { display:flex; flex-direction:column; gap:var(--sp-1); padding:0 var(--sp-3) var(--sp-3); }
  .dv-groups .tma-card { margin:0; padding:var(--sp-2) var(--sp-3); border-radius:var(--rad-sm); }
  .dv-grow { display:flex; align-items:center; gap:var(--sp-2); }
  .dv-emoji { font-size:1.1rem; line-height:1; flex:none; }
  .dv-gbody { flex:1; min-width:0; display:flex; flex-direction:column; gap:1px; }
  .dv-glabel { font-weight:640; font-size:var(--fs-sm); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dv-mix { font-family:var(--font-mono, ui-monospace, monospace); font-size:var(--fs-xs); color:var(--tma-text-secondary); }
  .dv-prev { font-size:var(--fs-xs); color:var(--tma-text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.85; }
  .dv-new { margin-left:auto; flex:none; }

  .dv-list { display:flex; flex-direction:column; gap:var(--sp-1); padding:0 var(--sp-3) var(--sp-3); }
  .dv-list .tma-card { margin:0; }
  .dv-card { display:flex; flex-direction:column; gap:var(--sp-1); padding:var(--sp-2) var(--sp-3); }
  .dv-vt { font-weight:600; font-size:var(--fs-sm); line-height:1.3; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .dv-vm { font-family:var(--font-mono, ui-monospace, monospace); font-size:var(--fs-xs); color:var(--tma-text-secondary); }
  .dv-vm b { color:var(--tma-accent); font-weight:600; }
  .dv-vs { font-size:var(--fs-sm); color:var(--tma-text-secondary); line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .dv-acts { display:flex; align-items:center; gap:var(--sp-1); flex-wrap:wrap; margin-top:2px; }
  .dv-acts .tma-btn { padding:4px 10px; font-size:var(--fs-xs); min-width:0; }
  .dv-acts .dv-open { margin-right:auto; }
  .dv-icon { border:1px solid var(--tma-border, rgba(128,128,128,.3)); background:transparent; color:var(--tma-text); border-radius:var(--rad-sm); padding:4px 9px; font-size:var(--fs-sm); cursor:pointer; line-height:1.1; }
  .dv-icon.up:active { background:rgba(52,199,89,.18); }
  .dv-icon.down:active { background:rgba(255,69,58,.18); }

  .dv-fb { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-1); padding-top:var(--sp-2); border-top:1px solid var(--tma-border, rgba(128,128,128,.2)); }
  .dv-q { font-size:var(--fs-sm); font-weight:640; }
  .dv-chips { display:flex; flex-wrap:wrap; gap:var(--sp-2); }
  .dv-chip { display:inline-flex; align-items:center; font-size:var(--fs-xs); padding:4px 10px; border-radius:999px; border:1px solid var(--tma-border, rgba(128,128,128,.3)); color:var(--tma-text); cursor:pointer; user-select:none; }
  .dv-chip input { position:absolute; opacity:0; width:0; height:0; }
  .dv-chip:has(input:checked) { background:var(--tma-accent); border-color:var(--tma-accent); color:#fff; }
  .dv-chip.gen { border-style:dashed; }
  .dv-genwrap { display:contents; }
  .dv-genload { font-size:var(--fs-xs); color:var(--tma-text-secondary); opacity:.7; }
  .dv-note { width:100%; font:inherit; font-size:var(--fs-sm); padding:8px 10px; border-radius:var(--rad-md); border:1px solid var(--tma-border, rgba(128,128,128,.3)); background:var(--tma-bg-secondary); color:var(--tma-text); box-sizing:border-box; }
  .dv-noted { font-size:var(--fs-sm); color:var(--tma-text-secondary); padding:var(--sp-2) 0; }
</style>`;

// ---------------------------------------------------------------------------
// Sort control
// ---------------------------------------------------------------------------

function sortSelect(options: { value: string; label: string }[]): string {
  const opts = options
    .map((o) => `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`)
    .join("");
  return `<select class="dv-sort" aria-label="Sort" onchange="tmaSort(this)">${opts}</select>`;
}

// ---------------------------------------------------------------------------
// List page — one compact row per topic group
// ---------------------------------------------------------------------------

function sourceMix(g: GroupSummary): string {
  const parts: string[] = [];
  if (g.yt_count) parts.push(`🎬 ${g.yt_count}`);
  if (g.gh_count) parts.push(`⭐ ${g.gh_count}`);
  if (g.rd_count) parts.push(`👽 ${g.rd_count}`);
  return parts.join(" · ");
}

function groupCard(g: GroupSummary): string {
  const emoji = g.emoji || "✨";
  const newBadge = g.new_count > 0
    ? `<span class="tma-badge tma-badge-accent dv-new">${g.new_count} new</span>`
    : "";
  const mix = sourceMix(g);
  const preview = g.previews.length
    ? escapeHtml(truncate(g.previews.join(" · "), 80))
    : "";
  const inner = `<div class="dv-grow">
    <span class="dv-emoji">${escapeHtml(emoji)}</span>
    <div class="dv-gbody">
      <div class="dv-glabel">${escapeHtml(g.label)}</div>
      ${mix ? `<div class="dv-mix">${escapeHtml(mix)}</div>` : ""}
      ${preview ? `<div class="dv-prev">${preview}</div>` : ""}
    </div>
    ${newBadge}
  </div>`;
  return `<a class="tma-card" href="/tma/discover/${escapeAttr(g.slug)}"
    data-tma-filter-item
    data-tma-filter-text="${escapeAttr(g.label.toLowerCase())}"
    data-new="${g.new_count}" data-size="${g.item_count}"
    data-title="${escapeAttr(g.label.toLowerCase())}"
    style="color:inherit; text-decoration:none;">${inner}</a>`;
}

export function tmaDiscoverListPage(opts: { groups: GroupSummary[] }): string {
  // Default order: groups with new items first, then by size.
  const groups = [...opts.groups].sort(
    (a, b) => (b.new_count - a.new_count) || (b.item_count - a.item_count),
  );
  const totalNew = groups.reduce((s, g) => s + g.new_count, 0);
  const body = `
    ${STYLE}
    ${pageHeader("Discover", {
      subtitle: totalNew > 0
        ? `${totalNew} new across ${groups.filter((g) => g.new_count > 0).length} topics`
        : "All caught up",
    })}
    ${
      groups.length === 0
        ? emptyState("🧭", "Nothing yet", "New videos, repos and saves get grouped here as they're indexed.")
        : `<div class="tma-search-scope" data-tma-filter-scope>
            <div class="dv-tools">
              <div class="tma-search">
                <input type="search" placeholder="Search topics…" oninput="tmaFilter(this)" autocomplete="off">
              </div>
              ${sortSelect([
                { value: "new", label: "Most new" },
                { value: "size", label: "Largest" },
                { value: "title", label: "A–Z" },
              ])}
            </div>
            <div class="dv-groups" data-dv-list>${groups.map(groupCard).join("\n")}</div>
            <div data-tma-filter-empty style="display:none;">${emptyState("🔍", "No matches")}</div>
          </div>`
    }
  `;
  return miniAppLayout("discover", body, true);
}

// ---------------------------------------------------------------------------
// Group (topic digest) page
// ---------------------------------------------------------------------------

function matchPct(item: DiscoverItem): number | null {
  if (!item.score_breakdown_json) return null;
  try {
    const b = JSON.parse(item.score_breakdown_json);
    if (typeof b?.similarity === "number") return Math.round(b.similarity * 100);
  } catch { /* ignore */ }
  return null;
}

function metaLine(item: DiscoverItem): string {
  const emoji = SOURCE_EMOJI[item.discover_source];
  let meta = "";
  if (item.discover_source === "youtube_discovery") {
    const pct = matchPct(item);
    meta = [item.channel_title, pct !== null ? `match <b>${pct}%</b>` : ""].filter(Boolean).join(" · ");
  } else if (item.discover_source === "youtube_watchlater") {
    meta = [item.channel_title, "watch later"].filter(Boolean).join(" · ");
  } else if (item.discover_source === "github") {
    meta = "GitHub star";
  } else if (item.discover_source === "reddit") {
    meta = "Reddit saved";
  }
  return `${escapeHtml(emoji)} <span class="dv-vm">${meta}</span>`;
}

function actionLabel(source: DiscoverSource): string {
  return source === "youtube_discovery" || source === "youtube_watchlater" ? "Watch ↗" : "Open ↗";
}

/** A single compact item card. When `notedSentiment` is set, renders the
 *  post-feedback state instead of the action row. */
export function discoverItemCard(item: DiscoverItem, notedSentiment?: string): string {
  const id = item.atlas_item_id;
  if (notedSentiment) {
    const word =
      notedSentiment === "interested" ? "Interested"
      : notedSentiment === "skipped" ? "Skipped"
      : "Not for me";
    return `<div class="tma-card dv-card" id="dv-item-${id}">
      <div class="dv-vt">${escapeHtml(truncate(item.title, 120))}</div>
      <div class="dv-noted">✓ ${escapeHtml(word)}</div>
    </div>`;
  }
  const openBtn = item.url
    ? `<a class="tma-btn tma-btn-primary dv-open" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">${actionLabel(item.discover_source)}</a>`
    : `<span class="dv-open"></span>`;
  const pct = item.discover_source === "youtube_discovery" ? matchPct(item) : null;
  const snippet = markdownSnippet(item.body, 200, item.title);
  return `<div class="tma-card dv-card" id="dv-item-${id}"
    data-tma-filter-item
    data-tma-filter-text="${escapeAttr(`${item.title} ${item.channel_title ?? ""}`.toLowerCase())}"
    data-source="${escapeAttr(SOURCE_GROUP[item.discover_source])}"
    data-date="${escapeAttr(item.captured_at ?? "")}"
    data-match="${pct ?? 0}"
    data-title="${escapeAttr(item.title.toLowerCase())}">
    <div class="dv-vt">${escapeHtml(truncate(item.title, 120))}</div>
    <div>${metaLine(item)}</div>
    ${snippet ? `<div class="dv-vs">${escapeHtml(snippet)}</div>` : ""}
    <div class="dv-acts">
      ${openBtn}
      <button type="button" class="dv-icon up" title="Interesting"
        hx-get="/tma/api/discover/item/${id}/feedback?s=interested"
        hx-target="#dv-item-${id}" hx-swap="beforeend">👍</button>
      <button type="button" class="dv-icon down" title="Not for me"
        hx-get="/tma/api/discover/item/${id}/feedback?s=not_interested"
        hx-target="#dv-item-${id}" hx-swap="beforeend">👎</button>
      <button type="button" class="tma-btn tma-btn-secondary" title="Skip"
        hx-post="/tma/api/discover/skip?item=${id}"
        hx-target="#dv-item-${id}" hx-swap="outerHTML">Skip</button>
    </div>
  </div>`;
}

const FILTER_OPTS = [
  { value: "new", label: "New" },
  { value: "interested", label: "Interested" },
  { value: "all", label: "All" },
];

const SOURCE_CHIPS = [
  { value: "all", label: "All" },
  { value: "yt", label: "🎬 Videos" },
  { value: "gh", label: "⭐ Repos" },
  { value: "rd", label: "👽 Reddit" },
];

export function discoverItemsFragment(items: DiscoverItem[]): string {
  if (items.length === 0) {
    return emptyState("✅", "Nothing here", "No items match this filter.");
  }
  return items
    .map((it) => discoverItemCard(it, it.feedback_sentiment ?? undefined))
    .join("\n");
}

export function tmaDiscoverGroupPage(opts: {
  group: DiscoverGroup;
  items: DiscoverItem[];
  filter: ItemFilter;
}): string {
  const { group, items, filter } = opts;
  const stateChips = filterChips(
    "dv-filter",
    FILTER_OPTS.map((o) => ({ ...o, href: `/tma/discover/${encodeURIComponent(group.slug)}?filter=${o.value}` })),
    filter,
  );
  // Source chips filter client-side (data-source) via the shared chip helper.
  const srcChips = filterChips("source", SOURCE_CHIPS, "all");
  const skipAll = filter === "new" && items.length > 0
    ? `<button type="button" class="tma-btn tma-btn-secondary"
        hx-post="/tma/api/discover/skip-group?group=${group.id}"
        hx-target="#dv-list" hx-swap="innerHTML"
        hx-confirm="Skip all ${items.length} new items in this topic?">Skip all</button>`
    : "";
  const body = `
    ${STYLE}
    ${pageHeader(`${group.emoji || "✨"} ${group.label}`, {
      actions: `<a href="/tma/discover" class="tma-link" style="font-size:var(--fs-sm);">← Discover</a>`,
    })}
    <div style="padding:0 var(--sp-3) var(--sp-1);">${stateChips}</div>
    <div class="tma-search-scope" data-tma-filter-scope>
      <div class="dv-tools">
        <div class="tma-search">
          <input type="search" placeholder="Search this topic…" oninput="tmaFilter(this)" autocomplete="off">
        </div>
        ${sortSelect([
          { value: "date", label: "Newest" },
          { value: "match", label: "Best match" },
          { value: "title", label: "A–Z" },
        ])}
        ${skipAll}
      </div>
      <div class="dv-srcrow">${srcChips}</div>
      <div class="dv-list" id="dv-list" data-dv-list>
        ${discoverItemsFragment(items)}
      </div>
      <div data-tma-filter-empty style="display:none;">${emptyState("🔍", "No matches")}</div>
    </div>
  `;
  return miniAppLayout("discover", body, false);
}

// ---------------------------------------------------------------------------
// Inline feedback panel (fragment appended into the item card)
// ---------------------------------------------------------------------------

function chip(value: string, generic: boolean): string {
  return `<label class="dv-chip${generic ? "" : " gen"}"><input type="checkbox" name="reason[]" value="${escapeAttr(value)}">${escapeHtml(value)}</label>`;
}

/** Just the agent-generated chips — served lazily so the panel opens instantly
 *  on the generic chips while the LLM call (if any) resolves in the background. */
export function discoverGeneratedChips(chips: string[]): string {
  return chips.map((v) => chip(v, false)).join("");
}

export function discoverFeedbackPanel(opts: {
  itemId: number;
  sentiment: "interested" | "not_interested";
  generic: string[];
}): string {
  const { itemId, sentiment, generic } = opts;
  const q = sentiment === "interested" ? "What makes it interesting?" : "Why not for you?";
  const genericHtml = generic.map((v) => chip(v, true)).join("");
  return `<form class="dv-fb" id="dv-fb-${itemId}">
    <input type="hidden" name="item" value="${itemId}">
    <input type="hidden" name="sentiment" value="${escapeAttr(sentiment)}">
    <div class="dv-q">${escapeHtml(q)}</div>
    <div class="dv-chips">
      ${genericHtml}
      <span class="dv-genwrap"
        hx-get="/tma/api/discover/item/${itemId}/chips?s=${escapeAttr(sentiment)}"
        hx-trigger="load" hx-swap="outerHTML">
        <span class="dv-genload">✨ more…</span>
      </span>
    </div>
    <input class="dv-note" type="text" name="note" placeholder="Add a note (optional)…" autocomplete="off">
    <button type="button" class="tma-btn tma-btn-primary tma-btn-sm"
      hx-post="/tma/api/discover/feedback"
      hx-include="#dv-fb-${itemId}"
      hx-target="#dv-item-${itemId}"
      hx-swap="outerHTML">Submit feedback</button>
  </form>`;
}
