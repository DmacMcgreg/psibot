import { layout } from "./layout.ts";
import { escapeHtml } from "../../shared/html.ts";

export function memoryPage(
  files: string[],
  activeFile?: string,
  content?: string
): string {
  const fileList = files
    .map(
      (f) =>
        `<a href="/memory?file=${encodeURIComponent(f)}" class="block px-3 py-2 text-sm rounded-lg transition-colors ${
          f === activeFile
            ? "bg-indigo-600/20 text-indigo-400"
            : "text-zinc-400 hover:text-white hover:bg-zinc-800"
        }">${escapeHtml(f)}</a>`
    )
    .join("\n");

  const contentArea = content
    ? `<div class="h-full flex flex-col">
        <div class="flex items-center justify-between px-4 py-2 border-b border-zinc-800 shrink-0">
          <span class="text-sm font-medium text-white">${escapeHtml(activeFile ?? "")}</span>
          <button
            hx-get="/memory/edit?file=${encodeURIComponent(activeFile ?? "")}"
            hx-target="#content-area"
            hx-swap="innerHTML"
            class="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
          >Edit</button>
        </div>
        <div id="content-area" class="flex-1 overflow-y-auto p-4">
          <div class="prose prose-invert prose-sm">${escapeHtml(content)}</div>
        </div>
      </div>`
    : `<div class="flex items-center justify-center h-full text-zinc-500 text-sm">Select a file to view</div>`;

  return layout(
    "Memory",
    "memory",
    `<div class="flex h-full">
      <div class="w-48 border-r border-zinc-800 overflow-y-auto p-2 shrink-0">
        <div class="mb-2">
          <input
            type="text"
            placeholder="Search..."
            hx-get="/api/memory/search"
            hx-trigger="input changed delay:300ms"
            hx-target="#search-results"
            hx-swap="innerHTML"
            name="q"
            class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-white placeholder-zinc-500"
          >
          <div id="search-results" class="mt-1"></div>
        </div>
        <div class="space-y-0.5">
          ${fileList}
        </div>
      </div>
      <div class="flex-1 min-w-0">
        ${contentArea}
      </div>
    </div>`
  );
}

export function memoryEditFragment(filePath: string, content: string): string {
  return `<form
    hx-post="/api/memory/save"
    hx-target="#content-area"
    hx-swap="innerHTML"
    class="h-full flex flex-col"
  >
    <input type="hidden" name="file" value="${escapeHtml(filePath)}">
    <textarea
      name="content"
      class="flex-1 w-full bg-zinc-900 text-zinc-100 text-sm font-mono p-4 resize-none focus:outline-none"
    >${escapeHtml(content)}</textarea>
    <div class="flex justify-end gap-2 p-3 border-t border-zinc-800">
      <a href="/memory?file=${encodeURIComponent(filePath)}" class="px-3 py-1.5 text-sm text-zinc-400 hover:text-white">Cancel</a>
      <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium">Save</button>
    </div>
  </form>`;
}

export function memorySearchResults(
  results: Array<{ path: string; title: string; snippet: string }>
): string {
  if (results.length === 0) {
    return `<div class="text-xs text-zinc-500 p-1">No results</div>`;
  }
  return results
    .map(
      (r) =>
        `<a href="/memory?file=${encodeURIComponent(r.path)}" class="block p-1.5 rounded text-xs hover:bg-zinc-800">
          <div class="text-zinc-300 font-medium">${escapeHtml(r.title)}</div>
          <div class="text-zinc-500 truncate">${escapeHtml(r.snippet)}</div>
        </a>`
    )
    .join("");
}
