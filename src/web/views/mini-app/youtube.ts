import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  pageHeader,
  badge,
  searchBar,
  emptyState,
  errorState,
  formatDate,
  markdownSnippet,
} from "./components.ts";
import type { StoredVideo } from "../../../youtube/db.ts";

export interface YoutubeFilter {
  tag?: string;
  channel?: string;
  keyword?: string;
}

const HEADER_ACTIONS = `
  <a href="/tma/youtube/tags" class="tma-btn tma-btn-secondary tma-btn-sm">Tags</a>
  <a href="/tma/youtube/channels" class="tma-btn tma-btn-secondary tma-btn-sm">Channels</a>
  <a href="/tma/youtube/graph" class="tma-btn tma-btn-secondary tma-btn-sm">Graph</a>
`;

export function tmaYoutubePage(
  videos: StoredVideo[],
  totalCount: number,
  filter: YoutubeFilter = {}
): string {
  const activeFilters = buildFilterPills(filter);
  const resultLabel = filter.tag || filter.channel
    ? `${videos.length.toLocaleString()} of ${totalCount.toLocaleString()}`
    : `${totalCount.toLocaleString()} videos processed`;

  const list = renderVideoList(videos);

  return miniAppLayout(
    "youtube",
    `
    ${pageHeader("YouTube", { subtitle: resultLabel, actions: HEADER_ACTIONS })}
    <div style="padding:0 var(--sp-4) var(--sp-2);">
      ${activeFilters}
      <form hx-get="/tma/api/youtube/search" hx-target="#youtube-list" hx-swap="innerHTML"
        hx-trigger="submit, input from:input delay:300ms" hx-include="[name='tag'],[name='channel']"
        hx-indicator="#youtube-list-indicator">
        <input type="hidden" name="tag" value="${escapeAttr(filter.tag ?? "")}">
        <input type="hidden" name="channel" value="${escapeAttr(filter.channel ?? "")}">
        <div class="tma-search" style="padding:0;">
          <input type="search" name="q" placeholder="Search title, channel, tags…" autocomplete="off"
            value="${escapeAttr(filter.keyword ?? "")}">
        </div>
      </form>
    </div>
    <div id="youtube-list-indicator" class="htmx-indicator tma-hint" style="padding:0 var(--sp-4) var(--sp-2); font-size:var(--fs-xs);">Searching…</div>
    <div id="youtube-list">
      ${list}
    </div>
  `,
    false
  );
}

function buildFilterPills(filter: YoutubeFilter): string {
  const pills: string[] = [];
  if (filter.tag) {
    pills.push(
      `<a href="/tma/youtube" class="tma-chip tma-chip-active">Tag: ${escapeHtml(filter.tag)} &times;</a>`
    );
  }
  if (filter.channel) {
    pills.push(
      `<a href="/tma/youtube" class="tma-chip tma-chip-active">Channel: ${escapeHtml(filter.channel)} &times;</a>`
    );
  }
  if (pills.length === 0) return "";
  return `<div style="display:flex; gap:var(--sp-2); margin-bottom:var(--sp-2); flex-wrap:wrap;">${pills.join("")}</div>`;
}

function renderVideoList(videos: StoredVideo[]): string {
  if (videos.length === 0) {
    return emptyState("📺", "No videos yet", "Send a YouTube URL to the bot to get started.");
  }
  return videos.map((v) => tmaVideoCard(v)).join("\n");
}

export function tmaVideoListFragment(videos: StoredVideo[]): string {
  if (videos.length === 0) {
    return emptyState("🔍", "No matches", "Try a different search term or clear filters.");
  }
  return videos.map((v) => tmaVideoCard(v)).join("\n");
}

export function tmaVideoErrorFragment(message: string): string {
  return errorState(message);
}

// Transcript-pipeline metadata tags — not user-meaningful, hide from cards.
const META_TAGS = new Set(["auto-generated", "fallback", "manual", "whisper", "captions"]);

function tmaVideoCard(video: StoredVideo): string {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(video.tags);
    if (Array.isArray(parsed)) {
      tags = parsed.filter((t) => typeof t === "string" && !META_TAGS.has(t.toLowerCase()));
    }
  } catch {
    /* empty */
  }

  const tagPills = tags
    .slice(0, 4)
    .map(
      (t) =>
        `<a href="/tma/youtube?tag=${encodeURIComponent(t)}" class="tma-pill" onclick="event.stopPropagation();">${escapeHtml(t)}</a>`
    )
    .join(" ");
  const tagsOverflow = tags.length > 4 ? `<span class="tma-hint" style="font-size:var(--fs-xs);">+${tags.length - 4}</span>` : "";

  const summarySnippet = markdownSnippet(video.markdown_summary, 160, video.title);
  const processedDate = video.processed_at ? formatDate(video.processed_at) : "";
  const raw = escapeHtml(video.markdown_summary ?? "");
  const attrRaw = escapeAttr(video.markdown_summary ?? "");
  const cardId = `yt-${escapeAttr(video.video_id)}`;
  const isDone = video.processing_status === "complete" || video.processing_status === "marked_processed";
  const statusPill = isDone ? "" : badge(video.processing_status, "warn");

  const channelLink = `<a href="/tma/youtube?channel=${encodeURIComponent(video.channel_title)}" style="color:inherit; text-decoration:underline;"
    onclick="event.stopPropagation();">${escapeHtml(video.channel_title)}</a>`;

  return `<details class="tma-card" id="${cardId}" data-md-toggle-root
    ontoggle="if(this.open){if(window.renderMarkdown)window.renderMarkdown();}">
    <summary style="cursor:pointer; list-style:none; min-height:var(--touch); display:flex; align-items:flex-start;">
      <div style="display:flex; gap:var(--sp-2); align-items:flex-start; width:100%;">
        <div style="min-width:0; flex:1;">
          <div style="font-weight:600; font-size:var(--fs-md); line-height:1.3;">${escapeHtml(video.title)}</div>
          <div class="tma-hint" style="margin-top:2px; font-size:var(--fs-xs);">
            ${channelLink}${processedDate ? ` &middot; ${escapeHtml(processedDate)}` : ""}
          </div>
          ${tagPills || tagsOverflow ? `<div style="display:flex; gap:var(--sp-1); margin-top:var(--sp-1); flex-wrap:wrap; align-items:center;">${tagPills} ${tagsOverflow}</div>` : ""}
          ${summarySnippet ? `<div class="tma-hint" style="margin-top:var(--sp-1); font-size:var(--fs-xs); line-height:1.4;">${escapeHtml(summarySnippet)}</div>` : ""}
        </div>
        ${statusPill}
      </div>
    </summary>

    <div style="display:flex; gap:var(--sp-2); align-items:center; margin:var(--sp-3) 0 var(--sp-2); flex-wrap:wrap;">
      <a href="${escapeAttr(video.url)}" target="_blank" rel="noopener" class="tma-btn tma-btn-sm">Open</a>
      <button type="button" class="tma-btn tma-btn-secondary tma-btn-sm"
        onclick="window.toggleMdView(this); event.stopPropagation();">Raw</button>
      <span class="tma-hint" style="font-size:var(--fs-xs);">${video.markdown_summary.length.toLocaleString()} chars</span>
    </div>

    <div class="md-rendered tma-md" data-md data-md-src="${attrRaw}" style="font-size:var(--fs-sm);"></div>
    <pre class="md-raw tma-mono" style="display:none; white-space:pre-wrap; word-break:break-word; background:var(--tma-surface); color:var(--tma-text); padding:var(--sp-3); border-radius:var(--rad-sm); margin:0;">${raw}</pre>
  </details>`;
}


// ---------------------------------------------------------------------------
// Tags / Channels pages
// ---------------------------------------------------------------------------

function tmaBrowseListPage(opts: {
  activePage: string;
  title: string;
  totalLabel: string;
  placeholder: string;
  emptyTitle: string;
  rows: Array<{ label: string; count: number; href: string }>;
}): string {
  const rows = opts.rows
    .map(
      (r) => `<a href="${escapeAttr(r.href)}" class="tma-list-row" data-tma-filter-item data-tma-filter-text="${escapeAttr(r.label)}">
        <div class="tma-list-row-body">
          <div class="tma-list-row-title">${escapeHtml(r.label)}</div>
        </div>
        <div class="tma-list-row-aside"><span class="tma-hint" style="font-size:var(--fs-xs);">${r.count.toLocaleString()}</span></div>
      </a>`
    )
    .join("\n");

  const list = opts.rows.length > 0 ? rows : emptyState("🗂️", opts.emptyTitle);

  return miniAppLayout(
    opts.activePage,
    `
    ${pageHeader(opts.title, { subtitle: opts.totalLabel })}
    <div data-tma-filter-scope>
      <div style="padding:0 var(--sp-4) var(--sp-2);">
        ${searchBar("", opts.placeholder)}
      </div>
      <div id="browse-list">
        ${list}
        <div data-tma-filter-empty style="display:none;">${emptyState("🔍", "No matches")}</div>
      </div>
    </div>
  `,
    false
  );
}

export function tmaYoutubeTagsPage(tags: Array<{ tag: string; count: number }>): string {
  return tmaBrowseListPage({
    activePage: "youtube",
    title: "Tags",
    totalLabel: `${tags.length.toLocaleString()} unique tags`,
    placeholder: "Filter tags…",
    emptyTitle: "No tags yet",
    rows: tags.map((t) => ({ label: t.tag, count: t.count, href: `/tma/youtube?tag=${encodeURIComponent(t.tag)}` })),
  });
}

export function tmaYoutubeChannelsPage(channels: Array<{ channel: string; count: number }>): string {
  return tmaBrowseListPage({
    activePage: "youtube",
    title: "Channels",
    totalLabel: `${channels.length.toLocaleString()} unique channels`,
    placeholder: "Filter channels…",
    emptyTitle: "No channels yet",
    rows: channels.map((c) => ({ label: c.channel, count: c.count, href: `/tma/youtube?channel=${encodeURIComponent(c.channel)}` })),
  });
}
