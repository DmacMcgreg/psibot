import { miniAppLayout } from "./shell.ts";
import {
  pageHeader,
  card,
  badge,
  section,
  emptyState,
  errorState,
  escapeHtml,
  escapeAttr,
  button,
  type BadgeKind,
} from "./components.ts";
import type { Skill, SkillSummary, SkillUsageRecord } from "../../../skills/types.ts";

export interface SkillsPageData {
  skills: Array<{
    summary: SkillSummary;
    record: SkillUsageRecord;
  }>;
  curator: CuratorPageData;
}

export interface CuratorPageData {
  enabled: boolean;
  paused: boolean;
  intervalHours: number;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  lastReportPath: string | null;
  lastRunDurationMs: number | null;
  runCount: number;
  agentCreatedCount: number;
  totalCount: number;
}

const STATE_BADGE: Record<string, BadgeKind> = {
  active: "ok",
  stale: "warn",
  inactive: "muted",
};

const STATE_ORDER: Record<string, number> = {
  active: 0,
  stale: 1,
  inactive: 2,
};

function curatorPanel(c: CuratorPageData): string {
  const statusBadge = !c.enabled
    ? badge("disabled", "muted")
    : c.paused
      ? badge("paused", "warn")
      : badge("active", "ok");
  const last = c.lastRunAt
    ? `<div class="tma-hint">last run: ${escapeHtml(c.lastRunAt)} · ${escapeHtml(c.lastRunSummary ?? "")}</div>`
    : `<div class="tma-hint">never run · first pass deferred until ${c.intervalHours}h after seed</div>`;
  const reportLink = c.lastReportPath
    ? `<div class="tma-hint">report: <code class="tma-mono">${escapeHtml(c.lastReportPath)}</code></div>`
    : "";
  const duration = c.lastRunDurationMs ? ` · ${(c.lastRunDurationMs / 1000).toFixed(1)}s` : "";

  return card(`
    <div style="display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-1); flex-wrap:wrap;">
      <strong style="font-size:var(--fs-sm);">Curator</strong>
      ${statusBadge}
      <span class="tma-hint">interval ${c.intervalHours}h · ${c.runCount} runs${duration}</span>
    </div>
    ${last}
    ${reportLink}
  `);
}

function skillCard(summary: SkillSummary, record: SkillUsageRecord): string {
  const stateBadge = badge(record.state, STATE_BADGE[record.state] ?? "muted");
  const provenance = record.created_by === "agent" ? badge("agent", "accent") : badge("user", "muted");
  const pinned = record.pinned ? " 📌" : "";
  const last = record.last_used_at ?? record.last_patched_at ?? record.last_viewed_at ?? "never";
  const tags = summary.tags.length > 0
    ? `<div style="margin-top:var(--sp-1); display:flex; flex-wrap:wrap; gap:var(--sp-1);">${summary.tags
        .map((t) => badge(t, "muted"))
        .join("")}</div>`
    : "";

  return card(
    `<a href="/tma/skills/${encodeURIComponent(summary.name)}" style="display:block; color:inherit; text-decoration:none;">
      <div style="display:flex; align-items:center; gap:var(--sp-2);">
        <strong style="font-size:var(--fs-sm); flex:1;">${escapeHtml(summary.name)}${pinned}</strong>
        ${stateBadge}
        ${provenance}
      </div>
      <div style="margin-top:var(--sp-1); font-size:var(--fs-sm); line-height:1.4;">${escapeHtml(summary.description)}</div>
      ${tags}
      <div class="tma-hint" style="margin-top:var(--sp-2);">
        use=${record.use_count} · view=${record.view_count} · patch=${record.patch_count} · last=${escapeHtml(String(last))}
      </div>
    </a>`,
  );
}

export function tmaSkillsPage(data: SkillsPageData): string {
  const { curator } = data;
  const sorted = [...data.skills].sort((a, b) => {
    const orderDiff = (STATE_ORDER[a.record.state] ?? 99) - (STATE_ORDER[b.record.state] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    return a.summary.name.localeCompare(b.summary.name);
  });
  const cards = sorted.length > 0
    ? sorted.map((s) => skillCard(s.summary, s.record)).join("\n")
    : emptyState("🧩", "No skills yet", "The background self-improvement review will create them as conversations produce signal.");

  const body = `
    ${pageHeader("Skills")}
    <div style="padding:0 var(--sp-4);">
      ${curatorPanel(curator)}
      <div class="tma-hint" style="margin-top:var(--sp-2);">
        ${data.skills.length} installed · ${curator.agentCreatedCount} agent-created (curator-eligible) · ${data.skills.length - curator.agentCreatedCount} user-authored
      </div>
    </div>
    ${section("All skills", cards)}
  `;
  return miniAppLayout("skills", body);
}

export function tmaSkillsErrorFragment(message: string): string {
  return errorState(message, "/tma/skills");
}

export function tmaSkillDetailPage(skill: Skill, record: SkillUsageRecord): string {
  const supportFiles: string[] = [];
  if (skill.references.length > 0) {
    supportFiles.push(`<strong>references/</strong>`, ...skill.references.map((f) => `<div>${escapeHtml(f)}</div>`));
  }
  if (skill.templates.length > 0) {
    supportFiles.push(`<strong>templates/</strong>`, ...skill.templates.map((f) => `<div>${escapeHtml(f)}</div>`));
  }
  if (skill.scripts.length > 0) {
    supportFiles.push(`<strong>scripts/</strong>`, ...skill.scripts.map((f) => `<div>${escapeHtml(f)}</div>`));
  }
  const supportBlock = supportFiles.length > 0 ? card(supportFiles.join("")) : "";
  const stateBadge = badge(record.state, STATE_BADGE[record.state] ?? "muted");
  const provenance = record.created_by === "agent" ? badge("agent-created", "accent") : badge("user-authored", "muted");

  const body = `
    ${pageHeader(skill.frontmatter.name, { subtitle: skill.frontmatter.description })}
    <div style="padding:0 var(--sp-4);">
      <div style="display:flex; gap:var(--sp-2); align-items:center; flex-wrap:wrap;">
        ${stateBadge}
        ${provenance}
        <span class="tma-hint">use=${record.use_count} · view=${record.view_count} · patch=${record.patch_count}</span>
      </div>
    </div>
    <div style="padding:var(--sp-2) var(--sp-4);" data-md-toggle-root>
      ${card(`
        <div style="display:flex; gap:var(--sp-2); margin-bottom:var(--sp-2);">
          ${button("Raw", { small: true, attrs: `onclick="window.toggleMdView(this);"` })}
        </div>
        <div class="md-rendered tma-md" data-md data-md-src="${escapeAttr(skill.body)}"></div>
        <pre class="md-raw tma-mono" style="display:none; white-space:pre-wrap; word-break:break-word;">${escapeHtml(skill.body)}</pre>
      `)}
    </div>
    ${supportBlock ? `<div style="padding:0 var(--sp-4) var(--sp-4);">${supportBlock}</div>` : ""}
  `;
  return miniAppLayout("skills", body, false);
}
