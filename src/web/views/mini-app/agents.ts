import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  pageHeader,
  card,
  badge,
  type BadgeKind,
  searchBar,
  emptyState,
  section,
  formField,
  formActions,
  button,
  detailsPanel,
} from "./components.ts";
import type { Agent, AgentBackend, AgentNotifyPolicy, Job } from "../../../shared/types.ts";

const TOPIC_OPTIONS = [
  { value: 0, label: "DM (no topic)" },
  { value: 5, label: "GLM" },
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

// Page-local responsive rule: 3-col / 2-col grids collapse to 1 column below 400px.
// (components.ts/tma.css are owned by other agents — kept minimal + scoped, mirrors more.ts.)
const AGENT_FORM_GRID_STYLE = `<style>
  .tma-form-grid-3 { display:grid; grid-template-columns:repeat(3, 1fr); gap:var(--sp-2); }
  .tma-form-grid-2 { display:grid; grid-template-columns:repeat(2, 1fr); gap:var(--sp-2); }
  @media (max-width: 400px) {
    .tma-form-grid-3, .tma-form-grid-2 { grid-template-columns:1fr; }
  }
</style>`;

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

/** Map notify policy -> badge kind (policy colors become semantic badge kinds). */
function policyBadgeKind(policy: AgentNotifyPolicy): BadgeKind {
  switch (policy) {
    case "always":
      return "accent";
    case "on_error":
      return "err";
    case "on_change":
      return "warn";
    case "silent":
      return "muted";
    case "dynamic":
      return "ok";
  }
}

function policyBadge(policy: AgentNotifyPolicy): string {
  return badge(policyLabel(policy), policyBadgeKind(policy));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function tmaAgentsPage(agents: Agent[], jobCounts: Map<string, number>): string {
  const builtins = agents.filter((a) => a.is_builtin);
  const custom = agents.filter((a) => !a.is_builtin);

  const headerActions = button("+ New", {
    kind: "primary",
    small: true,
    onclick: "document.getElementById('agent-new-form').scrollIntoView({behavior:'smooth'})",
  });

  const listHtml = agents.length > 0
    ? tmaAgentListFragmentInner(builtins, custom, jobCounts)
    : emptyState("🤖", "No agents yet", "Create your first agent below");

  return miniAppLayout("agents", `
    ${pageHeader("Agents", { actions: headerActions })}
    <div class="tma-search-scope" data-tma-filter-scope>
      ${searchBar("", "Search agents…")}
      <div id="agent-list">
        ${listHtml}
      </div>
    </div>
    ${section("New agent", tmaAgentNewFragment())}
  `);
}

function tmaAgentListFragmentInner(
  builtins: Agent[],
  custom: Agent[],
  jobCounts: Map<string, number>,
): string {
  const builtinHtml = builtins.map((a) => tmaAgentCardFragment(a, jobCounts.get(a.slug) ?? 0)).join("\n");
  const customHtml = custom.length > 0
    ? `<div class="tma-group" data-group="Custom">
        <div class="tma-group-header">Custom <span class="tma-hint">(${custom.length})</span></div>
        ${custom.map((a) => tmaAgentCardFragment(a, jobCounts.get(a.slug) ?? 0)).join("\n")}
      </div>`
    : "";
  return `<div class="tma-group" data-group="Built-in">
      <div class="tma-group-header">Built-in <span class="tma-hint">(${builtins.length})</span></div>
      ${builtinHtml || emptyState("🤖", "No built-in agents")}
    </div>
    ${customHtml}`;
}

// ---------------------------------------------------------------------------
// Card (compact, expandable)
// ---------------------------------------------------------------------------

export function tmaAgentCardFragment(agent: Agent, jobCount: number): string {
  const policy = agent.notify_policy;
  const pills = [
    `<span class="tma-pill">${escapeHtml(agent.model)}</span>`,
    agent.backend ? `<span class="tma-pill">${escapeHtml(backendLabel(agent.backend))}</span>` : "",
    policyBadge(policy),
    agent.critic_agent_slug ? `<span class="tma-pill">Critic: ${escapeHtml(agent.critic_agent_slug)}</span>` : "",
    jobCount > 0 ? `<span class="tma-pill">${jobCount} job${jobCount === 1 ? "" : "s"}</span>` : "",
  ].filter(Boolean).join(" ");

  const inner = `<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:var(--sp-2);">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:var(--fs-md);">${escapeHtml(agent.name)} <span class="tma-hint" style="font-weight:normal;">${escapeHtml(agent.slug)}</span></div>
        <div style="display:flex; gap:var(--sp-1); margin-top:var(--sp-1); flex-wrap:wrap; align-items:center;">${pills}</div>
        ${agent.description ? `<div class="tma-hint" style="margin-top:var(--sp-1); font-size:var(--fs-xs); line-height:1.3;">${escapeHtml(agent.description.slice(0, 120))}</div>` : ""}
      </div>
      ${agent.is_builtin ? badge("Built-in", "accent") : ""}
    </div>`;

  return card(inner, {
    attrs: `id="agent-${escapeAttr(agent.slug)}" data-tma-filter-item data-tma-filter-text="${escapeAttr(`${agent.slug} ${agent.name}`.toLowerCase())}" hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/detail" hx-target="#agent-${escapeAttr(agent.slug)}" hx-swap="outerHTML" role="button" tabindex="0"`,
  });
}

// ---------------------------------------------------------------------------
// Detail + Edit
// ---------------------------------------------------------------------------

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
        `<li style="margin:var(--sp-1) 0; display:flex; align-items:center; gap:var(--sp-2);">
          <a href="/tma/agents/${encodeURIComponent(agent.slug)}/memory/${encodeURIComponent(f)}" style="color:var(--tma-link); flex:1; min-height:44px; display:flex; align-items:center;">${escapeHtml(f)}</a>
          <button class="tma-btn-icon" style="color:var(--tma-destructive); font-size:var(--fs-md);"
            hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/memory/${encodeURIComponent(f)}/delete"
            hx-confirm="Delete ${escapeAttr(f)}?"
            hx-target="#agent-${escapeAttr(agent.slug)}" hx-swap="outerHTML" title="Delete">&times;</button>
        </li>`
      ).join("")
    : `<li class="tma-hint">No files yet</li>`;

  const jobList = jobs.length > 0
    ? jobs.map((j) => {
        const statusPill = j.status === "enabled" ? badge("on", "ok") : badge("off", "muted");
        return `<li style="margin:var(--sp-1) 0; display:flex; align-items:center; gap:var(--sp-2);">
          <a href="/tma/jobs#job-${j.id}" style="color:var(--tma-link); flex:1;">${escapeHtml(j.name)}</a>
          ${statusPill}
        </li>`;
      }).join("")
    : `<li class="tma-hint">No jobs using this agent</li>`;

  const roleGoalBackstory = agent.role || agent.goal || agent.backstory
    ? detailsPanel(
        "Role / Goal / Backstory",
        `<div style="font-size:var(--fs-sm); line-height:1.4;">
          ${agent.role ? `<div style="margin-bottom:var(--sp-2);"><strong>Role:</strong><br>${escapeHtml(agent.role)}</div>` : ""}
          ${agent.goal ? `<div style="margin-bottom:var(--sp-2);"><strong>Goal:</strong><br>${escapeHtml(agent.goal)}</div>` : ""}
          ${agent.backstory ? `<div><strong>Backstory:</strong><br>${escapeHtml(agent.backstory)}</div>` : ""}
        </div>`,
      )
    : "";

  const inner = `<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:var(--sp-2);">
      <div style="min-width:0; flex:1;">
        <div style="font-weight:600; font-size:var(--fs-lg);">${escapeHtml(agent.name)}</div>
        <div class="tma-hint" style="font-size:var(--fs-xs);">${escapeHtml(agent.slug)}</div>
      </div>
      <button class="tma-btn-icon" hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/card" hx-target="#agent-${escapeAttr(agent.slug)}" hx-swap="outerHTML" title="Close">&times;</button>
    </div>

    ${agent.description ? `<div style="margin-top:var(--sp-2); font-size:var(--fs-sm);">${escapeHtml(agent.description)}</div>` : ""}

    <dl style="margin-top:var(--sp-3); font-size:var(--fs-xs); display:grid; grid-template-columns: 100px 1fr; gap:var(--sp-1) var(--sp-2);">
      <dt class="tma-hint">Model</dt><dd>${escapeHtml(agent.model)}</dd>
      <dt class="tma-hint">Backend</dt><dd>${escapeHtml(backendLabel(agent.backend))}</dd>
      <dt class="tma-hint">Notify</dt><dd>${policyBadge(policy)}</dd>
      <dt class="tma-hint">Topic</dt><dd>${escapeHtml(topicLabel)}</dd>
      ${agent.critic_agent_slug ? `<dt class="tma-hint">Critic</dt><dd>${escapeHtml(agent.critic_agent_slug)}</dd>` : ""}
      <dt class="tma-hint">Memory</dt><dd class="tma-mono">knowledge/${escapeHtml(agent.memory_dir)}/</dd>
      <dt class="tma-hint">Jobs</dt><dd>${jobs.length} using this agent</dd>
    </dl>

    ${detailsPanel(`Jobs (${jobs.length})`, `<ul style="margin:0; padding-left:20px; font-size:var(--fs-xs); list-style:none; padding-left:0;">${jobList}</ul>`)}

    ${detailsPanel(
      `Memory files (${memoryFiles.length})`,
      `<ul style="margin:0; padding-left:0; font-size:var(--fs-xs); list-style:none;">${memoryList}</ul>
      <div style="margin-top:var(--sp-2);">
        <a href="/tma/agents/${encodeURIComponent(agent.slug)}/memory-new" class="tma-btn tma-btn-sm">+ New file</a>
      </div>`,
    )}

    ${roleGoalBackstory}

    ${detailsPanel(
      "System prompt",
      `<pre class="tma-mono" style="white-space:pre-wrap; margin:0; padding:var(--sp-2); background:var(--tma-bg-secondary); border-radius:var(--rad-sm); max-height:240px; overflow:auto;">${escapeHtml(agent.prompt)}</pre>`,
    )}

    <div style="display:flex; gap:var(--sp-2); margin-top:var(--sp-3); flex-wrap:wrap;">
      ${button("Edit", { attrs: `hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/edit" hx-target="#agent-${escapeAttr(agent.slug)}" hx-swap="outerHTML"` })}
      ${!agent.is_builtin
        ? button("Delete", {
            kind: "danger",
            attrs: `hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/delete" hx-confirm="${escapeAttr(`Delete agent '${agent.slug}'? ${jobs.length > 0 ? `${jobs.length} job(s) will fall back to the main agent.` : ""}`)}" hx-target="#agent-list" hx-swap="innerHTML" hx-on::after-request="showToast('Agent deleted')"`,
          })
        : ""}
    </div>`;

  return card(inner, { className: "tma-card-expanded", attrs: `id="agent-${escapeAttr(agent.slug)}"` });
}

export function tmaAgentEditFragment(agent: Agent, allAgents: Agent[]): string {
  const policyOpts = NOTIFY_POLICIES
    .map((p) => `<option value="${p}"${p === agent.notify_policy ? " selected" : ""}>${policyLabel(p)}</option>`)
    .join("");

  const modelOpts = MODEL_OPTIONS
    .map((m) => `<option value="${m}"${m === agent.model ? " selected" : ""}>${m}</option>`)
    .join("");

  const backendOpts = BACKEND_OPTIONS
    .map((b) => `<option value="${escapeAttr(b.value)}"${(b.value || null) === agent.backend ? " selected" : ""}>${escapeHtml(b.label)}</option>`)
    .join("");

  const topicOpts = TOPIC_OPTIONS
    .map((t) => `<option value="${t.value}"${t.value === (agent.notify_topic_id ?? 0) ? " selected" : ""}>${escapeHtml(t.label)}</option>`)
    .join("");

  const criticOpts = [`<option value="">(none)</option>`]
    .concat(
      allAgents
        .filter((a) => a.slug !== agent.slug)
        .map((a) => `<option value="${escapeAttr(a.slug)}"${a.slug === agent.critic_agent_slug ? " selected" : ""}>${escapeHtml(a.slug)}</option>`)
    )
    .join("");

  const inner = `${AGENT_FORM_GRID_STYLE}
    <div style="font-weight:600; font-size:var(--fs-lg); margin-bottom:var(--sp-2);">Edit ${escapeHtml(agent.slug)}</div>

    ${formField("Name", `<input class="tma-input" name="name" value="${escapeAttr(agent.name)}" required>`)}
    ${formField("Description", `<input class="tma-input" name="description" value="${escapeAttr(agent.description)}">`)}
    ${formField("Role", `<input class="tma-input" name="role" value="${escapeAttr(agent.role)}" placeholder="e.g. Senior quant researcher">`)}
    ${formField("Goal", `<textarea class="tma-input tma-textarea" name="goal" rows="2" placeholder="The single objective this agent optimizes for">${escapeHtml(agent.goal)}</textarea>`)}
    ${formField("Backstory", `<textarea class="tma-input tma-textarea" name="backstory" rows="3" placeholder="Context, constraints, operating style">${escapeHtml(agent.backstory)}</textarea>`)}

    <div class="tma-form-field tma-form-grid-3">
      <div>
        <label class="tma-field-label">Model</label>
        <select class="tma-input" name="model">${modelOpts}</select>
      </div>
      <div>
        <label class="tma-field-label">Backend</label>
        <select class="tma-input" name="backend">${backendOpts}</select>
      </div>
      <div>
        <label class="tma-field-label">Notify policy</label>
        <select class="tma-input" name="notify_policy">${policyOpts}</select>
      </div>
    </div>

    <div class="tma-form-field tma-form-grid-2">
      <div>
        <label class="tma-field-label">Default topic</label>
        <select class="tma-input" name="notify_topic_id">${topicOpts}</select>
      </div>
      <div>
        <label class="tma-field-label">Critic agent</label>
        <select class="tma-input" name="critic_agent_slug">${criticOpts}</select>
      </div>
    </div>

    ${formField(
      "Output template (optional)",
      `<textarea class="tma-input tma-textarea" name="output_template" rows="3" placeholder="{{headline}} — {{summary}}&#10;Applied when the agent returns JSON.">${escapeHtml(agent.output_template ?? "")}</textarea>`,
    )}
    ${formField("System prompt", `<textarea class="tma-input tma-textarea tma-mono" name="prompt" rows="10" required>${escapeHtml(agent.prompt)}</textarea>`)}

    ${formActions(
      button("Save", { kind: "primary", attrs: `type="submit"` }),
      button("Cancel", {
        kind: "secondary",
        attrs: `type="button" hx-get="/tma/api/agents/${encodeURIComponent(agent.slug)}/card" hx-target="#agent-${escapeAttr(agent.slug)}" hx-swap="outerHTML"`,
      }),
    )}`;

  return `<form class="tma-card tma-card-expanded" id="agent-${escapeAttr(agent.slug)}"
    hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/update"
    hx-target="#agent-${escapeAttr(agent.slug)}" hx-swap="outerHTML"
    hx-on::after-request="showToast('Agent saved')">
    ${inner}
  </form>`;
}

// ---------------------------------------------------------------------------
// New agent form
// ---------------------------------------------------------------------------

export function tmaAgentNewFragment(): string {
  const inner = `${AGENT_FORM_GRID_STYLE}
    ${formField("Slug (URL-safe)", `<input class="tma-input" name="slug" required pattern="[a-z0-9-]+" placeholder="my-agent">`)}
    ${formField("Name", `<input class="tma-input" name="name" required placeholder="My Agent">`)}
    ${formField("Description", `<input class="tma-input" name="description" placeholder="One-line description for the subagent listing">`)}
    ${formField("System prompt", `<textarea class="tma-input tma-textarea" name="prompt" rows="6" required placeholder="You are a specialized agent that..."></textarea>`)}

    <div class="tma-form-field tma-form-grid-3">
      <div>
        <label class="tma-field-label">Model</label>
        <select class="tma-input" name="model">
          <option value="sonnet">sonnet</option>
          <option value="haiku">haiku</option>
          <option value="opus">opus</option>
        </select>
      </div>
      <div>
        <label class="tma-field-label">Backend</label>
        <select class="tma-input" name="backend">
          <option value="">(default)</option>
          <option value="claude">Claude</option>
          <option value="glm">GLM</option>
        </select>
      </div>
      <div>
        <label class="tma-field-label">Notify policy</label>
        <select class="tma-input" name="notify_policy">
          <option value="always">Always</option>
          <option value="on_error">On error</option>
          <option value="on_change">On change</option>
          <option value="silent">Silent</option>
          <option value="dynamic">Dynamic</option>
        </select>
      </div>
    </div>

    ${formActions(button("Create", { kind: "primary", attrs: `type="submit"` }))}`;

  return `<form id="agent-new-form"
    hx-post="/tma/api/agents/create"
    hx-target="#agent-list" hx-swap="innerHTML"
    hx-on::after-request="showToast('Agent created')">
    ${inner}
  </form>`;
}

export function tmaAgentListFragment(agents: Agent[], jobCounts: Map<string, number>): string {
  const builtins = agents.filter((a) => a.is_builtin);
  const custom = agents.filter((a) => !a.is_builtin);
  return tmaAgentListFragmentInner(builtins, custom, jobCounts);
}

// ---------------------------------------------------------------------------
// Memory file viewer/editor
// ---------------------------------------------------------------------------

export function tmaAgentMemoryPage(agent: Agent, filename: string, content: string): string {
  const isNew = filename === "";
  const breadcrumb = `<a href="/tma/agents" style="color:var(--tma-link);">Agents</a> /
     <a href="/tma/agents#agent-${encodeURIComponent(agent.slug)}" style="color:var(--tma-link);">${escapeHtml(agent.slug)}</a> /
     <strong>${isNew ? "New file" : escapeHtml(filename)}</strong>`;

  const formAttrs = isNew
    ? `hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/memory/create"`
    : `hx-post="/tma/api/agents/${encodeURIComponent(agent.slug)}/memory/${encodeURIComponent(filename)}/save" hx-target="#memory-status" hx-swap="innerHTML" hx-on::after-request="showToast('Memory file saved')"`;

  const filenameInput = isNew
    ? formField(
        "Filename",
        `<input class="tma-input" name="filename" required pattern="[a-zA-Z0-9][a-zA-Z0-9_\\-.]*(\\.md)?" placeholder="e.g. notes.md">`,
      )
    : "";

  return miniAppLayout(
    "agents",
    `${pageHeader(isNew ? "New memory file" : filename, { subtitle: agent.name })}
    <div style="padding:0 var(--sp-4) var(--sp-4);">
      <div style="font-size:var(--fs-sm); margin-bottom:var(--sp-2);">${breadcrumb}</div>
      <form ${formAttrs}>
        ${filenameInput}
        ${formField("Content", `<textarea class="tma-input tma-textarea tma-mono" name="content" rows="20">${escapeHtml(content)}</textarea>`)}
        ${formActions(
          button(isNew ? "Create" : "Save", { kind: "primary", attrs: `type="submit"` }),
          button("Back", { href: "/tma/agents" }),
        )}
        ${isNew ? "" : `<span id="memory-status" class="tma-hint"></span>`}
      </form>
    </div>`,
    false,
  );
}
