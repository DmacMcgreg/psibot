import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  formatAgo,
  formatCost,
  pageHeader,
  statusBadge,
  filterChips,
  searchBar,
  emptyState,
  errorState,
  skeletonList,
  listRow,
  section,
  formField,
  formActions,
  detailsPanel,
  button,
  type ChipOption,
} from "./components.ts";
import type { AgentNotifyPolicy, Job, JobRun } from "../../../shared/types.ts";

// ---------------------------------------------------------------------------
// Static option tables
// ---------------------------------------------------------------------------

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
  5: "GLM",
  49: "News",
  56: "Videos",
  103: "Trading",
};
const TOPIC_OPTIONS = [
  { value: 0, label: "DM (no topic)" },
  { value: 5, label: "GLM" },
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
    "0": "Sun",
    "1": "Mon-Fri",
    "1-5": "Mon-Fri",
    "6": "Sat",
    "*": "",
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

function jobStatusForBadge(job: Job): string {
  if (isPaused(job)) return "paused";
  return job.status === "enabled" ? "enabled" : "disabled";
}

// ---------------------------------------------------------------------------
// Filter state (URL query params so reload preserves it)
// ---------------------------------------------------------------------------

export interface JobFilters {
  q: string;
  topic: string; // "all" | "Trading" | "News" | "DM" | "Other"
  type: string; // "all" | "cron" | "once"
  status: string; // "all" | "enabled" | "disabled" | "paused"
}

export const DEFAULT_JOB_FILTERS: JobFilters = {
  q: "",
  topic: "all",
  type: "all",
  status: "all",
};

function topicGroup(job: Job): string {
  if (!job.notify_chat_id) return "DM";
  if (job.notify_topic_id && TOPIC_LABELS[job.notify_topic_id]) {
    return TOPIC_LABELS[job.notify_topic_id];
  }
  return "Other";
}

function matchesFilters(job: Job, filters: JobFilters): boolean {
  if (filters.q) {
    const q = filters.q.toLowerCase();
    if (!job.name.toLowerCase().includes(q)) return false;
  }
  if (filters.topic !== "all" && topicGroup(job) !== filters.topic) return false;
  if (filters.type !== "all" && job.type !== filters.type) return false;
  if (filters.status !== "all") {
    const s = jobStatusForBadge(job);
    if (s !== filters.status) return false;
  }
  return true;
}

function buildQuery(filters: JobFilters, overrides: Partial<JobFilters>): string {
  const merged = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (merged.q) params.set("q", merged.q);
  if (merged.topic !== "all") params.set("topic", merged.topic);
  if (merged.type !== "all") params.set("type", merged.type);
  if (merged.status !== "all") params.set("status", merged.status);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function chipOptions(
  base: string,
  filters: JobFilters,
  key: keyof JobFilters,
  values: Array<{ value: string; label: string }>,
): ChipOption[] {
  return values.map((v) => ({
    value: v.value,
    label: v.label,
    href: `${base}${buildQuery(filters, { [key]: v.value } as Partial<JobFilters>)}`,
  }));
}

// ---------------------------------------------------------------------------
// Page (list)
// ---------------------------------------------------------------------------

export function tmaJobsPage(jobs: Job[], filters: JobFilters = DEFAULT_JOB_FILTERS): string {
  return miniAppLayout(
    "jobs",
    `${pageHeader("Jobs")}
    <div class="tma-search-scope" data-tma-filter-scope>
      ${tmaJobsToolbar(filters)}
      <div id="job-list">
        ${tmaJobListInner(jobs, filters)}
      </div>
    </div>`,
  );
}

function tmaJobsToolbar(filters: JobFilters): string {
  // Chips navigate to the full page (fragment URLs render unstyled if the
  // browser follows them directly); search swaps the fragment via HTMX.
  const base = "/tma/jobs";
  const frag = "/tma/jobs/list";
  const typeChips = chipOptions(base, filters, "type", [
    { value: "all", label: "All" },
    { value: "cron", label: "Recurring" },
    { value: "once", label: "One-off" },
  ]);
  const topicChips = chipOptions(base, filters, "topic", [
    { value: "all", label: "All" },
    { value: "Trading", label: "Trading" },
    { value: "News", label: "News" },
    { value: "DM", label: "DM" },
    { value: "Other", label: "Other" },
  ]);
  const statusChips = chipOptions(base, filters, "status", [
    { value: "all", label: "All" },
    { value: "enabled", label: "Enabled" },
    { value: "paused", label: "Paused" },
    { value: "disabled", label: "Disabled" },
  ]);

  // Bake non-q filters into the search action so searching preserves them;
  // the fragment replaces the whole .tma-search-scope (toolbar + list).
  const searchAction = `${frag}${buildQuery(filters, { q: "" })}`;
  // Status is the most-used filter, so it stays visible; type + topic fold
  // into a "Filters ▾" disclosure to avoid stacking 3 chip rows (~200px).
  // Chips inside stay full-page <a href> links (not fragment URLs) — see the
  // fragment-URL styling bug fixed in the previous polish pass.
  const moreOpen = filters.type !== "all" || filters.topic !== "all";
  return `<form hx-get="${searchAction}" hx-target="closest .tma-search-scope" hx-swap="innerHTML" hx-trigger="submit">
    ${searchBar(searchAction, "Search jobs…", filters.q)}
  </form>
  ${filterChips("status", statusChips, filters.status)}
  <details class="tma-filter-more"${moreOpen ? " open" : ""}>
    <summary>Filters</summary>
    <div class="tma-filter-more-body">
      ${filterChips("type", typeChips, filters.type)}
      ${filterChips("topic", topicChips, filters.topic)}
    </div>
  </details>`;
}

function tmaJobListInner(jobs: Job[], filters: JobFilters): string {
  const filtered = jobs.filter((j) => matchesFilters(j, filters));
  if (jobs.length === 0) {
    return emptyState("\u{1F4C5}", "No jobs configured", "Scheduled jobs will show up here.");
  }
  if (filtered.length === 0) {
    return emptyState("\u{1F50D}", "No matching jobs", "Try clearing filters or search.");
  }

  const groups = groupByTopic(filtered);
  return groups
    .map(
      ([group, items]) => `<div class="tma-group" data-group="${escapeAttr(group)}">
      <div class="tma-group-header">${escapeHtml(group)} <span class="tma-hint">(${items.length})</span></div>
      ${items.map((j) => tmaJobRow(j)).join("\n")}
    </div>`,
    )
    .join("\n");
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
  return [...map.entries()].filter(([, items]) => items.length > 0);
}

/** Loading skeleton for the job list (used by the route while data loads client-side, if ever needed). */
export function tmaJobListSkeleton(): string {
  return skeletonList(4);
}

/** Error state for the job list. */
export function tmaJobListError(message: string): string {
  return errorState(message, "/tma/jobs/list");
}

// ---------------------------------------------------------------------------
// Row (list item -> navigates to detail page)
// ---------------------------------------------------------------------------

export function tmaJobRow(job: Job): string {
  const sched = scheduleLabel(job);
  const lastRun = job.last_run_at ? formatAgo(job.last_run_at) : "never";
  // "Next" is only meaningful for jobs that will actually run; on disabled/
  // paused jobs it renders stale nonsense ("Next: 2mo ago").
  const willRun = job.status === "enabled" && !isPaused(job);
  const nextRun = willRun && job.next_run_at ? formatAgo(job.next_run_at) : null;
  const meta = `${sched} · ran ${lastRun}${nextRun ? ` · next ${nextRun}` : ""}`;

  // No `meta: dest` — the list is already grouped by topic, so repeating the
  // topic name in every row is noise.
  return listRow({
    title: job.name,
    subtitle: meta,
    badge: statusBadge(jobStatusForBadge(job)),
    hxGet: `/tma/jobs/${job.id}`,
    chevron: true,
  });
}

/**
 * Search-scope fragment (toolbar + list). Swapped into `.tma-search-scope`
 * by the search input, so it must rebuild the toolbar alongside the list —
 * otherwise the swap destroys the search box and chips (see memory.ts note).
 */
export function tmaJobListFragment(jobs: Job[], filters: JobFilters = DEFAULT_JOB_FILTERS): string {
  return `${tmaJobsToolbar(filters)}
  <div id="job-list">
    ${tmaJobListInner(jobs, filters)}
  </div>`;
}

// ---------------------------------------------------------------------------
// Detail page (own route, BackButton pattern — not inline expansion)
// ---------------------------------------------------------------------------

export function tmaJobDetailPage(job: Job, runs: JobRun[], allJobs: Job[]): string {
  return miniAppLayout(
    "jobs",
    `${pageHeader(job.name, { subtitle: `Job #${job.id}` })}
    <div id="job-detail-root">
      ${tmaJobDetailFragment(job, runs, allJobs)}
    </div>`,
    false,
  );
}

/** Loading skeleton for the detail page. */
export function tmaJobDetailSkeleton(): string {
  return skeletonList(3);
}

/** Error state for the detail page. */
export function tmaJobDetailError(message: string, jobId: number): string {
  return errorState(message, `/tma/jobs/${jobId}`);
}

export function tmaJobDetailFragment(job: Job, runs: JobRun[], allJobs?: Job[]): string {
  const paused = isPaused(job);
  const toggleLabel = job.status === "enabled" ? "Disable" : "Enable";

  const model = modelLabel(job);
  const backend = backendLabel(job);
  const sched = scheduleLabel(job);
  const dest = topicLabel(job);
  const lastRun = job.last_run_at ? formatAgo(job.last_run_at) : "never";

  const promptPreview = job.prompt.length > 400 ? escapeHtml(job.prompt.slice(0, 400)) + "…" : escapeHtml(job.prompt);

  const pipelineNext =
    job.next_job_id && allJobs
      ? (allJobs.find((j) => j.id === job.next_job_id)?.name ?? `Job #${job.next_job_id}`)
      : null;

  const scheduleRows = `<tr><td class="tma-dt-label">Schedule</td><td>${escapeHtml(sched)}${job.schedule ? ` <span class="tma-hint">(${escapeHtml(job.schedule)})</span>` : ""}</td></tr>
    <tr><td class="tma-dt-label">Model</td><td>${escapeHtml(model)}</td></tr>
    <tr><td class="tma-dt-label">Backend</td><td>${escapeHtml(backend)}</td></tr>
    <tr><td class="tma-dt-label">Posts to</td><td>${escapeHtml(dest)}</td></tr>
    <tr><td class="tma-dt-label">Budget</td><td>${formatCost(job.max_budget_usd)}</td></tr>
    <tr><td class="tma-dt-label">Browser</td><td>${job.use_browser ? "Yes" : "No"}</td></tr>
    <tr><td class="tma-dt-label">Last run</td><td>${escapeHtml(lastRun)}</td></tr>
    ${job.next_run_at ? `<tr><td class="tma-dt-label">Next run</td><td>${escapeHtml(job.next_run_at)}</td></tr>` : ""}`;

  const configRows = `<tr><td class="tma-dt-label">Agent</td><td>${job.agent_name ? escapeHtml(job.agent_name) : "Default"}</td></tr>
    <tr><td class="tma-dt-label">Subagents</td><td>${job.subagents ? escapeHtml(JSON.parse(job.subagents).join(", ")) : "All"}</td></tr>
    <tr><td class="tma-dt-label">Notify</td><td>${escapeHtml(notifyPolicyLabel(job.notify_policy))}</td></tr>
    <tr><td class="tma-dt-label">Template</td><td>${job.output_template ? "custom" : "none"}</td></tr>
    <tr><td class="tma-dt-label">Pipeline</td><td>${pipelineNext ? escapeHtml(`→ ${pipelineNext}`) : "None"}</td></tr>`;

  const runRows =
    runs.length > 0
      ? runs
          .map((r) => {
            const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—";
            const cost = formatCost(r.cost_usd);
            const statusIcon = r.status === "success" ? "✓" : r.status === "running" ? "…" : "✗";
            const time = formatAgo(r.started_at);
            return `<div class="tma-run-row">
          <span class="tma-run-status tma-run-${escapeAttr(r.status)}">${statusIcon}</span>
          <span>${escapeHtml(time)}</span>
          <span>${escapeHtml(dur)}</span>
          <span>${escapeHtml(cost)}</span>
        </div>`;
          })
          .join("")
      : `<div class="tma-hint" style="padding:var(--sp-2) 0; font-size:var(--fs-sm);">No runs yet</div>`;

  const promptSection = job.agent_prompt
    ? `${detailsPanel(
        "Agent Prompt",
        `<div class="tma-mono tma-mono-scroll">${
          job.agent_prompt.length > 400 ? escapeHtml(job.agent_prompt.slice(0, 400)) + "…" : escapeHtml(job.agent_prompt)
        }</div>`,
      )}
      ${detailsPanel(
        "Job Prompt",
        `<div class="tma-mono tma-mono-scroll">${promptPreview}</div>`,
      )}`
    : detailsPanel(
        "Prompt",
        `<div class="tma-mono tma-mono-scroll">${promptPreview}</div>`,
      );

  const actions = formActions(
    button("Run Now", {
      small: true,
      attrs: `hx-post="/tma/api/jobs/${job.id}/trigger" hx-target="#job-detail-root" hx-swap="innerHTML" hx-disabled-elt="this" hx-on::after-request="showToast('Job triggered')"`,
    }),
    button("Edit", {
      small: true,
      kind: "secondary",
      attrs: `hx-get="/tma/api/jobs/${job.id}/edit" hx-target="#job-detail-root" hx-swap="innerHTML" hx-disabled-elt="this"`,
    }),
    button(toggleLabel, {
      small: true,
      kind: "secondary",
      attrs: `hx-post="/tma/api/jobs/${job.id}/toggle" hx-target="#job-detail-root" hx-swap="innerHTML" hx-disabled-elt="this" hx-on::after-request="showToast('${toggleLabel === "Disable" ? "Disabled" : "Enabled"}')"`,
    }),
    button(paused ? "Unpause" : "Pause 24h", {
      small: true,
      kind: "secondary",
      attrs: `hx-post="/tma/api/jobs/${job.id}/pause" hx-target="#job-detail-root" hx-swap="innerHTML" hx-disabled-elt="this" hx-on::after-request="showToast('${paused ? "Unpaused" : "Paused 24h"}')"`,
    }),
    button("Delete", {
      small: true,
      kind: "danger",
      attrs: `hx-post="/tma/api/jobs/${job.id}/delete" hx-target="#job-detail-root" hx-swap="innerHTML" hx-confirm="Delete this job?" hx-disabled-elt="this"`,
    }),
  );

  return `<div id="job-${job.id}">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:var(--sp-2); padding:0 var(--sp-4);">
      <span class="tma-hint">${escapeHtml(job.type === "cron" ? "Recurring" : "One-off")}</span>
      ${statusBadge(jobStatusForBadge(job))}
    </div>
    ${section("Schedule", `<table class="tma-detail-table tma-px-4">${scheduleRows}</table>`)}
    ${section("Config", `<table class="tma-detail-table tma-px-4">${configRows}</table>`)}
    ${promptSection}
    ${section(
      "Recent Runs",
      `<div class="tma-run-header tma-px-4"><span></span><span>When</span><span>Time</span><span>Cost</span></div>
       <div class="tma-px-4">${runRows}</div>`,
    )}
    ${actions}
  </div>`;
}

/** Fragment used by the card-swap job-mutation endpoints (returns the row for list contexts). */
export function tmaJobCardFragment(job: Job): string {
  return `<div id="job-${job.id}">${tmaJobRow(job)}</div>`;
}

// ---------------------------------------------------------------------------
// Edit form
// ---------------------------------------------------------------------------

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

  const subagentSelected: string[] = job.subagents ? JSON.parse(job.subagents) : [];

  const subagentCheckboxes =
    agentNames.length > 0
      ? agentNames
          .map(
            (name) =>
              `<label style="display:flex; align-items:center; gap:var(--sp-1); font-size:var(--fs-sm); min-height:var(--touch);">
  <input type="checkbox" name="subagents" value="${escapeAttr(name)}"${subagentSelected.includes(name) ? " checked" : ""}>
  ${escapeHtml(name)}
</label>`,
          )
          .join("\n")
      : `<span class="tma-hint">No subagents configured</span>`;

  return `<form id="job-${job.id}" hx-post="/tma/api/jobs/${job.id}/update" hx-target="#job-detail-root" hx-swap="innerHTML">
    <div class="tma-px-4">
      ${formField("Name", `<input name="name" value="${escapeAttr(job.name)}" class="tma-input" required>`)}
      ${formField("Schedule (cron)", `<input name="schedule" value="${escapeAttr(job.schedule ?? "")}" class="tma-input" placeholder="*/30 * * * *">`)}
      ${formField(
        "Model",
        `<select name="model" class="tma-input">
          ${modelOptions.map((o) => `<option value="${o.value}" ${(job.model ?? "") === o.value || (job.model?.includes(o.value) && o.value) ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>`,
      )}
      ${formField(
        "Backend",
        `<select name="backend" class="tma-input">
          ${backendOptions.map((o) => `<option value="${o.value}" ${(job.backend ?? "claude") === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>`,
      )}
      ${formField(
        "Posts to",
        `<select name="notify_topic_id" class="tma-input">
          ${TOPIC_OPTIONS.map((o) => `<option value="${o.value}" ${topicId === o.value ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>`,
      )}
      ${formField("Budget ($)", `<input name="max_budget_usd" type="number" step="0.01" value="${job.max_budget_usd}" class="tma-input">`)}
      ${formField(
        "Browser",
        `<label style="display:flex; align-items:center; gap:var(--sp-2); min-height:var(--touch);">
          <input type="checkbox" name="use_browser" ${job.use_browser ? "checked" : ""}>
          Enable browser
        </label>`,
      )}
      ${formField(
        "Agent",
        `<select name="agent_name" class="tma-input">
          <option value=""${!job.agent_name ? " selected" : ""}>Default (none)</option>
          ${agentNames.map((name) => `<option value="${escapeAttr(name)}"${job.agent_name === name ? " selected" : ""}>${escapeHtml(name)}</option>`).join("")}
        </select>`,
      )}
      ${formField(
        "Agent Prompt Override (optional)",
        `<textarea name="agent_prompt" rows="3" class="tma-input tma-mono">${escapeHtml(job.agent_prompt ?? "")}</textarea>`,
      )}
      ${formField(
        "Notify policy (override)",
        `<select name="notify_policy" class="tma-input">
          ${NOTIFY_POLICY_OPTIONS.map((o) => `<option value="${o.value}"${(job.notify_policy ?? "") === o.value ? " selected" : ""}>${o.label}</option>`).join("")}
        </select>`,
      )}
      ${formField(
        "Output template (override, optional)",
        `<textarea name="output_template" rows="3" class="tma-input tma-mono" placeholder="{{headline}} — {{summary}}">${escapeHtml(job.output_template ?? "")}</textarea>`,
      )}
      ${formField("Subagents", `<div style="display:flex; flex-direction:column; gap:var(--sp-1); margin-top:var(--sp-1);">${subagentCheckboxes}</div>`)}
      ${formField("Prompt", `<textarea name="prompt" rows="6" class="tma-input tma-mono">${escapeHtml(job.prompt)}</textarea>`)}
      ${formField(
        "Pipeline (next job)",
        `<select name="next_job_id" class="tma-input">
          <option value=""${!job.next_job_id ? " selected" : ""}>None</option>
          ${allJobs
            .filter((j) => j.id !== job.id)
            .map((j) => `<option value="${j.id}"${job.next_job_id === j.id ? " selected" : ""}>${escapeHtml(j.name)}</option>`)
            .join("")}
        </select>`,
      )}
    </div>
    ${formActions(
      `<button type="submit" class="tma-btn tma-btn-sm tma-btn-primary">Save</button>`,
      button("Cancel", {
        small: true,
        kind: "secondary",
        attrs: `hx-get="/tma/api/jobs/${job.id}/detail" hx-target="#job-detail-root" hx-swap="innerHTML"`,
      }),
    )}
  </form>`;
}
