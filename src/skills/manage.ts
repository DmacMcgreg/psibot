/**
 * Skill mutations — create / edit / patch / delete + support files.
 *
 * Two safety rules baked in:
 *   1. Never delete from disk; archive moves to `<skillsDir>/.archive/<name>/`.
 *      Curator runs are recoverable.
 *   2. `delete` requires `absorbed_into` (string, possibly empty). When the
 *      curator merges X into umbrella Y, `absorbed_into="Y"` records the
 *      forwarding pointer in the usage record so any cron-job pinned to X
 *      can be migrated. Empty string = true pruning. This is the same
 *      contract Hermes uses to drive cron-job skill-reference migration.
 *
 * Only `skill_manage create` reads the provenance context — when it sees
 * BACKGROUND_REVIEW, it calls markAgentCreated. That's the curator-eligibility
 * gate. Edit/patch/write_file/delete don't change `created_by`; if you didn't
 * create it, you can't make it agent-created.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createLogger } from "../shared/logger.ts";
import {
  ensureSkillsDir,
  resolveSkillDir,
  validateSkillName,
  parseFrontmatter,
  buildFrontmatter,
  archiveDir,
  readSkill,
} from "./index.ts";
import { bumpPatch, markAgentCreated, setState, setPinned, forget } from "./usage.ts";
import { isBackgroundReview } from "./provenance.ts";
import type { SkillFrontmatter } from "./types.ts";

const log = createLogger("skills.manage");

const ALLOWED_SUPPORT_DIRS = new Set(["references", "templates", "scripts"]);

export interface ManageResult {
  success: boolean;
  message: string;
  target?: string;
  path?: string;
}

function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, { encoding: "utf-8" });
  renameSync(tmp, filePath);
}

function validateContentSize(content: string, label: string): string | null {
  // Hermes uses 256 KB; we match. A skill that needs more belongs split into
  // umbrella + references/ files anyway.
  const MAX = 256 * 1024;
  if (Buffer.byteLength(content, "utf-8") > MAX) {
    return `${label} exceeds ${MAX} bytes — split into references/ files`;
  }
  return null;
}

function validateFrontmatter(content: string): string | null {
  const { frontmatter } = parseFrontmatter(content);
  if (!frontmatter.name) return "frontmatter missing required `name`";
  if (!frontmatter.description) return "frontmatter missing required `description`";
  return null;
}

function validateSupportPath(filePath: string): { dir: string; rel: string } | string {
  // Accept "references/foo.md", "templates/foo.json", "scripts/foo.sh".
  // Reject path traversal and any other top-level dirs.
  if (!filePath || filePath.includes("..") || filePath.startsWith("/")) {
    return "file_path must be relative and not contain '..'";
  }
  const parts = filePath.split("/");
  if (parts.length < 2) return "file_path must include a directory (references/templates/scripts)";
  const dir = parts[0];
  if (!ALLOWED_SUPPORT_DIRS.has(dir)) {
    return `file_path must start with one of: ${Array.from(ALLOWED_SUPPORT_DIRS).join(", ")}`;
  }
  // Reject hidden/empty path segments
  for (const p of parts) {
    if (!p || p.startsWith(".")) return "file_path segments must not be empty or start with '.'";
  }
  return { dir, rel: filePath };
}

/**
 * Create a new skill. Sets `created_by="agent"` in usage iff the call is
 * inside the background-review context.
 */
export function createSkill(args: {
  name: string;
  content: string;
  frontmatter?: Partial<SkillFrontmatter>;
}): ManageResult {
  const err = validateSkillName(args.name) ?? validateContentSize(args.content, "SKILL.md");
  if (err) return { success: false, message: err };

  const dir = resolveSkillDir(args.name);
  if (existsSync(join(dir, "SKILL.md"))) {
    return { success: false, message: `skill '${args.name}' already exists` };
  }

  // If the caller's content already has frontmatter, validate it. Otherwise
  // synthesize one from `args.frontmatter` so the model can hand us bare
  // markdown plus a description.
  let final = args.content;
  if (!final.startsWith("---\n")) {
    const fm: SkillFrontmatter = {
      name: args.name,
      description: args.frontmatter?.description ?? "",
      version: args.frontmatter?.version ?? "1.0.0",
      tags: args.frontmatter?.tags,
      related_skills: args.frontmatter?.related_skills,
    };
    if (!fm.description) {
      return { success: false, message: "either embed YAML frontmatter or pass `description`" };
    }
    final = `${buildFrontmatter(fm)}${args.content.startsWith("\n") ? "" : "\n"}${args.content}`;
  } else {
    const fmErr = validateFrontmatter(final);
    if (fmErr) return { success: false, message: fmErr };
  }

  ensureSkillsDir();
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, "SKILL.md"), final.endsWith("\n") ? final : `${final}\n`);

  if (isBackgroundReview()) {
    markAgentCreated(args.name);
    log.info("Skill created (agent-created)", { name: args.name });
  } else {
    log.info("Skill created (foreground)", { name: args.name });
  }

  return {
    success: true,
    message: `created skill '${args.name}'`,
    target: args.name,
    path: join(dir, "SKILL.md"),
  };
}

/** Full-content rewrite of SKILL.md. */
export function editSkill(args: { name: string; content: string }): ManageResult {
  const err = validateSkillName(args.name) ?? validateContentSize(args.content, "SKILL.md");
  if (err) return { success: false, message: err };
  const skillPath = join(resolveSkillDir(args.name), "SKILL.md");
  if (!existsSync(skillPath)) return { success: false, message: `skill '${args.name}' not found` };

  const fmErr = validateFrontmatter(args.content);
  if (fmErr) return { success: false, message: fmErr };

  atomicWrite(skillPath, args.content.endsWith("\n") ? args.content : `${args.content}\n`);
  bumpPatch(args.name);
  log.info("Skill edited", { name: args.name });
  return { success: true, message: `edited skill '${args.name}'`, target: args.name, path: skillPath };
}

/** Append a section to SKILL.md (preserves the rest of the file). */
export function patchSkill(args: { name: string; section_heading: string; section_body: string }): ManageResult {
  const err = validateSkillName(args.name);
  if (err) return { success: false, message: err };
  if (!args.section_heading.trim()) return { success: false, message: "section_heading is required" };

  const skill = readSkill(args.name);
  if (!skill) return { success: false, message: `skill '${args.name}' not found` };

  const heading = args.section_heading.startsWith("#")
    ? args.section_heading.trim()
    : `## ${args.section_heading.trim()}`;
  const body = args.section_body.endsWith("\n") ? args.section_body : `${args.section_body}\n`;

  const fmText = buildFrontmatter(skill.frontmatter);
  const newBody = `${skill.body.replace(/\s+$/, "")}\n\n${heading}\n\n${body}`;
  const final = `${fmText}${newBody}`;

  const sizeErr = validateContentSize(final, "SKILL.md");
  if (sizeErr) return { success: false, message: sizeErr };

  atomicWrite(join(skill.dir, "SKILL.md"), final);
  bumpPatch(args.name);
  log.info("Skill patched", { name: args.name, section: heading });
  return { success: true, message: `added section "${heading}" to '${args.name}'`, target: args.name };
}

export function writeSupportFile(args: {
  name: string;
  file_path: string;
  file_content: string;
}): ManageResult {
  const err = validateSkillName(args.name) ?? validateContentSize(args.file_content, args.file_path);
  if (err) return { success: false, message: err };

  const v = validateSupportPath(args.file_path);
  if (typeof v === "string") return { success: false, message: v };

  const skillDir = resolveSkillDir(args.name);
  if (!existsSync(join(skillDir, "SKILL.md"))) {
    return { success: false, message: `skill '${args.name}' must exist before adding support files` };
  }
  const target = join(skillDir, v.rel);
  atomicWrite(target, args.file_content.endsWith("\n") ? args.file_content : `${args.file_content}\n`);
  bumpPatch(args.name);
  log.info("Skill support file written", { name: args.name, file: v.rel });
  return {
    success: true,
    message: `wrote ${v.rel} for '${args.name}'`,
    target: args.name,
    path: target,
  };
}

export function removeSupportFile(args: { name: string; file_path: string }): ManageResult {
  const err = validateSkillName(args.name);
  if (err) return { success: false, message: err };

  const v = validateSupportPath(args.file_path);
  if (typeof v === "string") return { success: false, message: v };

  const target = join(resolveSkillDir(args.name), v.rel);
  if (!existsSync(target)) return { success: false, message: `${v.rel} does not exist` };
  rmSync(target, { force: true });
  bumpPatch(args.name);
  log.info("Skill support file removed", { name: args.name, file: v.rel });
  return { success: true, message: `removed ${v.rel} from '${args.name}'`, target: args.name };
}

/**
 * Archive a skill. Moves the directory to `.archive/<name>-<ts>/` (timestamp
 * suffix lets us re-archive a name we already archived). Records absorbed_into
 * in the usage record so cron-job skill references can be migrated downstream.
 *
 * `absorbed_into` semantics — required field, may be empty string:
 *   - "umbrella-name" → this skill was merged into the umbrella; cron jobs
 *     pinned to this name should switch to the umbrella.
 *   - "" → true pruning, no forwarding target. Skill was stale or obsolete.
 */
export function deleteSkill(args: { name: string; absorbed_into: string }): ManageResult {
  const err = validateSkillName(args.name);
  if (err) return { success: false, message: err };
  if (args.absorbed_into === undefined || args.absorbed_into === null) {
    return {
      success: false,
      message: "absorbed_into is required (pass empty string for true pruning)",
    };
  }

  const dir = resolveSkillDir(args.name);
  if (!existsSync(dir)) return { success: false, message: `skill '${args.name}' not found` };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(archiveDir(), `${args.name}-${ts}`);
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(dir, dest);
  setState(args.name, "archived");

  // Persist absorbed_into in the usage record. Stash it under a non-standard
  // key the curator can pick up on its next pass.
  try {
    const usagePath = join(ensureSkillsDir(), ".usage.json");
    if (existsSync(usagePath)) {
      const data = JSON.parse(readFileSync(usagePath, "utf-8")) as Record<string, Record<string, unknown>>;
      if (data[args.name] && typeof data[args.name] === "object") {
        data[args.name].absorbed_into = args.absorbed_into;
        const tmp = `${usagePath}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameSync(tmp, usagePath);
      }
    }
  } catch (e) {
    log.warn("Failed to record absorbed_into", { name: args.name, error: String(e) });
  }

  log.info("Skill archived", {
    name: args.name,
    dest,
    absorbed_into: args.absorbed_into || "(pruned)",
  });
  return {
    success: true,
    message: args.absorbed_into
      ? `archived '${args.name}' (absorbed into ${args.absorbed_into})`
      : `archived '${args.name}' (pruned)`,
    target: args.name,
    path: dest,
  };
}

/** Pin/unpin. Pinned skills bypass curator auto-transitions. */
export function setPinnedFlag(args: { name: string; pinned: boolean }): ManageResult {
  const err = validateSkillName(args.name);
  if (err) return { success: false, message: err };
  if (!existsSync(join(resolveSkillDir(args.name), "SKILL.md"))) {
    return { success: false, message: `skill '${args.name}' not found` };
  }
  setPinned(args.name, args.pinned);
  log.info("Skill pinned flag", { name: args.name, pinned: args.pinned });
  return {
    success: true,
    message: `${args.pinned ? "pinned" : "unpinned"} '${args.name}'`,
    target: args.name,
  };
}

/** Hard-delete from disk + sidecar. Should NEVER be called by the curator. */
export function purgeArchive(name: string): ManageResult {
  const err = validateSkillName(name);
  if (err) return { success: false, message: err };
  // Find latest archive entry for this name
  const ad = archiveDir();
  if (!existsSync(ad)) return { success: false, message: "no archive yet" };
  // Best-effort: callers should pass exact dir if they care.
  forget(name);
  return { success: true, message: `purged '${name}' from sidecar (archive on disk untouched)` };
}
