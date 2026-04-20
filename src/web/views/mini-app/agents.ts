import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { Agent, AgentBackend, AgentNotifyPolicy, Job } from "../../../shared/types.ts";

const TOPIC_OPTIONS = [
  { value: 0, label: "DM (no topic)" },
  { value: 49, label: "News" },
  { value: 56, label: "Videos" },
  { value: 103, label: "Trading" },
];

const NOTIFY_POLICIES: AgentNotifyPolicy[] = [
  "always",
  "on_error",
  "on_change",
  "silent",
  "dynamic",
];

const MODEL_OPTIONS = ["opus", "sonnet", "haiku"];

const BACKEND_OPTIONS: Array<{ value: AgentBackend | ""; label: string }> = [
  { value: "", label: "(default)" },
  { value: "claude", label: "Claude" },
  { value: "glm", label: "GLM (api.z.ai)" },
];

function backendLabel(backend: AgentBackend | null): string {
  if (!backend) return "default";
  if (backend === "claude") return "Claude";
  if (backend === "glm") return "GLM";
  return backend;
}

function policyLabel(policy: AgentNotifyPolicy): string {
  switch (policy) {
    case "always":
      return "Always";
    case "on_error":
      return "On error";
    case "on_change":
      return "On change";
    case "silent":
      return "Silent";
    case "dynamic":
      return "Dynamic";
  }
}

function policyColor(policy: AgentNotifyPolicy): string {
  switch (policy) {
    case "always":
      return "#3b82f6";
    case "on_error":
      return "#ef4444";
    case "on_change":
      return "#f59e0b";
    case "silent":
      return "#6b7280";
    case "dynamic":
      return "#10b981";
  }
}

// --- Page ---

export function tmaAgentsPage(agents: Agent[], jobCounts: Map<string, number>): string {
  const builtins = agents.filter((a) => a.is_builtin);
  const custom = agents.filter((a) => !a.is_builtin);

  const builtinHtml = builtins.map((a) => tmaAgentCardFragment(a, jobCounts.get(a.slug) ?? 0)).join("\n");
  const customHtml = custom.length > 0
    ? `<div class="tma-group" data-group="Custom">
        <div class="tma-group-header">Custom <span class="tma-hint">(${custom.length})</span></div>
        ${custom.map((a) => tmaAgentCardFragment(a, jobCounts.get(a.slug) ?? 0)).join("\n")}
      </div>`
    : "";

  return miniAppLayout("agents", `
    <div style="padding:8px 0;">
      <div style="padding:8px 16px; display:flex; gap:8px; align-items:center;">
        <input type="search" class="tma-input" placeholder="Search agents..." id="agent-search"
          oninput="searchAgents(this.value)" style="font-size:13px; padding:8px 12px; flex:1;">
        <button class="tma-btn" onclick="document.getElementById('agent-new').scrollIntoView({behavior:'smooth'})" style="font-size:13px; padding:8px 12px;">+ New</button>
      </div>
      <div id="agent-list">
        <div class="tma-group" data-group="Built-in">
          <div class="tma-group-header">Built-in <span class="tma-hint">(${builtins.length})</span></div>
          ${builtinHtml}
        </div>
        ${customHtml}
      </div>
      ${tmaAgentNewFragment()}
    </div>
    <script>
    function searchAgents(q) {
      var query = q.toLowerCase();
      document.querySelectorAll('.tma-card[data-slug]').forEach(function(card) {
        var slug = card.getAttribute('data-slug') || '';
        var name = card.getAttribute('data-name') || '';
        var match = !query || slug.includes(query) || name.includes(query);
        card.style.display = match ? '' : 'none';
      });
    }
    </script>
  `);
}

// --- Card (compact, expandable) ---

export function tmaAgentCardFragment(agent: Agent, jobCount: number): string {
  const policy = agent.notify_policy;
  const pills = [
    `<span class="tma-pill">${escapeHtml(agent.model)}</span>`,
    agent.backend ? `<span class="tma-pill">${backendLabel(agent.backend)}</span>` : "",
    `<span class="tma-pill" style="background:${policyColor(policy)}20; color:${policyColor(policy)};">${policyLabel(policy)}</span>`,
    agent.critic_agent_slug ? `<span class="tma-pill">Critic: ${escapeHtml(agent.critic_agent_slug)}</span>` : "",
    jobCount > 0 ? `<span class="tma-pill">${jobCount} job${jobCount === 1 ? "" : "s"}</span>` : "",
  ].filter(Boolean).join(" ");

  return `<div class="tma-card" id="agent-${agent.slug}" data-slug="${escapeHtml(agent.slug)}" data-name="${escapeHtml(agent.name.toLowerCase())}">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px; cursor:pointer;"
         hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/detail" hx-target="#agent-${agent.slug}" hx-swap="outerHTML">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:14px;">${escapeHtml(agent.name)} <span class="tma-hint" style="font-weight:normal;">${escapeHtml(agent.slug)}</span></div>
        <div style="display:flex; gap:4px; margin-top:5px; flex-wrap:wrap;">${pills}</div>
        ${agent.description ? `<div class="tma-hint" style="margin-top:4px; font-size:12px; line-height:1.3;">${escapeHtml(agent.description.slice(0, 120))}</div>` : ""}
      </div>
      ${agent.is_builtin ? `<span class="tma-badge tma-badge-enabled" style="flex-shrink:0;">Built-in</span>` : ""}
    </div>
  </div>`;
}

// --- Detail + Edit ---

export function tmaAgentDetailFragment(
  agent: Agent,
  jobs: Job[],
  memoryFiles: string[],
): string {
  const policy = agent.notify_policy;
  const topicLabel = agent.notify_topic_id
    ? TOPIC_OPTIONS.find((t) => t.value === agent.notify_topic_id)?.label ?? `Topic #${agent.notify_topic_id}`
    : "DM (default)";

  const memoryList = memoryFiles.length > 0
    ? memoryFiles.map((f) =>
        `<li style="margin:4px 0; display:flex; align-items:center; gap:8px;">
          <a href="/tma/agents/${encodeURIComponent(agent.slug)}/memory/${encodeURIComponent(f)}" style="color:var(--tma-link); flex:1;">${escapeHtml(f)}</a>
          <button class="tma-btn-icon" style="color:#ef4444; font-size:14px;"
            hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/memory/${encodeURIComponent(f)}/delete"
            hx-confirm="Delete ${escapeHtml(f)}?"
            hx-target="#agent-${agent.slug}" hx-swap="outerHTML" title="Delete">&times;</button>
        </li>`
      ).join("")
    : `<li class="tma-hint">No files yet</li>`;

  const jobList = jobs.length > 0
    ? jobs.map((j) => {
        const statusPill = j.status === "enabled"
          ? `<span class="tma-pill" style="background:#10b98120; color:#10b981;">on</span>`
          : `<span class="tma-pill" style="background:#6b728020; color:#6b7280;">off</span>`;
        return `<li style="margin:4px 0;">
          <a href="/tma/jobs#job-${j.id}" style="color:var(--tma-link);">${escapeHtml(j.name)}</a>
          ${statusPill}
        </li>`;
      }).join("")
    : `<li class="tma-hint">No jobs using this agent</li>`;

  return `<div class="tma-card" id="agent-${agent.slug}">
    <div style="display:flex; justify-content:space-between; align-items:start; gap:8px;">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:15px;">${escapeHtml(agent.name)}</div>
        <div class="tma-hint" style="font-size:12px;">${escapeHtml(agent.slug)}</div>
      </div>
      <button class="tma-btn-icon" hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/card" hx-target="#agent-${agent.slug}" hx-swap="outerHTML" title="Close">&times;</button>
    </div>

    ${agent.description ? `<div style="margin-top:8px; font-size:13px;">${escapeHtml(agent.description)}</div>` : ""}

    <dl style="margin-top:10px; font-size:12px; display:grid; grid-template-columns: 100px 1fr; gap:4px 8px;">
      <dt class="tma-hint">Model</dt><dd>${escapeHtml(agent.model)}</dd>
      <dt class="tma-hint">Backend</dt><dd>${escapeHtml(backendLabel(agent.backend))}</dd>
      <dt class="tma-hint">Notify</dt><dd><span class="tma-pill" style="background:${policyColor(policy)}20; color:${policyColor(policy)};">${policyLabel(policy)}</span></dd>
      <dt class="tma-hint">Topic</dt><dd>${escapeHtml(topicLabel)}</dd>
      ${agent.critic_agent_slug ? `<dt class="tma-hint">Critic</dt><dd>${escapeHtml(agent.critic_agent_slug)}</dd>` : ""}
      <dt class="tma-hint">Memory</dt><dd><code>knowledge/${escapeHtml(agent.memory_dir)}/</code></dd>
      <dt class="tma-hint">Jobs</dt><dd>${jobs.length} using this agent</dd>
    </dl>

    <details style="margin-top:10px;">
      <summary style="cursor:pointer; font-size:13px; font-weight:600;">Jobs (${jobs.length})</summary>
      <ul style="margin:6px 0 0; padding-left:20px; font-size:12px;">${jobList}</ul>
    </details>

    <details style="margin-top:10px;">
      <summary style="cursor:pointer; font-size:13px; font-weight:600;">Memory files (${memoryFiles.length})</summary>
      <ul style="margin:6px 0 0; padding-left:20px; font-size:12px; list-style:none;">${memoryList}</ul>
      <div style="margin-top:8px;">
        <a href="/tma/agents/${encodeURIComponent(agent.slug)}/memory-new" class="tma-btn" style="font-size:12px; padding:4px 10px;">+ New file</a>
      </div>
    </details>

    ${agent.role || agent.goal || agent.backstory ? `
    <details style="margin-top:10px;">
      <summary style="cursor:pointer; font-size:13px; font-weight:600;">Role / Goal / Backstory</summary>
      <div style="font-size:12px; line-height:1.4; margin-top:6px;">
        ${agent.role ? `<div style="margin-bottom:6px;"><strong>Role:</strong><br>${escapeHtml(agent.role)}</div>` : ""}
        ${agent.goal ? `<div style="margin-bottom:6px;"><strong>Goal:</strong><br>${escapeHtml(agent.goal)}</div>` : ""}
        ${agent.backstory ? `<div><strong>Backstory:</strong><br>${escapeHtml(agent.backstory)}</div>` : ""}
      </div>
    </details>
    ` : ""}

    <details style="margin-top:10px;">
      <summary style="cursor:pointer; font-size:13px; font-weight:600;">System prompt</summary>
      <pre style="font-size:11px; white-space:pre-wrap; margin:6px 0 0; padding:8px; background:var(--tma-card-bg); border-radius:6px; max-height:240px; overflow:auto;">${escapeHtml(agent.prompt)}</pre>
    </details>

    <div style="display:flex; gap:8px; margin-top:12px;">
      <button class="tma-btn" hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/edit" hx-target="#agent-${agent.slug}" hx-swap="outerHTML">Edit</button>
      ${!agent.is_builtin ? `
        <button class="tma-btn" style="color:#ef4444;"
          hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/delete"
          hx-confirm="Delete agent '${escapeHtml(agent.slug)}'? ${jobs.length > 0 ? `${jobs.length} job(s) will fall back to the main agent.` : ""}"
          hx-target="#agent-list" hx-swap="outerHTML">Delete</button>
      ` : ""}
    </div>
  </div>`;
}

export function tmaAgentEditFragment(agent: Agent, allAgents: Agent[]): string {
  const policyOpts = NOTIFY_POLICIES
    .map((p) => `<option value="${p}"${p === agent.notify_policy ? " selected" : ""}>${policyLabel(p)}</option>`)
    .join("");

  const modelOpts = MODEL_OPTIONS
    .map((m) => `<option value="${m}"${m === agent.model ? " selected" : ""}>${m}</option>`)
    .join("");

  const backendOpts = BACKEND_OPTIONS
    .map((b) => `<option value="${b.value}"${(b.value || null) === agent.backend ? " selected" : ""}>${b.label}</option>`)
    .join("");

  const topicOpts = TOPIC_OPTIONS
    .map((t) => `<option value="${t.value}"${t.value === (agent.notify_topic_id ?? 0) ? " selected" : ""}>${t.label}</option>`)
    .join("");

  const criticOpts = [`<option value="">(none)</option>`]
    .concat(
      allAgents
        .filter((a) => a.slug !== agent.slug)
        .map((a) => `<option value="${escapeHtml(a.slug)}"${a.slug === agent.critic_agent_slug ? " selected" : ""}>${escapeHtml(a.slug)}</option>`)
    )
    .join("");

  return `<form class="tma-card" id="agent-${agent.slug}"
    hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/update"
    hx-target="#agent-${agent.slug}" hx-swap="outerHTML" hx-encoding="multipart/form-data">

    <div style="font-weight:600; font-size:15px; margin-bottom:8px;">Edit ${escapeHtml(agent.slug)}</div>

    <label class="tma-form-label">Name</label>
    <input class="tma-input" name="name" value="${escapeHtml(agent.name)}" required>

    <label class="tma-form-label">Description</label>
    <input class="tma-input" name="description" value="${escapeHtml(agent.description)}">

    <label class="tma-form-label">Role</label>
    <input class="tma-input" name="role" value="${escapeHtml(agent.role)}" placeholder="e.g. Senior quant researcher">

    <label class="tma-form-label">Goal</label>
    <textarea class="tma-input" name="goal" rows="2" placeholder="The single objective this agent optimizes for">${escapeHtml(agent.goal)}</textarea>

    <label class="tma-form-label">Backstory</label>
    <textarea class="tma-input" name="backstory" rows="3" placeholder="Context, constraints, operating style">${escapeHtml(agent.backstory)}</textarea>

    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
      <div>
        <label class="tma-form-label">Model</label>
        <select class="tma-input" name="model">${modelOpts}</select>
      </div>
      <div>
        <label class="tma-form-label">Backend</label>
        <select class="tma-input" name="backend">${backendOpts}</select>
      </div>
      <div>
        <label class="tma-form-label">Notify policy</label>
        <select class="tma-input" name="notify_policy">${policyOpts}</select>
      </div>
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
      <div>
        <label class="tma-form-label">Default topic</label>
        <select class="tma-input" name="notify_topic_id">${topicOpts}</select>
      </div>
      <div>
        <label class="tma-form-label">Critic agent</label>
        <select class="tma-input" name="critic_agent_slug">${criticOpts}</select>
      </div>
    </div>

    <label class="tma-form-label">Output template (optional)</label>
    <textarea class="tma-input" name="output_template" rows="3"
      placeholder="{{headline}} — {{summary}}&#10;Applied when the agent returns JSON.">${escapeHtml(agent.output_template ?? "")}</textarea>

    <label class="tma-form-label">System prompt</label>
    <textarea class="tma-input" name="prompt" rows="10" required>${escapeHtml(agent.prompt)}</textarea>

    <div style="display:flex; gap:8px; margin-top:12px;">
      <button type="submit" class="tma-btn tma-btn-primary">Save</button>
      <button type="button" class="tma-btn"
        hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/card"
        hx-target="#agent-${agent.slug}" hx-swap="outerHTML">Cancel</button>
    </div>
  </form>`;
}

// --- New agent form ---

export function tmaAgentNewFragment(): string {
  return `<details id="agent-new" style="margin:16px; border:1px dashed var(--tma-border); border-radius:8px; padding:12px;">
    <summary style="cursor:pointer; font-weight:600; font-size:13px;">+ Create new agent</summary>
    <form style="margin-top:10px;"
      hx-post="/tma/api/agents/create"
      hx-target="#agent-list" hx-swap="outerHTML" hx-encoding="multipart/form-data">

      <label class="tma-form-label">Slug (URL-safe)</label>
      <input class="tma-input" name="slug" required pattern="[a-z0-9-]+" placeholder="my-agent">

      <label class="tma-form-label">Name</label>
      <input class="tma-input" name="name" required placeholder="My Agent">

      <label class="tma-form-label">Description</label>
      <input class="tma-input" name="description" placeholder="One-line description for the subagent listing">

      <label class="tma-form-label">System prompt</label>
      <textarea class="tma-input" name="prompt" rows="6" required placeholder="You are a specialized agent that..."></textarea>

      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
        <div>
          <label class="tma-form-label">Model</label>
          <select class="tma-input" name="model">
            <option value="sonnet">sonnet</option>
            <option value="haiku">haiku</option>
            <option value="opus">opus</option>
          </select>
        </div>
        <div>
          <label class="tma-form-label">Backend</label>
          <select class="tma-input" name="backend">
            <option value="">(default)</option>
            <option value="claude">Claude</option>
            <option value="glm">GLM</option>
          </select>
        </div>
        <div>
          <label class="tma-form-label">Notify policy</label>
          <select class="tma-input" name="notify_policy">
            <option value="always">Always</option>
            <option value="on_error">On error</option>
            <option value="on_change">On change</option>
            <option value="silent">Silent</option>
            <option value="dynamic">Dynamic</option>
          </select>
        </div>
      </div>

      <button type="submit" class="tma-btn tma-btn-primary" style="margin-top:10px;">Create</button>
    </form>
  </details>`;
}

export function tmaAgentListFragment(agents: Agent[], jobCounts: Map<string, number>): string {
  const builtins = agents.filter((a) => a.is_builtin);
  const custom = agents.filter((a) => !a.is_builtin);
  const builtinHtml = builtins.map((a) => tmaAgentCardFragment(a, jobCounts.get(a.slug) ?? 0)).join("\n");
  const customHtml = custom.length > 0
    ? `<div class="tma-group" data-group="Custom">
        <div class="tma-group-header">Custom <span class="tma-hint">(${custom.length})</span></div>
        ${custom.map((a) => tmaAgentCardFragment(a, jobCounts.get(a.slug) ?? 0)).join("\n")}
      </div>`
    : "";
  return `<div id="agent-list">
    <div class="tma-group" data-group="Built-in">
      <div class="tma-group-header">Built-in <span class="tma-hint">(${builtins.length})</span></div>
      ${builtinHtml}
    </div>
    ${customHtml}
  </div>`;
}

// --- Memory file viewer/editor ---

export function tmaAgentMemoryPage(agent: Agent, filename: string, content: string): string {
  const isNew = filename === "";
  const breadcrumb = `<a href="/tma/agents" style="color:var(--tma-link);">Agents</a> /
     <a href="/tma/agents#agent-${encodeURIComponent(agent.slug)}" style="color:var(--tma-link);">${escapeHtml(agent.slug)}</a> /
     <strong>${isNew ? "New file" : escapeHtml(filename)}</strong>`;

  const formAttrs = isNew
    ? `hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/memory/create" hx-encoding="multipart/form-data"`
    : `hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/memory/${encodeURIComponent(filename)}/save" hx-target="#memory-status" hx-swap="innerHTML" hx-encoding="multipart/form-data"`;

  const filenameInput = isNew
    ? `<label class="tma-form-label">Filename</label>
       <input class="tma-input" name="filename" required pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-.]*(\\.md)?" placeholder="e.g. notes.md" style="font-size:13px; margin-bottom:8px;">`
    : "";

  return miniAppLayout("agents", `
    <div style="padding:8px 16px;">
      <div style="font-size:13px; margin-bottom:6px;">${breadcrumb}</div>
      <form ${formAttrs}>
        ${filenameInput}
        <textarea class="tma-input" name="content" rows="20" style="font-family:monospace; font-size:12px;">${escapeHtml(content)}</textarea>
        <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
          <button type="submit" class="tma-btn tma-btn-primary">${isNew ? "Create" : "Save"}</button>
          <a href="/tma/agents" class="tma-btn">Back</a>
          ${isNew ? "" : `<span id="memory-status" class="tma-hint"></span>`}
        </div>
      </form>
    </div>
  `);
}
