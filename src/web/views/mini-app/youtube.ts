import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { StoredVideo } from "../../../youtube/db.ts";

export function tmaYoutubePage(videos: StoredVideo[], totalCount: number): string {
  const list = videos.length > 0
    ? videos.map((v) => tmaVideoCard(v)).join("\n")
    : `<div class="tma-empty">No videos yet. Send a YouTube URL to the bot.</div>`;

  return miniAppLayout("youtube", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:4px;">YouTube</h2>
        <div class="tma-hint" style="font-size:12px; margin-bottom:8px;">${totalCount.toLocaleString()} videos processed</div>
        <form hx-get="/tma/api/youtube/search" hx-target="#youtube-list" hx-swap="innerHTML"
          hx-trigger="submit, input from:input delay:300ms">
          <input type="text" name="q" placeholder="Search title, channel, tags..." class="tma-input" autocomplete="off">
        </form>
      </div>
      <div id="youtube-list">
        ${list}
      </div>
    </div>
  `);
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
    `<span class="tma-pill" style="font-size:11px;">${escapeHtml(t)}</span>`
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
          <div class="tma-hint" style="margin-top:2px; font-size:12px;">${escapeHtml(video.channel_title)}${processedDate ? ` &middot; ${escapeHtml(processedDate)}` : ""}</div>
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
