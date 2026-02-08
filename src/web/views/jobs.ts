import { layout } from "./layout.ts";
import { statusBadge, emptyState, button } from "./components.ts";
import { escapeHtml } from "../../shared/html.ts";
import type { Job } from "../../shared/types.ts";

export function jobsPage(jobs: Job[]): string {
  const jobList =
    jobs.length > 0
      ? `<div class="divide-y divide-zinc-800">
          ${jobs.map((j) => jobCard(j)).join("\n")}
        </div>`
      : emptyState("No jobs configured");

  return layout(
    "Jobs",
    "jobs",
    `<div class="flex flex-col h-full">
      <div class="flex items-center justify-between p-4 border-b border-zinc-800 shrink-0">
        <h1 class="text-lg font-semibold text-white">Scheduled Jobs</h1>
        <button
          hx-get="/api/jobs/new"
          hx-target="#job-modal"
          hx-swap="innerHTML"
          class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >New Job</button>
      </div>
      <div id="job-list" class="flex-1 overflow-y-auto">
        ${jobList}
      </div>
      <div id="job-modal"></div>
    </div>`
  );
}

function jobCard(job: Job): string {
  const typeLabel = job.type === "cron" ? `Cron: ${escapeHtml(job.schedule ?? "")}` : `Once: ${escapeHtml(job.run_at ?? "")}`;
  return `<div class="p-4 hover:bg-zinc-900/50">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-medium text-sm text-white truncate">${escapeHtml(job.name)}</span>
          ${statusBadge(job.status)}
        </div>
        <p class="text-xs text-zinc-400 truncate">${escapeHtml(job.prompt.slice(0, 100))}</p>
        <div class="flex items-center gap-3 mt-1.5 text-xs text-zinc-500">
          <span>${typeLabel}</span>
          <span>Budget: $${job.max_budget_usd.toFixed(2)}</span>
          ${job.next_run_at ? `<span>Next: ${escapeHtml(job.next_run_at)}</span>` : ""}
        </div>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <button
          hx-post="/api/jobs/${job.id}/trigger"
          hx-target="#job-list"
          hx-swap="innerHTML"
          class="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
        >Run</button>
        <button
          hx-post="/api/jobs/${job.id}/toggle"
          hx-target="#job-list"
          hx-swap="innerHTML"
          class="text-xs px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
        >${job.status === "enabled" ? "Disable" : "Enable"}</button>
        <button
          hx-delete="/api/jobs/${job.id}"
          hx-target="#job-list"
          hx-swap="innerHTML"
          hx-confirm="Delete this job?"
          class="text-xs px-2 py-1 bg-zinc-800 hover:bg-red-900/50 text-zinc-300 hover:text-red-400 rounded transition-colors"
        >Del</button>
      </div>
    </div>
  </div>`;
}

export function jobFormModal(job?: Job): string {
  const isEdit = !!job;
  return `<div class="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50" id="modal-overlay">
    <div class="bg-zinc-900 border border-zinc-800 rounded-t-2xl sm:rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
      <form
        hx-post="${isEdit ? `/api/jobs/${job!.id}` : "/api/jobs"}"
        hx-target="#job-list"
        hx-swap="innerHTML"
        hx-on::after-request="document.getElementById('modal-overlay')?.remove()"
      >
        <div class="p-4 border-b border-zinc-800 flex items-center justify-between">
          <h2 class="font-semibold text-white">${isEdit ? "Edit Job" : "New Job"}</h2>
          <button type="button" onclick="this.closest('#modal-overlay').remove()" class="text-zinc-400 hover:text-white">&times;</button>
        </div>
        <div class="p-4 space-y-3">
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Name</label>
            <input name="name" value="${escapeHtml(job?.name ?? "")}" required class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white">
          </div>
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Prompt</label>
            <textarea name="prompt" rows="3" required class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white">${escapeHtml(job?.prompt ?? "")}</textarea>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Type</label>
              <select name="type" class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white">
                <option value="cron" ${job?.type === "cron" ? "selected" : ""}>Cron</option>
                <option value="once" ${job?.type === "once" ? "selected" : ""}>One-off</option>
              </select>
            </div>
            <div>
              <label class="block text-xs text-zinc-400 mb-1">Budget ($)</label>
              <input name="max_budget_usd" type="number" step="0.01" value="${job?.max_budget_usd ?? 1.0}" class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white">
            </div>
          </div>
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Schedule (cron expression)</label>
            <input name="schedule" value="${escapeHtml(job?.schedule ?? "")}" placeholder="0 */6 * * *" class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white">
          </div>
          <div>
            <label class="block text-xs text-zinc-400 mb-1">Run At (for one-off, ISO datetime)</label>
            <input name="run_at" type="datetime-local" value="${job?.run_at?.replace(" ", "T") ?? ""}" class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white">
          </div>
          <div class="flex items-center gap-2">
            <input type="checkbox" name="use_browser" id="use_browser" ${job?.use_browser ? "checked" : ""} class="rounded border-zinc-600">
            <label for="use_browser" class="text-sm text-zinc-300">Enable browser</label>
          </div>
        </div>
        <div class="p-4 border-t border-zinc-800 flex justify-end gap-2">
          <button type="button" onclick="this.closest('#modal-overlay').remove()" class="px-3 py-1.5 text-sm text-zinc-400 hover:text-white">Cancel</button>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-sm font-medium">${isEdit ? "Save" : "Create"}</button>
        </div>
      </form>
    </div>
  </div>`;
}

export function jobListFragment(jobs: Job[]): string {
  if (jobs.length === 0) return emptyState("No jobs configured");
  return `<div class="divide-y divide-zinc-800">
    ${jobs.map((j) => jobCard(j)).join("\n")}
  </div>`;
}
