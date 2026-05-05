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
}
