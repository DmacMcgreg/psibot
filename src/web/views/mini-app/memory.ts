import { miniAppLayout } from "./shell.ts";
import {
  pageHeader,
  searchBar,
  detailsPanel,
  emptyState,
  errorState,
  escapeHtml,
  escapeAttr,
} from "./components.ts";
import type { MemoryEntry } from "../../../shared/types.ts";

function memorySnippet(content: string): string {
  if (content.length <= 140) return content;
  return content.slice(0, 140).replace(/\s+\S*$/, "") + "…";
}

function memoryEntryPanel(entry: MemoryEntry): string {
  const raw = escapeHtml(entry.content);
  const attrRaw = escapeAttr(entry.content);
  const summary = `${entry.title}  ·  ${entry.file_path}`;
  const inner = `<div class="tma-hint" style="margin-bottom:var(--sp-2);">${memorySnippet(escapeHtml(entry.content))}</div>
    <div style="display:flex; gap:var(--sp-2); align-items:center; margin-bottom:var(--sp-2);" data-md-toggle-root>
      <button type="button" class="tma-btn tma-btn-sm tma-btn-secondary" onclick="window.toggleMdView(this); event.stopPropagation();">Raw</button>
      <span class="tma-hint">${entry.content.length.toLocaleString()} chars</span>
    </div>
    <div class="md-rendered tma-md" data-md data-md-src="${attrRaw}"></div>
    <pre class="md-raw tma-mono" style="display:none; white-space:pre-wrap; word-break:break-word;">${raw}</pre>`;
  return detailsPanel(summary, inner);
}

function memoryList(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return emptyState("🗂️", "No memory entries", "Nothing indexed yet.");
  }
  return entries.map(memoryEntryPanel).join("\n");
}

// NOTE: Memory scope is deliberately narrow — agent-context files only
// (identity/user/tools/heartbeat/memory.md + per-agent memory dirs). Daily
// logs, research, trading, weekly rollups and scans are content, not
// context, and surface only in Library (Atlas). See src/memory/index.ts
// MEMORY_INCLUDE_* for the enforced boundary; getAllMemoryEntries() /
// searchMemory() only ever return rows within that scope.

export function tmaMemoryPage(entries: MemoryEntry[]): string {
  const body = `
    ${pageHeader("Agent Memory", { subtitle: "Identity, user context & learned notes" })}
    <div class="tma-search-scope">
      <div style="padding:0 var(--sp-4);">
        ${searchBar("/tma/api/memory/search", "Search memory…")}
      </div>
      <div class="tma-section" id="memory-list">
        ${memoryList(entries)}
      </div>
    </div>
  `;
  return miniAppLayout("memory", body);
}

/**
 * NOTE for foundation agents: the search results fragment must replace the
 * whole `.tma-search-scope` innerHTML (searchBar()'s hx-target is
 * `closest .tma-search-scope`), which re-submits the input itself. We rebuild
 * the input + list together here so the swap doesn't drop the search box.
 */
export function tmaMemoryListFragment(entries: MemoryEntry[], query = ""): string {
  return `<div style="padding:0 var(--sp-4);">
      ${searchBar("/tma/api/memory/search", "Search memory…", query)}
    </div>
    <div class="tma-section" id="memory-list">
      ${memoryList(entries)}
    </div>`;
}

export function tmaMemoryErrorFragment(message: string): string {
  return errorState(message, "/tma/api/memory/search");
}
