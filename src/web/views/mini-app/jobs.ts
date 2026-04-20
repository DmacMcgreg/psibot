import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { AgentNotifyPolicy, Job, JobRun } from "../../../shared/types.ts";

const NOTIFY_POLICY_OPTIONS: Array<{ value: "" | AgentNotifyPolicy; label: string }> = [
  { value: "", label: "(inherit from agent)" },
  { value: "always", label: "Always" },
  { value: "on_error", label: "On error" },
  { value: "on_change", label: "On change" },
  { value: "silent", label: "Silent" },
  { value: "dynamic", label: "Dynamic" },
];

function notifyPolicyLabel(policy: AgentNotifyPolicy | null): string {
  if (!policy) return "(inherit)";
  const opt = NOTIFY_POLICY_OPTIONS.find((o) => o.value === policy);
  return opt?.label ?? policy;
}

// Topic ID -> human label mapping (from INSTANCE.md)
const TOPIC_LABELS: Record<number, string> = {
  49: "News",
  56: "Videos",
  103: "Trading",
};
const TOPIC_OPTIONS = [
  { value: 0, label: "DM (no topic)" },
  { value: 49, label: "News" },
  { value: 56, label: "Videos" },
  { value: 103, label: "Trading" },
];

function topicLabel(job: Job): string {
  if (!job.notify_chat_id) return "DM";
  if (job.notify_topic_id && TOPIC_LABELS[job.notify_topic_id]) {
    return TOPIC_LABELS[job.notify_topic_id];
  }
  if (job.notify_topic_id) return `Topic #${job.notify_topic_id}`;
  return "Group";
}

function topicGroup(job: Job): string {
  if (!job.notify_chat_id) return "DM";
  if (job.notify_topic_id && TOPIC_LABELS[job.notify_topic_id]) {
    return TOPIC_LABELS[job.notify_topic_id];
  }
  return "Other";
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

function isPaused(job: Job): boolean {
  if (job.paused_until) {
    const until = new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z");
    if (until > new Date()) return true;
  }
  return job.skip_runs > 0;
}

function relativeTime(isoStr: string): string {
  const d = new Date(isoStr.endsWith("Z") ? isoStr : isoStr + "Z");
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// --- Page ---

export function tmaJobsPage(jobs: Job[]): string {
  const enabled = jobs.filter((j) => j.status === "enabled");
  const groups = groupByTopic(enabled);
  const inactive = jobs.filter((j) => j.status !== "enabled");

  const topicFilters = ["All", "Trading", "News", "DM", "Other"].map((f) =>
    `<button class="tma-filter-btn" data-filter-topic="${f}" onclick="filterByTopic('${f}')">${f}</button>`
  ).join("");

  const modelFilters = ["All", "Sonnet", "Haiku", "Opus", "Default"].map((f) =>
    `<button class="tma-filter-btn" data-filter-model="${f}" onclick="filterByModel('${f}')">${f}</button>`
  ).join("");

  const groupedHtml = groups.map(([group, items]) =>
    `<div class="tma-group" data-group="${escapeHtml(group)}">
      <div class="tma-group-header">${escapeHtml(group)} <span class="tma-hint">(${items.length})</span></div>
      ${items.map((j) => tmaJobCardFragment(j)).join("\n")}
    </div>`
  ).join("\n");

  const inactiveHtml = inactive.length > 0
    ? `<details style="padding:0 16px 16px;">
        <summary class="tma-hint" style="cursor:pointer; padding:8px 0; font-size:13px;">${inactive.length} inactive</summary>
        ${inactive.map((j) => tmaJobCardFragment(j)).join("\n")}
      </details>`
    : "";

  return miniAppLayout("jobs", `
    <div style="padding:8px 0;">
      <div style="padding:8px 16px;">
        <input type="search" class="tma-input" placeholder="Search jobs..." id="job-search"
          oninput="searchJobs(this.value)" style="font-size:13px; padding:8px 12px;">
      </div>
      <div style="padding:4px 16px 4px; display:flex; gap:6px; overflow-x:auto; -webkit-overflow-scrolling:touch;">
        <span class="tma-hint" style="font-size:11px; align-self:center; white-space:nowrap;">Topic:</span>
        ${topicFilters}
      </div>
      <div style="padding:2px 16px 8px; display:flex; gap:6px; overflow-x:auto; -webkit-overflow-scrolling:touch;">
        <span class="tma-hint" style="font-size:11px; align-self:center; white-space:nowrap;">Model:</span>
        ${modelFilters}
      </div>
      <div id="job-list">
        ${groupedHtml}
      </div>
      ${inactiveHtml}
    </div>
    <script>
    var activeTopic = 'All';
    var activeModel = 'All';
    var searchQuery = '';

    function applyFilters() {
      document.querySelectorAll('.tma-card[data-name]').forEach(function(card) {
        var name = card.getAttribute('data-name') || '';
        var model = card.getAttribute('data-model') || '';
        var matchSearch = !searchQuery || name.includes(searchQuery);
        var matchModel = activeModel === 'All' || model === activeModel;
        card.style.display = (matchSearch && matchModel) ? '' : 'none';
      });
      document.querySelectorAll('.tma-group').forEach(function(g) {
        var matchTopic = activeTopic === 'All' || g.getAttribute('data-group') === activeTopic;
        if (!matchTopic) { g.style.display = 'none'; return; }
        var visible = g.querySelectorAll('.tma-card[data-name]:not([style*="display: none"])').length;
        g.style.display = visible > 0 ? '' : 'none';
      });
    }
    function searchJobs(q) {
      searchQuery = q.toLowerCase();
      applyFilters();
    }
    function filterByTopic(f) {
      activeTopic = f;
      document.querySelectorAll('[data-filter-topic]').forEach(function(b) {
        b.classList.toggle('tma-filter-active', b.getAttribute('data-filter-topic') === f);
      });
      applyFilters();
    }
    function filterByModel(f) {
      activeModel = f;
      document.querySelectorAll('[data-filter-model]').forEach(function(b) {
        b.classList.toggle('tma-filter-active', b.getAttribute('data-filter-model') === f);
      });
      applyFilters();
    }
    // Activate "All" on load
    document.querySelector('[data-filter-topic="All"]')?.classList.add('tma-filter-active');
    document.querySelector('[data-filter-model="All"]')?.classList.add('tma-filter-active');
    </script>
  `);
}

function groupByTopic(jobs: Job[]): [string, Job[]][] {
  const map = new Map<string, Job[]>();
  const order = ["Trading", "News", "DM", "Other"];
  for (const o of order) map.set(o, []);
  for (const job of jobs) {
    const g = topicGroup(job);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(job);
  }
  // Remove empty groups
  return [...map.entries()].filter(([, items]) => items.length > 0);
}

// --- Card (compact, expandable) ---

export function tmaJobCardFragment(job: Job): string {
  const paused = isPaused(job);
  const statusCls = paused ? "tma-badge-paused" : job.status === "enabled" ? "tma-badge-enabled" : "tma-badge-disabled";
  const statusLabel = paused ? "Paused" : job.status;

  const model = modelLabel(job);
  const backend = backendLabel(job);
  const sched = scheduleLabel(job);
  const dest = topicLabel(job);

  const pills = [
    `<span class="tma-pill">${escapeHtml(sched)}</span>`,
    `<span class="tma-pill">${escapeHtml(model)}</span>`,
    backend !== "Claude" ? `<span class="tma-pill">${escapeHtml(backend)}</span>` : "",
    job.use_browser ? `<span class="tma-pill">Browser</span>` : "",
    job.agent_name ? `<span class="tma-pill">${escapeHtml(job.agent_name)}</span>` : "",
    job.next_job_id ? `<span class="tma-pill">Pipeline</span>` : "",
  ].filter(Boolean).join(" ");

  const lastRun = job.last_run_at ? relativeTime(job.last_run_at) : "never";

  return `<div class="tma-card" id="job-${job.id}" data-name="${escapeHtml(job.name.toLowerCase())}" data-dest="${escapeHtml(dest)}" data-model="${escapeHtml(model)}">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px; cursor:pointer;"
         hx-get="/tma/api/jobs/${job.id}/detail" hx-target="#job-${job.id}" hx-swap="outerHTML">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:14px;">${escapeHtml(job.name)}</div>
        <div style="display:flex; gap:4px; margin-top:5px; flex-wrap:wrap; align-items:center;">
          ${pills}
        </div>
        <div class="tma-hint" style="margin-top:4px; font-size:11px;">Last: ${lastRun}</div>
      </div>
      <span class="tma-badge ${statusCls}" style="flex-shrink:0;">${statusLabel}</span>
    </div>
  </div>`;
}

// --- Detail (expanded view with actions + run history) ---

export function tmaJobDetailFragment(job: Job, runs: JobRun[], allJobs?: Job[]): string {
  const paused = isPaused(job);
  const statusCls = paused ? "tma-badge-paused" : job.status === "enabled" ? "tma-badge-enabled" : "tma-badge-disabled";
  const statusLabel = paused ? "Paused" : job.status;
  const toggleLabel = job.status === "enabled" ? "Disable" : "Enable";

  const model = modelLabel(job);
  const backend = backendLabel(job);
  const sched = scheduleLabel(job);
  const dest = topicLabel(job);
  const lastRun = job.last_run_at ? relativeTime(job.last_run_at) : "never";

  const promptPreview = job.prompt.length > 200
    ? escapeHtml(job.prompt.slice(0, 200)) + "..."
    : escapeHtml(job.prompt);

  const runRows = runs.length > 0
    ? runs.map((r) => {
        const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "-";
        const cost = r.cost_usd ? `$${r.cost_usd.toFixed(3)}` : "-";
        const statusIcon = r.status === "success" ? "ok" : r.status === "running" ? "..." : "err";
        const time = relativeTime(r.started_at);
        return `<div class="tma-run-row">
          <span class="tma-run-status tma-run-${r.status}">${statusIcon}</span>
          <span>${time}</span>
          <span>${dur}</span>
          <span>${cost}</span>
        </div>`;
      }).join("")
    : `<div class="tma-hint" style="padding:4px 0; font-size:12px;">No runs yet</div>`;

  return `<div class="tma-card tma-card-expanded" id="job-${job.id}" data-name="${escapeHtml(job.name.toLowerCase())}" data-dest="${escapeHtml(dest)}">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px;">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:15px;">${escapeHtml(job.name)}</div>
        <span class="tma-badge ${statusCls}" style="margin-top:4px;">${statusLabel}</span>
      </div>
      <button class="tma-btn tma-btn-sm tma-btn-secondary"
              hx-get="/tma/api/jobs/${job.id}/card" hx-target="#job-${job.id}" hx-swap="outerHTML"
              style="font-size:18px; padding:2px 8px; line-height:1;">x</button>
    </div>

    <table class="tma-detail-table" style="margin-top:10px;">
      <tr><td class="tma-dt-label">Schedule</td><td>${escapeHtml(sched)}${job.schedule ? ` <span class="tma-hint">(${escapeHtml(job.schedule)})</span>` : ""}</td></tr>
      <tr><td class="tma-dt-label">Model</td><td>${escapeHtml(model)}</td></tr>
      <tr><td class="tma-dt-label">Backend</td><td>${escapeHtml(backend)}</td></tr>
      <tr><td class="tma-dt-label">Posts to</td><td>${escapeHtml(dest)}</td></tr>
      <tr><td class="tma-dt-label">Budget</td><td>$${job.max_budget_usd.toFixed(2)}</td></tr>
      <tr><td class="tma-dt-label">Browser</td><td>${job.use_browser ? "Yes" : "No"}</td></tr>
      <tr><td class="tma-dt-label">Agent</td><td>${job.agent_name ? escapeHtml(job.agent_name) : "Default"}</td></tr>
      <tr><td class="tma-dt-label">Subagents</td><td>${job.subagents ? escapeHtml(JSON.parse(job.subagents).join(", ")) : "All"}</td></tr>
      <tr><td class="tma-dt-label">Notify</td><td>${escapeHtml(notifyPolicyLabel(job.notify_policy))}</td></tr>
      <tr><td class="tma-dt-label">Template</td><td>${job.output_template ? "<em>custom</em>" : "none"}</td></tr>
      <tr><td class="tma-dt-label">Pipeline</td><td>${job.next_job_id && allJobs ? escapeHtml("-> " + (allJobs.find((j) => j.id === job.next_job_id)?.name ?? `Job #${job.next_job_id}`)) : "None"}</td></tr>
      <tr><td class="tma-dt-label">Last run</td><td>${lastRun}</td></tr>
      ${job.next_run_at ? `<tr><td class="tma-dt-label">Next run</td><td>${escapeHtml(job.next_run_at)}</td></tr>` : ""}
    </table>

    ${job.agent_prompt ? `<details style="margin-top:10px;">
      <summary class="tma-hint" style="cursor:pointer; font-size:12px;">Agent Prompt</summary>
      <div style="margin-top:6px; font-size:12px; white-space:pre-wrap; line-height:1.4; max-height:200px; overflow-y:auto;">${job.agent_prompt.length > 200 ? escapeHtml(job.agent_prompt.slice(0, 200)) + "..." : escapeHtml(job.agent_prompt)}</div>
    </details>
    <details style="margin-top:10px;">
      <summary class="tma-hint" style="cursor:pointer; font-size:12px;">Job Prompt</summary>
      <div style="margin-top:6px; font-size:12px; white-space:pre-wrap; line-height:1.4; max-height:200px; overflow-y:auto;">${promptPreview}</div>
    </details>` : `<details style="margin-top:10px;">
      <summary class="tma-hint" style="cursor:pointer; font-size:12px;">Prompt</summary>
      <div style="margin-top:6px; font-size:12px; white-space:pre-wrap; line-height:1.4; max-height:200px; overflow-y:auto;">${promptPreview}</div>
    </details>`}

    <div style="margin-top:10px;">
      <div style="font-size:12px; font-weight:600; margin-bottom:4px;">Recent Runs</div>
      <div class="tma-run-header">
        <span></span><span>When</span><span>Time</span><span>Cost</span>
      </div>
      ${runRows}
    </div>

    <div style="display:flex; gap:6px; margin-top:12px; flex-wrap:wrap;">
      <button class="tma-btn tma-btn-sm" hx-post="/tma/api/jobs/${job.id}/trigger" hx-target="#job-${job.id}" hx-swap="outerHTML">Run Now</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-get="/tma/api/jobs/${job.id}/edit" hx-target="#job-${job.id}" hx-swap="outerHTML">Edit</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/jobs/${job.id}/toggle" hx-target="#job-${job.id}" hx-swap="outerHTML">${toggleLabel}</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/jobs/${job.id}/pause" hx-target="#job-${job.id}" hx-swap="outerHTML">${paused ? "Unpause" : "Pause 24h"}</button>
      <button class="tma-btn tma-btn-sm tma-btn-danger" hx-post="/tma/api/jobs/${job.id}/delete" hx-target="#job-list" hx-swap="innerHTML" hx-confirm="Delete this job?">Delete</button>
    </div>
  </div>`;
}

// --- Edit form ---

export function tmaJobEditFragment(job: Job, agentNames: string[], allJobs: Job[]): string {
  const topicId = job.notify_topic_id ?? 0;

  const modelOptions = [
    { value: "", label: "Default" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
    { value: "opus", label: "Opus" },
  ];

  const backendOptions = [
    { value: "claude", label: "Claude" },
    { value: "glm", label: "GLM" },
  ];

  return `<div class="tma-card tma-card-expanded" id="job-${job.id}">
    <form hx-post="/tma/api/jobs/${job.id}/update" hx-target="#job-${job.id}" hx-swap="outerHTML">
      <div style="font-weight:600; font-size:15px; margin-bottom:12px;">Edit: ${escapeHtml(job.name)}</div>

      <div class="tma-form-row">
        <label class="tma-form-label">Name</label>
        <input name="name" value="${escapeHtml(job.name)}" class="tma-input tma-input-sm" required>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Schedule (cron)</label>
        <input name="schedule" value="${escapeHtml(job.schedule ?? "")}" class="tma-input tma-input-sm" placeholder="*/30 * * * *">
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <div class="tma-form-row">
          <label class="tma-form-label">Model</label>
          <select name="model" class="tma-input tma-input-sm">
            ${modelOptions.map((o) => `<option value="${o.value}" ${(job.model ?? "") === o.value || (job.model?.includes(o.value) && o.value) ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
        </div>
        <div class="tma-form-row">
          <label class="tma-form-label">Backend</label>
          <select name="backend" class="tma-input tma-input-sm">
            ${backendOptions.map((o) => `<option value="${o.value}" ${(job.backend ?? "claude") === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <div class="tma-form-row">
          <label class="tma-form-label">Posts to</label>
          <select name="notify_topic_id" class="tma-input tma-input-sm">
            ${TOPIC_OPTIONS.map((o) => `<option value="${o.value}" ${topicId === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
          </select>
        </div>
        <div class="tma-form-row">
          <label class="tma-form-label">Budget ($)</label>
          <input name="max_budget_usd" type="number" step="0.01" value="${job.max_budget_usd}" class="tma-input tma-input-sm">
        </div>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">
          <input type="checkbox" name="use_browser" ${job.use_browser ? "checked" : ""} style="margin-right:6px;">
          Enable browser
        </label>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Agent</label>
        <select name="agent_name" class="tma-input tma-input-sm">
          <option value=""${!job.agent_name ? " selected" : ""}>Default (none)</option>
          ${agentNames.map((name) => `<option value="${escapeHtml(name)}"${job.agent_name === name ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}
        </select>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Agent Prompt Override (optional)</label>
        <textarea name="agent_prompt" rows="3" class="tma-input tma-input-sm" style="font-size:12px; line-height:1.4; resize:vertical;">${escapeHtml(job.agent_prompt ?? "")}</textarea>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Notify policy (override)</label>
        <select name="notify_policy" class="tma-input tma-input-sm">
          ${NOTIFY_POLICY_OPTIONS.map((o) => `<option value="${o.value}"${(job.notify_policy ?? "") === o.value ? " selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Output template (override, optional)</label>
        <textarea name="output_template" rows="3" class="tma-input tma-input-sm" placeholder="{{headline}} &#8212; {{summary}}" style="font-size:12px; line-height:1.4; resize:vertical; font-family:monospace;">${escapeHtml(job.output_template ?? "")}</textarea>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Subagents</label>
        <div style="display:flex; flex-wrap:wrap; gap:6px 12px; margin-top:4px;">
          ${(() => {
            const selected: string[] = job.subagents ? JSON.parse(job.subagents) : [];
            return agentNames.map((name) =>
              `<label style="display:flex; align-items:center; gap:4px; font-size:12px;">
  <input type="checkbox" name="subagents" value="${escapeHtml(name)}"${selected.includes(name) ? " checked" : ""}>
  ${escapeHtml(name)}
</label>`
            ).join("\n          ");
          })()}
        </div>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Prompt</label>
        <textarea name="prompt" rows="6" class="tma-input tma-input-sm" style="font-size:12px; line-height:1.4; resize:vertical;">${escapeHtml(job.prompt)}</textarea>
      </div>

      <div class="tma-form-row">
        <label class="tma-form-label">Pipeline (next job)</label>
        <select name="next_job_id" class="tma-input tma-input-sm">
          <option value=""${!job.next_job_id ? " selected" : ""}>None</option>
          ${allJobs.filter((j) => j.id !== job.id).map((j) => `<option value="${j.id}"${job.next_job_id === j.id ? " selected" : ""}>${escapeHtml(j.name)}</option>`).join("")}
        </select>
      </div>

      <div style="display:flex; gap:6px; margin-top:12px;">
        <button type="submit" class="tma-btn tma-btn-sm">Save</button>
        <button type="button" class="tma-btn tma-btn-sm tma-btn-secondary"
                hx-get="/tma/api/jobs/${job.id}/detail" hx-target="#job-${job.id}" hx-swap="outerHTML">Cancel</button>
      </div>
    </form>
  </div>`;
}

export function tmaJobListFragment(jobs: Job[]): string {
  if (jobs.length === 0) return `<div class="tma-empty">No jobs configured</div>`;
  const enabled = jobs.filter((j) => j.status === "enabled");
  const groups = groupByTopic(enabled);
  return groups.map(([group, items]) =>
    `<div class="tma-group" data-group="${escapeHtml(group)}">
      <div class="tma-group-header">${escapeHtml(group)} <span class="tma-hint">(${items.length})</span></div>
      ${items.map((j) => tmaJobCardFragment(j)).join("\n")}
    </div>`
  ).join("\n");
}
