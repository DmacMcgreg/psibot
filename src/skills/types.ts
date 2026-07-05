/**
 * Skill: a class-level "how to do X" packet of procedural knowledge.
 *
 * On disk: <skillsDir>/<name>/SKILL.md plus optional references/ templates/ scripts/
 * subdirs. SKILL.md has YAML frontmatter (name, description, version, tags,
 * related_skills) and a markdown body. The frontmatter shape mirrors Hermes
 * (and agentskills.io) for future interop.
 *
 * Distinct from:
 *   - knowledge/USER.md, knowledge/IDENTITY.md — static project context
 *   - agents table — declarative subagent personas
 *   - pending_items — capture pipeline
 */

export const SKILL_STATES = ["active", "stale", "archived"] as const;
export type SkillState = typeof SKILL_STATES[number];

/**
 * Exposure tier — same vocabulary as local-mcp-hub (HOT / COLD / HIDDEN).
 * HOT skills are listed by name+description in the system prompt; COLD are
 * searchable via skills_list only. Archived skills are the HIDDEN analog.
 */
export const SKILL_TIERS = ["hot", "cold"] as const;
export type SkillTier = typeof SKILL_TIERS[number];

/**
 * Who caused a usage event. "workflow" is real consumption (foreground agent
 * runs, jobs); "maintenance" is the curator/background-review touching a
 * skill to maintain it; "hub" is cross-harness usage read from the hub's
 * telemetry store. Maintenance events carry ZERO weight in the freshness
 * score — otherwise the maintainer resets the decay clock it enforces.
 */
export type SkillActor = "workflow" | "maintenance" | "hub";

export type SkillEventKind = "use" | "view" | "patch";

export interface SkillEvent {
  kind: SkillEventKind;
  at: string;
  actor: SkillActor;
}

/** Outcome verdicts recorded by the background review after a run that loaded the skill. */
export interface SkillVerdicts {
  helped: number;
  neutral: number;
  misled: number;
}

/** Manifest entry for a skill exported to ~/.claude/skills (the hub seam). */
export interface SkillExportRecord {
  /** Directory name used in ~/.claude/skills (differs from name on collision). */
  as: string;
  exported_at: string;
  /** Freshness score at export time (provenance metadata for the hub). */
  score: number;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  version?: string;
  tags?: string[];
  related_skills?: string[];
}

export interface Skill {
  name: string;
  dir: string;
  frontmatter: SkillFrontmatter;
  body: string;
  references: string[];
  templates: string[];
  scripts: string[];
}

export interface SkillSummary {
  name: string;
  description: string;
  tags: string[];
}

/**
 * Per-skill usage record (one entry per skill in .usage.json).
 * `created_by === "agent"` is the gate: only agent-created skills are eligible
 * for autonomous curator management. User-authored skills are tracked for
 * telemetry but the curator never touches them.
 */
export interface SkillUsageRecord {
  created_by: "agent" | null;
  use_count: number;
  view_count: number;
  patch_count: number;
  last_used_at: string | null;
  last_viewed_at: string | null;
  last_patched_at: string | null;
  created_at: string;
  state: SkillState;
  pinned: boolean;
  archived_at: string | null;
  /**
   * Append-only event log (capped — oldest dropped). Feeds the freshness
   * score. Pre-v2 records have no events; the score falls back to the
   * legacy count+timestamp fields for those.
   */
  events: SkillEvent[];
  /** Outcome verdicts from the background review (helped/neutral/misled). */
  verdicts: SkillVerdicts;
  /**
   * First time this skill was actually surfaced (prompt listing or job
   * injection). Decay/archival idle time anchors here, NOT at created_at —
   * a skill that was never discoverable can't be "unused".
   */
  first_exposed_at: string | null;
  /** Last pinned-skill verification pass (mechanical + LLM checks). */
  last_verified_at: string | null;
  /** Set by the verification pass when a skill's procedure looks out of date. */
  needs_review: boolean;
  /** Current exposure tier (recomputed each curator tick). */
  tier: SkillTier;
  /** Cached freshness score from the last curator tick (for dashboards/reports). */
  score: number;
  /** David approved exporting this skill to ~/.claude/skills. */
  export_approved: boolean;
  /** Present iff currently exported to ~/.claude/skills. */
  exported: SkillExportRecord | null;
}
