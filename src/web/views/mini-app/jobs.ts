import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { Job } from "../../../shared/types.ts";

// Topic ID -> human label mapping (from INSTANCE.md)
const TOPIC_LABELS: Record<number, string> = {
  49: "News",
  56: "Videos",
  103: "Trading",
};

function topicLabel(job: Job): string {
  if (!job.notify_chat_id) return "DM";
  if (job.notify_topic_id && TOPIC_LABELS[job.notify_topic_id]) {
    return TOPIC_LABELS[job.notify_topic_id];
  }
  if (job.notify_topic_id) return `Topic #${job.notify_topic_id}`;
  return "Group";
}

function modelLabel(job: Job): string {
  if (job.model) {
    if (job.model.includes("opus")) return "Opus";
    if (job.model.includes("sonnet")) return "Sonnet";
    if (job.model.includes("haiku")) return "Haiku";
    return job.model;
  }
  return "Default";
}

function backendLabel(job: Job): string {
  return job.backend === "glm" ? "GLM" : "Claude";
}

function scheduleLabel(job: Job): string {
  if (job.type !== "cron" || !job.schedule) return job.run_at ?? "one-off";
  return cronToHuman(job.schedule);
}

function cronToHuman(cron: string): string {
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, _dom, _mon, dow] = parts;

  const dowMap: Record<string, string> = {
    "0": "Sun", "1": "Mon-Fri", "1-5": "Mon-Fri", "6": "Sat", "*": "",
  };
  const dowLabel = dowMap[dow] ?? `d${dow}`;

  if (min.startsWith("*/") && hour === "*") {
    return `Every ${min.slice(2)}m${dowLabel ? ` ${dowLabel}` : ""}`;
  }
  if (hour.startsWith("*/")) {
    return `Every ${hour.slice(2)}h${dowLabel ? ` ${dowLabel}` : ""}`;
  }
  if (hour.includes(",")) {
    const hours = hour.split(",").map((h) => `${h}:${min.padStart(2, "0")}`);
    return `${hours.join(", ")}${dowLabel ? ` ${dowLabel}` : ""}`;
  }
  if (hour !== "*" && min !== "*") {
    return `${hour}:${min.padStart(2, "0")}${dowLabel ? ` ${dowLabel}` : ""}`;
  }
  return cron;
}

export function tmaJobsPage(jobs: Job[]): string {
  const enabled = jobs.filter((j) => j.status === "enabled");
  const disabled = jobs.filter((j) => j.status !== "enabled");

  const enabledList = enabled.length > 0
    ? enabled.map((j) => tmaJobCardFragment(j)).join("\n")
    : `<div class="tma-empty">No active jobs</div>`;

  const disabledList = disabled.length > 0
    ? `<details style="padding:0 16px 16px;">
        <summary class="tma-hint" style="cursor:pointer; padding:8px 0; font-size:13px;">${disabled.length} inactive job${disabled.length > 1 ? "s" : ""}</summary>
        ${disabled.map((j) => tmaJobCardFragment(j)).join("\n")}
      </details>`
    : "";

  return miniAppLayout("jobs", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
        <h2 style="font-size:18px; font-weight:600;">Jobs</h2>
        <span class="tma-hint">${enabled.length} active</span>
      </div>
      <div id="job-list">
        ${enabledList}
      </div>
      ${disabledList}
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

export function tmaJobCardFragment(job: Job): string {
  const paused = isPaused(job);
  const statusCls = paused ? "tma-badge-paused" : job.status === "enabled" ? "tma-badge-enabled" : "tma-badge-disabled";
  const statusLabel = paused ? "Paused" : job.status;
  const toggleLabel = job.status === "enabled" ? "Disable" : "Enable";

  const dest = topicLabel(job);
  const model = modelLabel(job);
  const backend = backendLabel(job);
  const sched = scheduleLabel(job);

  const pills = [
    `<span class="tma-pill">${escapeHtml(sched)}</span>`,
    `<span class="tma-pill">${escapeHtml(model)}</span>`,
    backend !== "Claude" ? `<span class="tma-pill">${escapeHtml(backend)}</span>` : "",
    `<span class="tma-pill">${escapeHtml(dest)}</span>`,
    job.use_browser ? `<span class="tma-pill">Browser</span>` : "",
  ].filter(Boolean).join(" ");

  return `<div class="tma-card" id="job-${job.id}">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px;">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:14px;">${escapeHtml(job.name)}</div>
        <div style="display:flex; gap:4px; margin-top:6px; flex-wrap:wrap; align-items:center;">
          ${pills}
        </div>
      </div>
      <span class="tma-badge ${statusCls}">${statusLabel}</span>
    </div>
    ${job.last_run_at ? `<div class="tma-hint" style="margin-top:6px; font-size:11px;">Last: ${escapeHtml(job.last_run_at)}${job.next_run_at ? ` | Next: ${escapeHtml(job.next_run_at)}` : ""}</div>` : ""}
    <div style="display:flex; gap:6px; margin-top:10px; flex-wrap:wrap;">
      <button class="tma-btn tma-btn-sm" hx-post="/tma/api/jobs/${job.id}/trigger" hx-target="#job-${job.id}" hx-swap="outerHTML">Run</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/jobs/${job.id}/toggle" hx-target="#job-${job.id}" hx-swap="outerHTML">${toggleLabel}</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/jobs/${job.id}/pause" hx-target="#job-${job.id}" hx-swap="outerHTML">${paused ? "Unpause" : "Pause 24h"}</button>
      <button class="tma-btn tma-btn-sm tma-btn-danger" hx-post="/tma/api/jobs/${job.id}/delete" hx-target="#job-list" hx-swap="innerHTML" hx-confirm="Delete this job?">Delete</button>
    </div>
  </div>`;
}

export function tmaJobListFragment(jobs: Job[]): string {
  if (jobs.length === 0) return `<div class="tma-empty">No jobs configured</div>`;
  return jobs.map((j) => tmaJobCardFragment(j)).join("\n");
}
