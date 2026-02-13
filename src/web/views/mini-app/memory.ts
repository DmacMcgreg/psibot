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
  const snippet = entry.content.length > 120
    ? entry.content.slice(0, 120) + "..."
    : entry.content;
  return `<div class="tma-card">
    <div style="font-weight:600; font-size:14px;">${escapeHtml(entry.title)}</div>
    <div class="tma-hint" style="margin-top:2px; font-size:12px;">${escapeHtml(entry.file_path)}</div>
    <div style="margin-top:6px; font-size:13px; line-height:1.4;">${escapeHtml(snippet)}</div>
  </div>`;
}

export function tmaMemoryListFragment(entries: MemoryEntry[]): string {
  if (entries.length === 0) return `<div class="tma-empty">No results</div>`;
  return entries.map((e) => tmaMemoryCard(e)).join("\n");
}
