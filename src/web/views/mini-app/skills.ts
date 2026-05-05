import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
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

export function tmaSkillsPage(data: SkillsPageData): string {
  const { curator } = data;
  const cards = data.skills.length > 0
    ? data.skills.map((s) => tmaSkillCard(s.summary, s.record)).join("\n")
    : `<div class="tma-empty">No skills yet. The background self-improvement review will create them as conversations produce signal.</div>`;

  return miniAppLayout("skills", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:8px;">Skills</h2>
        ${tmaCuratorPanel(curator)}
        <div class="tma-hint" style="margin-top:8px; font-size:12px;">
          ${data.skills.length} installed · ${curator.agentCreatedCount} agent-created (curator-eligible) · ${data.skills.length - curator.agentCreatedCount} user-authored
        </div>
      </div>
      <div id="skills-list">
        ${cards}
      </div>
    </div>
  `);
}

function tmaCuratorPanel(c: CuratorPageData): string {
  const status = !c.enabled
    ? `<span style="color:#9ca3af;">disabled</span>`
    : c.paused
      ? `<span style="color:#f59e0b;">paused</span>`
      : `<span style="color:#10b981;">active</span>`;
  const last = c.lastRunAt
    ? `<div class="tma-hint" style="font-size:12px;">last run: ${escapeHtml(c.lastRunAt)} · ${escapeHtml(c.lastRunSummary ?? "")}</div>`
    : `<div class="tma-hint" style="font-size:12px;">never run · first pass deferred until ${c.intervalHours}h after seed</div>`;
  const reportLink = c.lastReportPath
    ? `<div class="tma-hint" style="font-size:11px; margin-top:2px;">report: <code>${escapeHtml(c.lastReportPath)}</code></div>`
    : "";
  const duration = c.lastRunDurationMs
    ? ` · ${(c.lastRunDurationMs / 1000).toFixed(1)}s`
    : "";

  return `<div class="tma-card" style="margin:8px 0; padding:10px;">
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
      <strong style="font-size:13px;">Curator</strong>
      ${status}
      <span class="tma-hint" style="font-size:11px;">interval ${c.intervalHours}h · ${c.runCount} runs${duration}</span>
    </div>
    ${last}
    ${reportLink}
  </div>`;
}

function tmaSkillCard(summary: SkillSummary, record: SkillUsageRecord): string {
  const stateColor =
    record.state === "active" ? "#10b981" :
    record.state === "stale" ? "#f59e0b" :
    "#9ca3af";
  const provenance = record.created_by === "agent" ? "agent" : "user";
  const provenanceColor = record.created_by === "agent" ? "#8b5cf6" : "#6b7280";
  const pinned = record.pinned ? `<span style="color:#3b82f6;">📌</span>` : "";
  const last = record.last_used_at ?? record.last_patched_at ?? record.last_viewed_at ?? "never";
  const tags = summary.tags.length > 0
    ? `<div style="margin-top:4px;">${summary.tags.map((t) => `<span class="tma-hint" style="font-size:10px; background:rgba(0,0,0,0.06); padding:1px 6px; border-radius:4px; margin-right:3px;">${escapeHtml(t)}</span>`).join("")}</div>`
    : "";

  return `<div class="tma-card" style="padding:10px; margin:6px 12px;">
    <div style="display:flex; align-items:center; gap:6px;">
      <strong style="font-size:13px; flex:1;">${escapeHtml(summary.name)}</strong>
      ${pinned}
      <span style="color:${stateColor}; font-size:11px; font-weight:500;">${escapeHtml(record.state)}</span>
      <span style="color:${provenanceColor}; font-size:11px;">${provenance}</span>
    </div>
    <div style="margin-top:4px; font-size:12px; line-height:1.4;">${escapeHtml(summary.description)}</div>
    ${tags}
    <div class="tma-hint" style="margin-top:6px; font-size:11px;">
      use=${record.use_count} · view=${record.view_count} · patch=${record.patch_count} · last=${escapeHtml(last)}
    </div>
  </div>`;
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
  const supportBlock = supportFiles.length > 0
    ? `<div class="tma-card" style="margin-top:12px; padding:10px; font-size:12px;">${supportFiles.join("")}</div>`
    : "";

  return miniAppLayout("skills", `
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <a href="/tma/skills" class="tma-hint" style="font-size:12px;">← back to skills</a>
        <h2 style="font-size:18px; font-weight:600; margin:6px 0 8px;">${escapeHtml(skill.frontmatter.name)}</h2>
        <div class="tma-hint" style="font-size:12px;">${escapeHtml(skill.frontmatter.description)}</div>
        <div class="tma-hint" style="margin-top:8px; font-size:11px;">
          state=${escapeHtml(record.state)} ·
          ${record.created_by === "agent" ? "agent-created" : "user-authored"} ·
          use=${record.use_count} · view=${record.view_count} · patch=${record.patch_count}
        </div>
      </div>
      <div class="tma-card" style="margin:8px 12px; padding:12px;" data-md-toggle-root>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
          <button type="button" class="tma-btn" style="font-size:12px; padding:4px 10px;"
            onclick="window.toggleMdView(this);">Raw</button>
        </div>
        <div class="md-rendered" data-md data-md-src="${escapeHtml(skill.body)}" style="font-size:13px; line-height:1.5;"></div>
        <pre class="md-raw" style="display:none; font-size:12px; white-space:pre-wrap; word-break:break-word; background:var(--tg-theme-bg-color, #0f0f0f); color:var(--tg-theme-text-color, #fafafa); padding:10px; border-radius:6px; margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;">${escapeHtml(skill.body)}</pre>
      </div>
      ${supportBlock}
    </div>
  `);
}
