import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { StoredVideo } from "../../../youtube/db.ts";

export interface YoutubeFilter {
  tag?: string;
  channel?: string;
  keyword?: string;
}

export function tmaYoutubePage(
  videos: StoredVideo[],
  totalCount: number,
  filter: YoutubeFilter = {}
): string {
  const list = videos.length > 0
    ? videos.map((v) => tmaVideoCard(v)).join("\n")
    : `<div class="tma-empty">No videos yet. Send a YouTube URL to the bot.</div>`;

  const activeFilters = buildFilterPills(filter);
  const resultLabel = filter.tag || filter.channel
    ? `${videos.length.toLocaleString()} of ${totalCount.toLocaleString()}`
    : `${totalCount.toLocaleString()} videos processed`;

  return miniAppLayout("youtube", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; gap:6px;">
          <h2 style="font-size:18px; font-weight:600;">YouTube</h2>
          <div style="display:flex; gap:6px;">
            <a href="/tma/youtube/tags" class="tma-btn" style="font-size:12px; padding:4px 10px;">Tags</a>
            <a href="/tma/youtube/channels" class="tma-btn" style="font-size:12px; padding:4px 10px;">Channels</a>
            <a href="/tma/youtube/graph" class="tma-btn" style="font-size:12px; padding:4px 10px;">Graph</a>
          </div>
        </div>
        <div class="tma-hint" style="font-size:12px; margin-bottom:8px;">${resultLabel}</div>
        ${activeFilters}
        <form hx-get="/tma/api/youtube/search" hx-target="#youtube-list" hx-swap="innerHTML"
          hx-trigger="submit, input from:input delay:300ms" hx-include="[name='tag'],[name='channel']">
          <input type="hidden" name="tag" value="${filter.tag ? escapeHtml(filter.tag) : ""}">
          <input type="hidden" name="channel" value="${filter.channel ? escapeHtml(filter.channel) : ""}">
          <input type="text" name="q" placeholder="Search title, channel, tags..." class="tma-input" autocomplete="off"
            value="${filter.keyword ? escapeHtml(filter.keyword) : ""}">
        </form>
      </div>
      <div id="youtube-list">
        ${list}
      </div>
    </div>
  `);
}

function buildFilterPills(filter: YoutubeFilter): string {
  const pills: string[] = [];
  if (filter.tag) {
    pills.push(
      `<a href="/tma/youtube" class="tma-pill" style="background:#4f46e5; color:#fff; display:inline-flex; align-items:center; gap:4px;">
        Tag: ${escapeHtml(filter.tag)} <span style="opacity:0.8;">&times;</span>
      </a>`
    );
  }
  if (filter.channel) {
    pills.push(
      `<a href="/tma/youtube" class="tma-pill" style="background:#0891b2; color:#fff; display:inline-flex; align-items:center; gap:4px;">
        Channel: ${escapeHtml(filter.channel)} <span style="opacity:0.8;">&times;</span>
      </a>`
    );
  }
  if (pills.length === 0) return "";
  return `<div style="display:flex; gap:6px; margin-bottom:8px; flex-wrap:wrap;">${pills.join("")}</div>`;
}

export function tmaVideoListFragment(videos: StoredVideo[]): string {
  if (videos.length === 0) return `<div class="tma-empty">No matches</div>`;
  return videos.map((v) => tmaVideoCard(v)).join("\n");
}

function tmaVideoCard(video: StoredVideo): string {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(video.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch { /* empty */ }

  const tagPills = tags.slice(0, 4).map((t) =>
    `<a href="/tma/youtube?tag=${encodeURIComponent(t)}" class="tma-pill" style="font-size:11px; text-decoration:none;"
      onclick="event.stopPropagation();">${escapeHtml(t)}</a>`
  ).join(" ");
  const tagsOverflow = tags.length > 4 ? `<span class="tma-hint" style="font-size:11px;">+${tags.length - 4}</span>` : "";

  const summarySnippet = extractSnippet(video.markdown_summary, 160);
  const processedDate = video.processed_at ? video.processed_at.slice(0, 10) : "";
  const raw = escapeHtml(video.markdown_summary ?? "");
  const cardId = `yt-${video.video_id}`;
  const statusPill = video.processing_status === "complete" || video.processing_status === "marked_processed"
    ? ""
    : `<span class="tma-pill" style="background:#f59e0b20; color:#f59e0b; font-size:11px;">${escapeHtml(video.processing_status)}</span>`;

  return `<details class="tma-card" id="${cardId}" data-md-toggle-root
    ontoggle="if(this.open){if(window.renderMarkdown)window.renderMarkdown();}">
    <summary style="cursor:pointer; list-style:none;">
      <div style="display:flex; gap:8px; align-items:flex-start;">
        <div style="min-width:0; flex:1;">
          <div style="font-weight:600; font-size:14px; line-height:1.3;">${escapeHtml(video.title)}</div>
          <div class="tma-hint" style="margin-top:2px; font-size:12px;">
            <a href="/tma/youtube?channel=${encodeURIComponent(video.channel_title)}" style="color:inherit; text-decoration:underline;"
              onclick="event.stopPropagation();">${escapeHtml(video.channel_title)}</a>${processedDate ? ` &middot; ${escapeHtml(processedDate)}` : ""}
          </div>
          ${tagPills || tagsOverflow ? `<div style="display:flex; gap:4px; margin-top:6px; flex-wrap:wrap; align-items:center;">${tagPills} ${tagsOverflow}</div>` : ""}
          ${summarySnippet ? `<div style="margin-top:6px; font-size:12px; line-height:1.4; color:var(--tg-theme-hint-color, #6b7280);">${escapeHtml(summarySnippet)}</div>` : ""}
        </div>
        ${statusPill}
      </div>
    </summary>

    <div style="display:flex; gap:8px; align-items:center; margin:10px 0 8px; flex-wrap:wrap;">
      <a href="${escapeHtml(video.url)}" target="_blank" rel="noopener" class="tma-btn" style="font-size:12px; padding:4px 10px;">Open</a>
      <button type="button" class="tma-btn" style="font-size:12px; padding:4px 10px;"
        onclick="window.toggleMdView(this); event.stopPropagation();">Raw</button>
      <span class="tma-hint" style="font-size:11px;">${video.markdown_summary.length.toLocaleString()} chars</span>
    </div>

    <div class="md-rendered" data-md data-md-src="${raw}" style="font-size:13px; line-height:1.5;"></div>
    <pre class="md-raw" style="display:none; font-size:12px; white-space:pre-wrap; word-break:break-word; background:var(--tg-theme-bg-color, #0f0f0f); color:var(--tg-theme-text-color, #fafafa); padding:10px; border-radius:6px; margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;">${raw}</pre>
  </details>`;
}

function extractSnippet(markdown: string, maxLen: number): string {
  if (!markdown) return "";
  const cleaned = markdown
    .replace(/^#.*$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`>]/g, "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/\s+\S*$/, "") + "\u2026";
}

export function tmaYoutubeTagsPage(tags: Array<{ tag: string; count: number }>): string {
  const list = tags.length > 0
    ? tags.map((t) => `
        <a href="/tma/youtube?tag=${encodeURIComponent(t.tag)}" class="tma-card"
          style="display:flex; justify-content:space-between; align-items:center; text-decoration:none; color:inherit;">
          <span style="font-size:14px;">${escapeHtml(t.tag)}</span>
          <span class="tma-hint" style="font-size:12px;">${t.count}</span>
        </a>
      `).join("\n")
    : `<div class="tma-empty">No tags yet</div>`;

  return miniAppLayout("youtube", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <a href="/tma/youtube" class="tma-btn" style="font-size:12px; padding:4px 10px;">&larr; Back</a>
          <h2 style="font-size:18px; font-weight:600;">Tags</h2>
        </div>
        <div class="tma-hint" style="font-size:12px; margin-bottom:8px;">${tags.length.toLocaleString()} unique tags</div>
        <input type="text" class="tma-input" placeholder="Filter tags..." autocomplete="off"
          oninput="filterList(this.value, '.tma-card')">
      </div>
      <div id="tag-list">
        ${list}
      </div>
    </div>
    <script>
      window.filterList = function(q, selector) {
        q = (q || '').toLowerCase();
        document.querySelectorAll(selector).forEach(function(el) {
          var text = el.textContent.toLowerCase();
          el.style.display = text.indexOf(q) >= 0 ? '' : 'none';
        });
      };
    </script>
  `);
}

export function tmaYoutubeChannelsPage(channels: Array<{ channel: string; count: number }>): string {
  const list = channels.length > 0
    ? channels.map((c) => `
        <a href="/tma/youtube?channel=${encodeURIComponent(c.channel)}" class="tma-card"
          style="display:flex; justify-content:space-between; align-items:center; text-decoration:none; color:inherit;">
          <span style="font-size:14px;">${escapeHtml(c.channel)}</span>
          <span class="tma-hint" style="font-size:12px;">${c.count}</span>
        </a>
      `).join("\n")
    : `<div class="tma-empty">No channels yet</div>`;

  return miniAppLayout("youtube", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <a href="/tma/youtube" class="tma-btn" style="font-size:12px; padding:4px 10px;">&larr; Back</a>
          <h2 style="font-size:18px; font-weight:600;">Channels</h2>
        </div>
        <div class="tma-hint" style="font-size:12px; margin-bottom:8px;">${channels.length.toLocaleString()} unique channels</div>
        <input type="text" class="tma-input" placeholder="Filter channels..." autocomplete="off"
          oninput="filterList(this.value, '.tma-card')">
      </div>
      <div id="channel-list">
        ${list}
      </div>
    </div>
    <script>
      window.filterList = function(q, selector) {
        q = (q || '').toLowerCase();
        document.querySelectorAll(selector).forEach(function(el) {
          var text = el.textContent.toLowerCase();
          el.style.display = text.indexOf(q) >= 0 ? '' : 'none';
        });
      };
    </script>
  `);
}
