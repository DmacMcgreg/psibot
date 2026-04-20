import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { MemoryEntry } from "../../../shared/types.ts";

export function tmaMemoryPage(entries: MemoryEntry[]): string {
  const entryList = entries.length > 0
    ? entries.map((e) => tmaMemoryCard(e)).join("\n")
    : `<div class="tma-empty">No memory entries</div>`;

  return miniAppLayout("memory", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:8px;">Memory</h2>
        <form hx-get="/tma/api/memory/search" hx-target="#memory-list" hx-swap="innerHTML">
          <input type="text" name="q" placeholder="Search memory..." class="tma-input" autocomplete="off">
        </form>
      </div>
      <div id="memory-list">
        ${entryList}
      </div>
    </div>
  `);
}

function tmaMemoryCard(entry: MemoryEntry): string {
  const snippet = entry.content.length > 140
    ? entry.content.slice(0, 140).replace(/\s+\S*$/, "") + "\u2026"
    : entry.content;
  const cardId = `mem-${entry.id}`;
  const raw = escapeHtml(entry.content);

  return `<details class="tma-card" id="${cardId}" data-md-toggle-root
    ontoggle="if(this.open){if(window.renderMarkdown)window.renderMarkdown();}">
    <summary style="cursor:pointer; list-style:none;">
      <div style="font-weight:600; font-size:14px;">${escapeHtml(entry.title)}</div>
      <div class="tma-hint" style="margin-top:2px; font-size:12px;">${escapeHtml(entry.file_path)}</div>
      <div class="md-snippet" style="margin-top:6px; font-size:13px; line-height:1.4; color:var(--tg-theme-hint-color, #6b7280);">${escapeHtml(snippet)}</div>
    </summary>

    <div style="display:flex; gap:8px; align-items:center; margin:10px 0 8px;">
      <button type="button" class="tma-btn" style="font-size:12px; padding:4px 10px;"
        onclick="window.toggleMdView(this); event.stopPropagation();">Raw</button>
      <span class="tma-hint" style="font-size:11px;">${entry.content.length.toLocaleString()} chars</span>
    </div>

    <div class="md-rendered" data-md data-md-src="${raw}" style="font-size:13px; line-height:1.5;"></div>
    <pre class="md-raw" style="display:none; font-size:12px; white-space:pre-wrap; word-break:break-word; background:var(--tg-theme-bg-color, #0f0f0f); color:var(--tg-theme-text-color, #fafafa); padding:10px; border-radius:6px; margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;">${raw}</pre>
  </details>`;
}

export function tmaMemoryListFragment(entries: MemoryEntry[]): string {
  if (entries.length === 0) return `<div class="tma-empty">No results</div>`;
  return entries.map((e) => tmaMemoryCard(e)).join("\n");
}
