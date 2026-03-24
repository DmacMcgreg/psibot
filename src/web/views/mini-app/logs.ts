import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
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

function sourceBadge(source: string): string {
  const colors: Record<string, string> = {
    telegram: "tma-badge-enabled",
    web: "tma-badge-paused",
    "mini-app": "tma-badge-paused",
    job: "tma-badge-disabled",
    heartbeat: "tma-badge-disabled",
  };
  const cls = colors[source] ?? "tma-badge-disabled";
  return `<span class="tma-badge ${cls}">${escapeHtml(source)}</span>`;
}

function shortToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

function shortModel(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model.slice(0, 12);
}

function toolList(tools: ToolUse[]): string {
  if (tools.length === 0) return "";
  const items = tools.map((t) => {
    const name = shortToolName(t.tool_name);
    const sub = t.is_subagent ? ' <span style="color:var(--tg-theme-hint-color,#999);font-size:10px;">(subagent)</span>' : "";
    const detail = t.input_summary
      ? `<div style="color:var(--tg-theme-hint-color,#999);font-size:11px;margin-left:12px;word-break:break-word;">${escapeHtml(t.input_summary)}</div>`
      : "";
    return `<div style="padding:3px 0;border-bottom:1px solid var(--tg-theme-hint-color,#eee)22;">
      <div style="font-size:12px;font-family:monospace;">${escapeHtml(name)}${sub}</div>
      ${detail}
    </div>`;
  });
  return `<details style="margin-top:8px;">
    <summary style="list-style:none;cursor:pointer;font-size:12px;color:var(--tg-theme-link-color,#3390ec);">
      ${tools.length} tool call${tools.length !== 1 ? "s" : ""} &#9660;
    </summary>
    <div style="margin-top:4px;padding:6px 8px;background:var(--tg-theme-bg-color,#fff);border-radius:6px;max-height:250px;overflow-y:auto;">
      ${items.join("\n")}
    </div>
  </details>`;
}

function sessionCard(s: SessionLog): string {
  const sid = s.session_id.slice(0, 8);
  const cost = s.total_cost_usd > 0 ? `$${s.total_cost_usd.toFixed(4)}` : "";
  const time = s.updated_at?.replace("T", " ").slice(0, 16) ?? "";
  const title = s.first_prompt
    ? truncate(s.first_prompt.replace(/\n/g, " "), 60)
    : "(no prompt)";
  const hasTools = s.tools.length > 0;

  return `<details class="tma-card" style="margin:6px 12px;">
    <summary style="list-style:none;cursor:pointer;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;min-width:0;">
          ${sourceBadge(s.source)}
          <span style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(title)}</span>
        </div>
        <span style="font-size:10px;color:var(--tg-theme-hint-color,#999);white-space:nowrap;font-family:monospace;">${sid}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;">
        <span style="font-size:11px;color:var(--tg-theme-hint-color,#999);">${escapeHtml(time)}</span>
        <span style="font-size:11px;color:var(--tg-theme-hint-color,#999);">
          ${[
            cost,
            `${s.message_count} msg`,
            hasTools ? `${s.tools.length} tools` : "",
            shortModel(s.model),
          ].filter(Boolean).join(" | ")}
        </span>
      </div>
    </summary>
    <div style="margin-top:8px;">
      ${toolList(s.tools)}
      ${!hasTools ? `<div class="tma-hint" style="padding:4px 0;">No tool calls recorded</div>` : ""}
    </div>
  </details>`;
}

export function tmaLogsPage(sessions: SessionLog[]): string {
  const content = sessions.length > 0
    ? `<div id="log-list">
        <div style="padding:12px 16px 4px;display:flex;align-items:center;justify-content:space-between;">
          <span class="tma-hint">${sessions.length} sessions (7 days)</span>
          <button class="tma-btn tma-btn-sm tma-btn-secondary"
            hx-get="/tma/api/logs"
            hx-target="#log-list"
            hx-swap="innerHTML">Refresh</button>
        </div>
        ${sessions.map((s) => sessionCard(s)).join("\n")}
      </div>`
    : `<div class="tma-empty">No activity yet</div>`;

  return miniAppLayout("logs", content);
}

export function tmaLogListFragment(sessions: SessionLog[]): string {
  if (sessions.length === 0) return `<div class="tma-empty">No activity yet</div>`;
  return `<div style="padding:12px 16px 4px;display:flex;align-items:center;justify-content:space-between;">
      <span class="tma-hint">${sessions.length} sessions (7 days)</span>
      <button class="tma-btn tma-btn-sm tma-btn-secondary"
        hx-get="/tma/api/logs"
        hx-target="#log-list"
        hx-swap="innerHTML">Refresh</button>
    </div>
    ${sessions.map((s) => sessionCard(s)).join("\n")}`;
}

export type { SessionLog };
