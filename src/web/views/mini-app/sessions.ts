import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import { formatCost } from "../../../telegram/format.ts";
import { getSessionPreview } from "../../../db/queries.ts";
import type { AgentSession } from "../../../shared/types.ts";

export function tmaSessionsPage(sessions: AgentSession[]): string {
  const sessionList = sessions.length > 0
    ? sessions.map((s) => tmaSessionCard(s)).join("\n")
    : `<div class="tma-empty">No sessions yet</div>`;

  return miniAppLayout("sessions", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px; display:flex; justify-content:space-between; align-items:center;">
        <h2 style="font-size:18px; font-weight:600;">Sessions</h2>
      </div>
      <div id="session-list">
        ${sessionList}
      </div>
    </div>
  `);
}

function tmaSessionCard(session: AgentSession): string {
  const preview = session.label ?? getSessionPreview(session.session_id) ?? "(empty)";
  const shortId = session.session_id.slice(0, 8);
  const date = session.updated_at.split(" ")[0];
  const cost = formatCost(session.total_cost_usd);

  return `<div class="tma-card">
    <div style="font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(preview)}</div>
    <div class="tma-hint" style="margin-top:2px;">${shortId} | ${date} | ${session.message_count} msgs | ${cost}</div>
    <div style="display:flex; gap:6px; margin-top:8px;">
      <button class="tma-btn tma-btn-sm" hx-post="/tma/api/sessions/resume" hx-vals='{"sessionId":"${session.session_id}"}' hx-target="body">Resume</button>
      <button class="tma-btn tma-btn-sm tma-btn-secondary" hx-post="/tma/api/sessions/fork" hx-vals='{"sessionId":"${session.session_id}"}' hx-target="body">Fork</button>
    </div>
  </div>`;
}
