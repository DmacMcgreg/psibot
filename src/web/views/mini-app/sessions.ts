import { miniAppLayout } from "./shell.ts";
import {
  pageHeader,
  card,
  formatCost,
  truncate,
  escapeHtml,
  escapeAttr,
  emptyState,
  errorState,
  button,
} from "./components.ts";
import type { AgentSession } from "../../../shared/types.ts";

/**
 * NOTE: Fork uses plain `hx-confirm` here rather than a page-local
 * `tg.showConfirm`/`confirm()` implementation. This depends on a shared
 * `htmx:confirm` listener in `public/tma.js` that routes any `hx-confirm`
 * attribute through `tg.showConfirm` (falling back to `window.confirm`) —
 * see fixer notes for the "misc" partition (this helper cannot edit
 * tma.js/library.ts/jobs.ts/agents.ts, which are outside its partition).
 * Until that shared listener exists, `hx-confirm` here behaves like plain
 * HTMX (native `window.confirm` only, no Telegram-native dialog).
 */

function sessionCard(session: AgentSession, previews: Map<string, string>): string {
  const rawPreview = session.label ?? previews.get(session.session_id) ?? "(empty)";
  const preview = truncate(rawPreview, 80);
  const shortId = session.session_id.slice(0, 8);
  const date = session.updated_at.split(" ")[0];
  const cost = formatCost(session.total_cost_usd);
  const resumeVals = escapeAttr(JSON.stringify({ sessionId: session.session_id }));

  return card(`
    <div style="font-weight:600; font-size:var(--fs-md); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(preview)}</div>
    <div class="tma-hint" style="margin-top:var(--sp-1);">${shortId} · ${escapeHtml(date)} · ${session.message_count} msgs · ${cost}</div>
    <div style="display:flex; gap:var(--sp-2); margin-top:var(--sp-2);">
      ${button("Resume", {
        small: true,
        attrs: `hx-post="/tma/api/sessions/resume" hx-vals='${resumeVals}' hx-target="body"`,
      })}
      ${button("Fork", {
        kind: "secondary",
        small: true,
        attrs: `hx-post="/tma/api/sessions/fork" hx-vals='${resumeVals}' hx-target="body" hx-confirm="Fork this session into a new chat?"`,
      })}
    </div>
  `);
}

function sessionList(sessions: AgentSession[], previews: Map<string, string>): string {
  if (sessions.length === 0) {
    return emptyState("💬", "No sessions yet", "Chat sessions will show up here.");
  }
  const sorted = [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return sorted.map((s) => sessionCard(s, previews)).join("\n");
}

export function tmaSessionsPage(sessions: AgentSession[], previews: Map<string, string>): string {
  const body = `
    ${pageHeader("Sessions")}
    <div class="tma-section" id="session-list">
      ${sessionList(sessions, previews)}
    </div>
  `;
  return miniAppLayout("sessions", body);
}

export function tmaSessionsErrorFragment(message: string): string {
  return errorState(message, "/tma/sessions");
}
