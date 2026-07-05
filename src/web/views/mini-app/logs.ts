import { miniAppLayout } from "./shell.ts";
import {
  pageHeader,
  card,
  badge,
  filterChips,
  detailsPanel,
  emptyState,
  errorState,
  formatCost,
  truncate,
  escapeHtml,
  button,
  type BadgeKind,
} from "./components.ts";
import type { ToolUse } from "../../../shared/types.ts";

interface SessionLog {
  session_id: string;
  source: string;
  model: string;
  total_cost_usd: number;
  message_count: number;
  first_prompt: string | null;
  updated_at: string;
  tools: ToolUse[];
}

const SOURCE_BADGE: Record<string, BadgeKind> = {
  telegram: "ok",
  web: "warn",
  "mini-app": "warn",
  job: "muted",
  heartbeat: "muted",
};

function sourceBadge(source: string): string {
  return badge(source, SOURCE_BADGE[source] ?? "muted");
}

function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

function shortModel(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model.slice(0, 12);
}

function toolList(tools: ToolUse[]): string {
  if (tools.length === 0) {
    return `<div class="tma-hint">No tool calls recorded</div>`;
  }
  const items = tools
    .map((t) => {
      const name = shortToolName(t.tool_name);
      const sub = t.is_subagent ? ` ${badge("subagent", "muted")}` : "";
      const detail = t.input_summary
        ? `<div class="tma-hint tma-mono" style="margin-left:var(--sp-3); word-break:break-word;">${escapeHtml(t.input_summary)}</div>`
        : "";
      return `<div style="padding:var(--sp-1) 0; border-bottom:1px solid var(--tma-border);">
        <div class="tma-mono" style="font-size:var(--fs-sm);">${escapeHtml(name)}${sub}</div>
        ${detail}
      </div>`;
    })
    .join("\n");
  return `<div style="max-height:280px; overflow-y:auto;">${items}</div>`;
}

function sessionCard(s: SessionLog): string {
  const sid = s.session_id.slice(0, 8);
  const cost = formatCost(s.total_cost_usd);
  const time = s.updated_at?.replace("T", " ").slice(0, 16) ?? "—";
  const title = s.first_prompt
    ? truncate(s.first_prompt.replace(/\n/g, " "), 60)
    : "(no prompt)";
  const meta = [cost, `${s.message_count} msg`, `${s.tools.length} tools`, shortModel(s.model)]
    .filter(Boolean)
    .join(" · ");

  const summaryHtml = `<div style="display:flex; align-items:center; justify-content:space-between; gap:var(--sp-2);">
    <div style="display:flex; align-items:center; gap:var(--sp-2); min-width:0;">
      ${sourceBadge(s.source)}
      <span style="font-size:var(--fs-sm); font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(title)}</span>
    </div>
    <span class="tma-hint tma-mono" style="white-space:nowrap;">${sid}</span>
  </div>
  <div style="display:flex; justify-content:space-between; margin-top:var(--sp-1);">
    <span class="tma-hint">${escapeHtml(time)}</span>
    <span class="tma-hint">${meta}</span>
  </div>`;

  return card(
    `<details data-tma-filter-item data-source="${escapeHtml(s.source)}" data-model="${escapeHtml(shortModel(s.model))}">
      <summary style="list-style:none; cursor:pointer;">${summaryHtml}</summary>
      <div style="margin-top:var(--sp-2);">${toolList(s.tools)}</div>
    </details>`,
  );
}

function sourceOptions(sessions: SessionLog[]): { value: string; label: string }[] {
  const sources = Array.from(new Set(sessions.map((s) => s.source))).sort();
  return [{ value: "all", label: "All" }, ...sources.map((s) => ({ value: s, label: s }))];
}

function logListBody(sessions: SessionLog[]): string {
  if (sessions.length === 0) {
    return emptyState("📋", "No activity yet", "Sessions will appear here as the agent runs.");
  }
  return `<div style="padding:0 var(--sp-4) var(--sp-2); display:flex; align-items:center; justify-content:space-between;">
      <span class="tma-hint">${sessions.length} sessions (7 days)</span>
      ${button("Refresh", { kind: "secondary", small: true, attrs: `hx-get="/tma/api/logs" hx-target="#log-list" hx-swap="innerHTML"` })}
    </div>
    <div data-tma-filter-scope>
      ${filterChips("source", sourceOptions(sessions), "all")}
      <div style="margin-top:var(--sp-2);">
        ${sessions.map(sessionCard).join("\n")}
      </div>
    </div>`;
}

export function tmaLogsPage(sessions: SessionLog[]): string {
  const body = `
    ${pageHeader("Logs")}
    <div id="log-list">
      ${logListBody(sessions)}
    </div>
  `;
  return miniAppLayout("logs", body);
}

export function tmaLogListFragment(sessions: SessionLog[]): string {
  return logListBody(sessions);
}

export function tmaLogErrorFragment(message: string): string {
  return errorState(message, "/tma/api/logs");
}

export type { SessionLog };
