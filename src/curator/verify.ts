/**
 * Pinned-skill verification — the maintenance contract.
 *
 * Pinned means "keep forever even if rarely used" — kept AND kept true.
 * Instead of decaying, pinned skills get a periodic verification pass:
 *
 *   Mechanical (this module, every curator tick, staggered):
 *     - Do absolute / ~ paths referenced in SKILL.md still exist?
 *     - Do commands the skill invokes still resolve on PATH?
 *     Failures set `needs_review: true` in the sidecar and surface in the
 *     curator report; passes stamp `last_verified_at`.
 *
 *   LLM ("does this procedure still match reality?"): the curator's Phase B
 *   prompt receives the mechanical findings for any skill flagged here and
 *   is instructed to patch or confirm.
 *
 * Staggered: at most MAX_PER_RUN skills per pass, oldest verification first,
 * and only when last_verified_at is older than VERIFY_INTERVAL_DAYS.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSkill } from "../skills/index.ts";
import { allSkillsReport, markVerified, setNeedsReview } from "../skills/usage.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("curator.verify");

const VERIFY_INTERVAL_DAYS = 30;
const MAX_PER_RUN = 2;

export interface VerifyFinding {
  name: string;
  ok: boolean;
  missingPaths: string[];
  missingCommands: string[];
}

/** Absolute or ~-anchored paths. Trailing punctuation trimmed. */
const PATH_RE = /(?:^|[\s`'"(])((?:~|\/(?:Users|opt|usr|etc|Applications|Library|private|Volumes))\/[\w@.+~/-]+)/g;

/**
 * First word of command-looking fenced lines. Restricted to lines with an
 * explicit `$ ` prompt or a fence's first line — error strings and output
 * samples inside fences (e.g. `invalid_grant ...`) must not count.
 */
const COMMAND_RE = /^([a-z][a-z0-9_-]{2,})\s/;

/** Commands too generic to be a useful existence signal. */
const COMMAND_IGNORE = new Set([
  "the", "then", "this", "that", "use", "run", "set", "get", "add", "see",
  "cd", "echo", "cat", "grep", "sed", "awk", "curl", "git", "ls", "rm",
  "mkdir", "mv", "cp", "for", "while", "if", "else", "fi", "done", "export",
  "sudo", "ssh", "note", "with", "and", "when", "where", "python", "python3",
]);

function extractPaths(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(PATH_RE)) {
    const p = m[1].replace(/[).,:;'"`]+$/, "");
    // Skip obvious placeholders.
    if (p.includes("<") || p.includes("${") || p.includes("*")) continue;
    out.add(p);
  }
  return [...out];
}

function extractCommands(body: string): string[] {
  const out = new Set<string>();
  // Only shell-tagged fences — untagged fences are usually output samples.
  const fences = body.match(/```(?:bash|sh|zsh|shell)\n[\s\S]*?```/g) ?? [];
  for (const fence of fences) {
    const lines = fence.split("\n").slice(1, -1);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Command-looking: explicit `$ ` prompt, or the fence's first line.
      const candidate = line.startsWith("$ ") ? line.slice(2) : i === 0 ? line : null;
      if (!candidate) continue;
      const m = COMMAND_RE.exec(candidate.trimStart());
      if (m && !COMMAND_IGNORE.has(m[1])) out.add(m[1]);
    }
  }
  return [...out];
}

function commandExists(cmd: string): boolean {
  try {
    const result = Bun.spawnSync(["which", cmd], { stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/** Mechanically verify one skill. Pure-ish (reads disk, no sidecar writes). */
export function verifySkill(name: string): VerifyFinding {
  const skill = readSkill(name);
  if (!skill) return { name, ok: false, missingPaths: ["(SKILL.md missing)"], missingCommands: [] };

  const missingPaths = extractPaths(skill.body).filter((p) => !existsSync(expandHome(p)));
  const missingCommands = extractCommands(skill.body).filter((c) => !commandExists(c));
  return { name, ok: missingPaths.length === 0 && missingCommands.length === 0, missingPaths, missingCommands };
}

/**
 * Run the staggered verification pass over due pinned skills. Updates the
 * sidecar (last_verified_at / needs_review) and returns findings for the
 * curator report + Phase B prompt. Never raises.
 */
export function runVerificationPass(now: Date = new Date()): VerifyFinding[] {
  const findings: VerifyFinding[] = [];
  try {
    const intervalMs = VERIFY_INTERVAL_DAYS * 24 * 3600 * 1000;
    const due = allSkillsReport()
      .filter(({ record }) => record.pinned)
      .filter(({ record }) => {
        if (!record.last_verified_at) return true;
        const t = Date.parse(record.last_verified_at);
        return isNaN(t) || now.getTime() - t >= intervalMs;
      })
      .sort((a, b) => (a.record.last_verified_at ?? "").localeCompare(b.record.last_verified_at ?? ""))
      .slice(0, MAX_PER_RUN);

    for (const { name } of due) {
      const finding = verifySkill(name);
      findings.push(finding);
      if (finding.ok) {
        setNeedsReview(name, false); // also stamps last_verified_at
        log.info("Pinned skill verified", { name });
      } else {
        markVerified(name); // stamp the attempt so we don't hammer the same skill
        setNeedsReview(name, true);
        log.info("Pinned skill needs review", {
          name,
          missingPaths: finding.missingPaths,
          missingCommands: finding.missingCommands,
        });
      }
    }
  } catch (e) {
    log.warn("Verification pass failed", { error: String(e) });
  }
  return findings;
}
