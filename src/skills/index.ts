/**
 * Skill library — read-side operations on disk.
 *
 * Layout:
 *   <skillsDir>/<name>/SKILL.md           (required, YAML frontmatter + body)
 *   <skillsDir>/<name>/references/*.md    (session-specific detail / knowledge banks)
 *   <skillsDir>/<name>/templates/*        (starter files to copy & modify)
 *   <skillsDir>/<name>/scripts/*          (statically re-runnable actions)
 *   <skillsDir>/.archive/<name>/          (curator moves stale skills here; recoverable)
 *   <skillsDir>/.usage.json               (per-skill telemetry sidecar)
 *   <skillsDir>/.curator_state.json       (curator scheduler/status)
 *   <skillsDir>/.snapshots/<ts>/          (pre-curator-run library snapshots)
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../config.ts";
import type { Skill, SkillFrontmatter, SkillSummary } from "./types.ts";

const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export function skillsDir(): string {
  return join(getConfig().PSIBOT_DIR, "skills");
}

export function ensureSkillsDir(): string {
  const dir = skillsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function validateSkillName(name: string): string | null {
  if (!name) return "name is required";
  if (name.length > 64) return "name must be 64 chars or less";
  if (!NAME_RE.test(name)) {
    return "name must be lowercase letters/digits with single hyphens (e.g. trading-playbook)";
  }
  if (name.startsWith(".") || name.includes("..") || name.includes("/")) {
    return "name must not contain '.' '..' or '/'";
  }
  return null;
}

export function resolveSkillDir(name: string): string {
  return join(skillsDir(), name);
}

/**
 * Parse YAML frontmatter from a SKILL.md.
 * We accept only the subset of YAML the frontmatter shape actually uses —
 * scalar strings, top-level keys, and `tags: [a, b, c]` flow lists. Nested
 * `metadata.hermes.tags` style is supported for Hermes interop. Anything else
 * is ignored, not errored — keeps us tolerant of skills written by future tools.
 */
export function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!content.startsWith("---\n")) {
    return { frontmatter: { name: "", description: "" }, body: content };
  }
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: { name: "", description: "" }, body: content };
  const yaml = content.slice(4, end);
  const body = content.slice(end + 5);

  const fm: SkillFrontmatter = { name: "", description: "" };
  const lines = yaml.split("\n");
  let inHermesMetadata = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;

    // Detect nested hermes tags block. Cheap heuristic — the only nested
    // shape we actually read.
    if (/^metadata:\s*$/.test(line)) {
      inHermesMetadata = true;
      continue;
    }
    if (inHermesMetadata && /^\s+hermes:\s*$/.test(line)) continue;
    if (inHermesMetadata && /^\s+tags:\s*\[/.test(line)) {
      fm.tags = parseFlowList(line.slice(line.indexOf("[")));
      continue;
    }
    if (inHermesMetadata && /^\s+related_skills:\s*\[/.test(line)) {
      fm.related_skills = parseFlowList(line.slice(line.indexOf("[")));
      continue;
    }
    if (inHermesMetadata && /^\S/.test(line)) inHermesMetadata = false;

    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    if (key === "name") fm.name = stripQuotes(value);
    else if (key === "description") fm.description = stripQuotes(value);
    else if (key === "version") fm.version = stripQuotes(value);
    else if (key === "tags" && value.startsWith("[")) fm.tags = parseFlowList(value);
    else if (key === "related_skills" && value.startsWith("[")) {
      fm.related_skills = parseFlowList(value);
    }
  }
  return { frontmatter: fm, body };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFlowList(s: string): string[] {
  // [a, b, c] or ["a", "b"]
  const inner = s.replace(/^\[|\]\s*$/g, "");
  if (!inner.trim()) return [];
  return inner
    .split(",")
    .map((x) => stripQuotes(x.trim()))
    .filter((x) => x.length > 0);
}

export function buildFrontmatter(fm: SkillFrontmatter): string {
  const lines = ["---", `name: ${fm.name}`, `description: ${quote(fm.description)}`];
  if (fm.version) lines.push(`version: ${fm.version}`);
  if (fm.tags && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map((t) => quote(t)).join(", ")}]`);
  }
  if (fm.related_skills && fm.related_skills.length > 0) {
    lines.push(`related_skills: [${fm.related_skills.map((t) => quote(t)).join(", ")}]`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function quote(s: string): string {
  if (/^[a-zA-Z0-9_-]+$/.test(s) && !s.includes(" ")) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

export function readSkill(name: string): Skill | null {
  const err = validateSkillName(name);
  if (err) return null;
  const dir = resolveSkillDir(name);
  const skillPath = join(dir, "SKILL.md");
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    name,
    dir,
    frontmatter,
    body,
    references: listFiles(join(dir, "references")),
    templates: listFiles(join(dir, "templates")),
    scripts: listFiles(join(dir, "scripts")),
  };
}

/**
 * List all installed skills (excluding archived / hidden). Reads every
 * SKILL.md to pull frontmatter — fine for dozens of skills, would need an
 * index if it grew to thousands.
 */
export function listSkills(): SkillSummary[] {
  const dir = ensureSkillsDir();
  if (!existsSync(dir)) return [];
  const out: SkillSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skill = readSkill(entry.name);
    if (!skill) continue;
    out.push({
      name: skill.frontmatter.name || skill.name,
      description: skill.frontmatter.description ?? "",
      tags: skill.frontmatter.tags ?? [],
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function skillExists(name: string): boolean {
  if (validateSkillName(name)) return false;
  return existsSync(join(resolveSkillDir(name), "SKILL.md"));
}

export function isAgentCreated(_name: string): boolean {
  // Wired in usage.ts to avoid a circular import. Re-exported here for
  // documentation; consumers should import from ./usage.
  throw new Error("import isAgentCreated from src/skills/usage.ts instead");
}

export function archiveDir(): string {
  return join(skillsDir(), ".archive");
}

export function snapshotsDir(): string {
  return join(skillsDir(), ".snapshots");
}

export function isReadableDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
