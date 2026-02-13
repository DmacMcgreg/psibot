import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { Job } from "../../../shared/types.ts";

export function tmaJobsPage(jobs: Job[]): string {
  const jobList = jobs.length > 0
    ? jobs.map((j) => tmaJobCard(j)).join("\n")
    : `<div class="tma-empty">No jobs configured</div>`;

  return miniAppLayout("jobs", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
        <h2 style="font-size:18px; font-weight:600;">Jobs</h2>
      </div>
      <div id="job-list">
        ${jobList}
      </div>
    </div>
  `);
}

function isPaused(job: Job): boolean {
  if (job.paused_until) {
    const until = new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z");
    if (until > new Date()) return true;
  }
  return job.skip_runs > 0;
}

function tmaJobCard(job: Job): string {
  const schedule = job.type === "cron" && job.schedule ? job.schedule : job.run_at ?? "";
  const paused = isPaused(job);
  const statusCls = paused ? "tma-badge-paused" : job.status === "enabled" ? "tma-badge-enabled" : "tma-badge-disabled";
  const statusLabel = paused ? "Paused" : job.status;
  const toggleLabel = job.status === "enabled" ? "Disable" : "Enable";

  return `<div class="tma-card">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px;">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:14px;">${escapeHtml(job.name)}</div>
        <div class="tma-hint" style="margin-top:2px;">${escapeHtml(schedule)}</div>
        <div class="tma-hint" style="margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(job.prompt.slice(0, 60))}</div>
      </div>
      <span class="tma-badge ${statusCls}">${statusLabel}</span>
    </div>
    <div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">
      <button class="tma-btn tma-btn-sm" hx-post="/tma/api/jobs/${job.id}/trigger" hx-target="#job-list" hx-swap="innerHTML">Run</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/jobs/${job.id}/toggle" hx-target="#job-list" hx-swap="innerHTML">${toggleLabel}</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/jobs/${job.id}/pause" hx-target="#job-list" hx-swap="innerHTML">${paused ? "Unpause" : "Pause 24h"}</button>
      <button class="tma-btn tma-btn-sm tma-btn-danger" hx-post="/tma/api/jobs/${job.id}/delete" hx-target="#job-list" hx-swap="innerHTML" hx-confirm="Delete this job?">Delete</button>
    </div>
  </div>`;
}

export function tmaJobListFragment(jobs: Job[]): string {
  if (jobs.length === 0) return `<div class="tma-empty">No jobs configured</div>`;
  return jobs.map((j) => tmaJobCard(j)).join("\n");
}
