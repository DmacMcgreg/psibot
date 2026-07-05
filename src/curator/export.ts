/**
 * Skill export — the hub integration seam (Phase 1 of the lifecycle plan).
 *
 * One-way sync of approved skills into ~/.claude/skills/ (SKILL_EXPORT_DIR).
 * That directory is neutral ground: Claude Code sessions load skills from it
 * directly, and local-mcp-hub's seed-paths script wraps it into
 * provenance:"auto" GoldenPaths — so export here means hub ingestion with
 * zero hub-repo changes and zero coordination.
 *
 * Rules:
 *   - Human gate: only skills with `export_approved` (skill_manage
 *     action=approve_export) are synced. The curator NOMINATES candidates
 *     that clear the quality bar; David approves. The approval queue doubles
 *     as the human-authoring queue for the hub's provenance flip.
 *   - PsiBot store is the source of truth. Re-synced every pass (idempotent);
 *     tombstoned (exported copy deleted) when the skill is archived at home
 *     or approval is revoked — a decayed skill must not linger in
 *     ~/.claude/skills unmaintained.
 *   - Never touch a directory PsiBot didn't create: ownership is proven by
 *     the `x-psibot` marker in the exported SKILL.md frontmatter. Name
 *     collisions fall back to a `psibot-` prefix; if that's taken too, skip.
 *
 * Exported copies carry `x-psibot` frontmatter (origin, exported_at, score,
 * verdicts) — provenance metadata the hub seeder ignores safely but the
 * human provenance-flip pass can use.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import { readSkill, resolveSkillDir, skillExists } from "../skills/index.ts";
import { allSkillsReport, loadUsage, setExported, isExportDeclined, wasExportNudged } from "../skills/usage.ts";
import type { SkillUsageRecord } from "../skills/types.ts";

const log = createLogger("curator.export");

const MAX_EXPORT_BODY_LINES = 300;

export interface ExportReport {
  exported: string[];
  tombstoned: string[];
  /** Quality-bar-passing skills awaiting David's approve_export. */
  candidates: string[];
  /**
   * Subset of `candidates` that haven't been Telegram-nudged yet and weren't
   * explicitly skipped — the ones the heartbeat should actually notify about
   * this pass. Nudged/declined state lives in the export-nudge sidecar
   * (src/skills/usage.ts) so a candidate is only ever nudged once.
   */
  newCandidates: string[];
  /** Approved skills that could not be synced (collision, missing, etc). */
  skipped: Array<{ name: string; reason: string }>;
}

export function exportDir(): string {
  const raw = getConfig().SKILL_EXPORT_DIR;
  return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
}

/**
 * Quality bar for NOMINATION (mirrors the hub's promotion-gate conditions so
 * exported skills arrive promotion-ready):
 *   1. Evidence it works: pinned by David, or used ≥2 times with a helped
 *      verdict and no unresolved misled pattern.
 *   2. Description reads as a trigger, not a topic label.
 *   3. Body within budget (knowledge dumps must split into references/ first).
 */
export function meetsQualityBar(name: string, rec: SkillUsageRecord): { ok: boolean; reason: string } {
  const misledDominant = rec.verdicts.misled >= 2 && rec.verdicts.helped === 0;
  if (misledDominant) return { ok: false, reason: "repeatedly misled" };
  const evidence = rec.pinned || (rec.use_count >= 2 && rec.verdicts.helped >= 1);
  if (!evidence) return { ok: false, reason: "no evidence it works (need use_count>=2 + helped verdict, or pin)" };

  const skill = readSkill(name);
  if (!skill) return { ok: false, reason: "missing on disk" };
  const desc = skill.frontmatter.description ?? "";
  if (!/\b(use when|when |use for|use this|trigger)/i.test(desc)) {
    return { ok: false, reason: "description not trigger-phrased ('use when X...')" };
  }
  const lines = skill.body.split("\n").length;
  if (lines > MAX_EXPORT_BODY_LINES) {
    return { ok: false, reason: `body ${lines} lines > ${MAX_EXPORT_BODY_LINES} (split into references/)` };
  }
  return { ok: true, reason: "" };
}

function isOurs(dir: string): boolean {
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) return false;
  try {
    return readFileSync(skillMd, "utf-8").includes("x-psibot:");
  } catch {
    return false;
  }
}

/** Inject/replace the x-psibot block in a SKILL.md's frontmatter. */
function withPsibotFrontmatter(content: string, meta: { origin: string; exportedAt: string; score: number; rec: SkillUsageRecord }): string {
  const block = [
    "x-psibot:",
    `  origin: ${meta.origin}`,
    `  exported_at: ${meta.exportedAt}`,
    `  score: ${meta.score}`,
    `  verdicts: helped=${meta.rec.verdicts.helped} neutral=${meta.rec.verdicts.neutral} misled=${meta.rec.verdicts.misled}`,
  ].join("\n");

  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end !== -1) {
      // Strip any previous x-psibot block (the key line plus its indented
      // children), then append the fresh one.
      const kept: string[] = [];
      let inBlock = false;
      for (const line of content.slice(4, end).split("\n")) {
        if (line.startsWith("x-psibot:")) {
          inBlock = true;
          continue;
        }
        if (inBlock && (line.startsWith("  ") || line.startsWith("\t"))) continue;
        inBlock = false;
        kept.push(line);
      }
      return `---\n${kept.join("\n")}\n${block}\n---\n${content.slice(end + 5)}`;
    }
  }
  return content;
}

function syncOne(name: string, rec: SkillUsageRecord, report: ExportReport): void {
  const src = resolveSkillDir(name);
  const skill = readSkill(name);
  if (!skill) {
    report.skipped.push({ name, reason: "missing on disk" });
    return;
  }

  // Resolve the target name: previous export name wins; else bare name if
  // free-or-ours; else psibot- prefix; else skip.
  const base = exportDir();
  mkdirSync(base, { recursive: true });
  let as = rec.exported?.as ?? name;
  let dest = join(base, as);
  if (existsSync(dest) && !isOurs(dest)) {
    as = `psibot-${name}`;
    dest = join(base, as);
    if (existsSync(dest) && !isOurs(dest)) {
      report.skipped.push({ name, reason: `collision at ${dest}` });
      return;
    }
  }

  try {
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
    const exportedAt = new Date().toISOString();
    const score = rec.score ?? 0;
    const raw = readFileSync(join(dest, "SKILL.md"), "utf-8");
    writeFileSync(join(dest, "SKILL.md"), withPsibotFrontmatter(raw, { origin: src, exportedAt, score, rec }));
    setExported(name, { as, exported_at: exportedAt, score });
    report.exported.push(as === name ? name : `${name} → ${as}`);
    log.info("Exported skill", { name, as, dest });
  } catch (e) {
    report.skipped.push({ name, reason: String(e) });
    log.warn("Export failed", { name, error: String(e) });
  }
}

function tombstoneOne(name: string, rec: SkillUsageRecord, report: ExportReport): void {
  if (!rec.exported) return;
  const dest = join(exportDir(), rec.exported.as);
  try {
    if (existsSync(dest)) {
      if (!isOurs(dest)) {
        log.warn("Tombstone skipped — exported dir not ours anymore", { name, dest });
        setExported(name, null);
        return;
      }
      rmSync(dest, { recursive: true, force: true });
    }
    setExported(name, null);
    report.tombstoned.push(name);
    log.info("Tombstoned exported skill", { name, dest });
  } catch (e) {
    log.warn("Tombstone failed", { name, error: String(e) });
  }
}

/**
 * Run the export pass: sync approved + live skills, tombstone revoked or
 * archived ones, and nominate new candidates. Never raises.
 */
export function runExportPass(): ExportReport {
  const report: ExportReport = { exported: [], tombstoned: [], candidates: [], newCandidates: [], skipped: [] };
  try {
    const onDisk = new Map(allSkillsReport().map((r) => [r.name, r.record]));

    // Tombstones first: anything with an export record that is archived,
    // gone from disk, or no longer approved.
    for (const [name, rec] of Object.entries(loadUsage())) {
      if (!rec.exported) continue;
      const live = onDisk.get(name);
      if (!live || live.state === "archived" || !live.export_approved || !skillExists(name)) {
        tombstoneOne(name, rec, report);
      }
    }

    for (const [name, rec] of onDisk) {
      if (rec.state === "archived") continue;
      if (rec.export_approved) {
        syncOne(name, rec, report);
      } else {
        const bar = meetsQualityBar(name, rec);
        if (bar.ok) {
          report.candidates.push(name);
          if (!isExportDeclined(name) && !wasExportNudged(name)) {
            report.newCandidates.push(name);
          }
        }
      }
    }
  } catch (e) {
    log.warn("Export pass failed", { error: String(e) });
  }
  return report;
}
