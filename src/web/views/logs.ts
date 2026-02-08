import { layout } from "./layout.ts";
import { statusBadge, emptyState } from "./components.ts";
import { escapeHtml } from "../../shared/html.ts";
import type { JobRun, Job } from "../../shared/types.ts";

interface RunWithJob extends JobRun {
  job_name?: string;
}

export function logsPage(runs: RunWithJob[]): string {
  const runList =
    runs.length > 0
      ? `<div class="divide-y divide-zinc-800">
          ${runs.map((r) => runRow(r)).join("\n")}
        </div>`
      : emptyState("No job runs yet");

  return layout(
    "Logs",
    "logs",
    `<div class="flex flex-col h-full">
      <div class="flex items-center justify-between p-4 border-b border-zinc-800 shrink-0">
        <h1 class="text-lg font-semibold text-white">Job Run Logs</h1>
        <button
          hx-get="/api/logs"
          hx-target="#log-list"
          hx-swap="innerHTML"
          class="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
        >Refresh</button>
      </div>
      <div id="log-list" class="flex-1 overflow-y-auto">
        ${runList}
      </div>
    </div>`
  );
}

function runRow(run: RunWithJob): string {
  const cost = run.cost_usd ? `$${run.cost_usd.toFixed(4)}` : "-";
  const duration = run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : "-";

  return `<details class="group">
    <summary class="p-4 hover:bg-zinc-900/50 cursor-pointer list-none">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3 min-w-0">
          ${statusBadge(run.status)}
          <span class="text-sm text-white truncate">${escapeHtml(run.job_name ?? `Job #${run.job_id}`)}</span>
        </div>
        <div class="flex items-center gap-3 text-xs text-zinc-500 shrink-0">
          <span>${cost}</span>
          <span>${duration}</span>
          <span>${escapeHtml(run.started_at)}</span>
          <span class="group-open:rotate-180 transition-transform">&#9660;</span>
        </div>
      </div>
    </summary>
    <div class="px-4 pb-4">
      ${
        run.result
          ? `<div class="bg-zinc-900 rounded-lg p-3 text-sm text-zinc-300 whitespace-pre-wrap">${escapeHtml(run.result)}</div>`
          : ""
      }
      ${
        run.error
          ? `<div class="bg-red-900/20 border border-red-900 rounded-lg p-3 text-sm text-red-400 mt-2 whitespace-pre-wrap">${escapeHtml(run.error)}</div>`
          : ""
      }
    </div>
  </details>`;
}

export function logListFragment(runs: RunWithJob[]): string {
  if (runs.length === 0) return emptyState("No job runs yet");
  return `<div class="divide-y divide-zinc-800">
    ${runs.map((r) => runRow(r)).join("\n")}
  </div>`;
}
