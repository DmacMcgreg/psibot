/**
 * Pure-logic skill lifecycle pass — Phase A of the curator.
 *
 * Recomputes every skill's freshness score (src/skills/score.ts) and assigns
 * exposure tiers, then applies state transitions. Covers ALL on-disk skills
 * — hand-authored ones included — but destructive auto-archival stays
 * restricted to agent-created skills (the curator never moves a skill the
 * user wrote).
 *
 * Tiers (hub vocabulary, PsiBot enforcement):
 *   HOT  — pinned, or top-N by score with score ≥ SKILL_HOT_THRESHOLD.
 *          Listed name+description in the system prompt. Hysteresis: a
 *          current HOT member survives until score < 0.7·threshold.
 *   COLD — everything else; searchable via skills_list, loadable on demand.
 *
 * States:
 *   active   — recent real (workflow/hub) activity
 *   stale    — idle ≥ CURATOR_STALE_AFTER_DAYS (label only; still listed)
 *   archived — agent-created only: score < SKILL_ARCHIVE_SCORE_THRESHOLD
 *              AND idle ≥ CURATOR_ARCHIVE_AFTER_DAYS, where the idle clock
 *              anchors at max(last real activity, first_exposed_at). A skill
 *              that has never been exposed (first_exposed_at null) is NEVER
 *              archived — archiving an undiscoverable skill would measure
 *              our own discovery failure, not the skill's value.
 *
 * Pinned skills bypass decay entirely (they get the verification pass in
 * curator/verify.ts instead) and are always HOT.
 */

import { existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { archiveDir, resolveSkillDir } from "../skills/index.ts";
import { allSkillsReport, loadUsage, saveUsage } from "../skills/usage.ts";
import { computeScore, latestRealActivity } from "../skills/score.ts";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import type { SkillTier } from "../skills/types.ts";

const log = createLogger("curator.transitions");

/** Demotion happens below this fraction of the promotion threshold. */
const HYSTERESIS = 0.7;

export interface TransitionCounts {
  checked: number;
  marked_stale: number;
  archived: number;
  reactivated: number;
  hot: number;
}

export interface ScoredSkill {
  name: string;
  score: number;
  tier: SkillTier;
  pinned: boolean;
}

/**
 * Compute scores + tiers for all on-disk skills without mutating anything.
 * Shared by the transition pass and the prompt-listing builder (which runs
 * on every agent turn and must not pay for a sidecar write).
 */
export function scoreAllSkills(now: Date = new Date()): ScoredSkill[] {
  const cfg = getConfig();
  const opts = { halfLifeDays: cfg.SKILL_SCORE_HALF_LIFE_DAYS, now };
  const rows = allSkillsReport().map(({ name, record }) => ({
    name,
    record,
    score: computeScore(record, opts),
  }));

  // Rank by score; pinned are HOT regardless and don't consume HOT slots.
  const ranked = rows.filter((r) => !r.record.pinned).sort((a, b) => b.score - a.score);
  const hotEligible = new Set<string>();
  for (const row of ranked) {
    if (hotEligible.size >= cfg.SKILL_HOT_SET_SIZE) break;
    const threshold = row.record.tier === "hot"
      ? cfg.SKILL_HOT_THRESHOLD * HYSTERESIS
      : cfg.SKILL_HOT_THRESHOLD;
    if (row.score >= threshold) hotEligible.add(row.name);
  }

  return rows.map((row) => ({
    name: row.name,
    score: row.score,
    pinned: row.record.pinned,
    tier: (row.record.pinned || hotEligible.has(row.name) ? "hot" : "cold") as SkillTier,
  }));
}

/**
 * Apply automatic lifecycle transitions. Returns counts for the report.
 * Never raises — a transition error logs and continues with the next skill.
 */
export function applyAutomaticTransitions(now: Date = new Date()): TransitionCounts {
  const cfg = getConfig();
  const staleAfterMs = cfg.CURATOR_STALE_AFTER_DAYS * 24 * 3600 * 1000;
  const archiveAfterMs = cfg.CURATOR_ARCHIVE_AFTER_DAYS * 24 * 3600 * 1000;

  const counts: TransitionCounts = { checked: 0, marked_stale: 0, archived: 0, reactivated: 0, hot: 0 };
  const scored = new Map(scoreAllSkills(now).map((s) => [s.name, s]));
  const usage = loadUsage();
  let dirty = false;

  for (const { name, record } of allSkillsReport()) {
    counts.checked += 1;
    const s = scored.get(name);
    if (!s) continue;
    if (s.tier === "hot") counts.hot += 1;

    // Persist score + tier on every pass (cheap; drives dashboards/prompt).
    // `record` is the hydrated sidecar entry for this skill (allSkillsReport
    // and loadUsage read the same file).
    const rec = record;
    const roundedScore = Math.round(s.score * 1000) / 1000;
    if (rec.tier !== s.tier || rec.score !== roundedScore) {
      rec.tier = s.tier;
      rec.score = roundedScore;
      usage[name] = rec;
      dirty = true;
    }

    if (record.pinned) continue; // never decays; verify.ts maintains it

    // Idle clock: real activity only, anchored at exposure. Unexposed
    // skills idle from created_at for the stale label but never archive.
    const lastActivity = latestRealActivity(record);
    const exposedAt = record.first_exposed_at ? new Date(record.first_exposed_at) : null;
    const anchorMs = Math.max(
      lastActivity?.getTime() ?? 0,
      exposedAt?.getTime() ?? 0,
      Date.parse(record.created_at) || 0,
    );
    if (anchorMs === 0) continue;
    const idleMs = now.getTime() - anchorMs;

    const canArchive =
      record.created_by === "agent" &&
      exposedAt !== null &&
      s.score < cfg.SKILL_ARCHIVE_SCORE_THRESHOLD &&
      idleMs >= archiveAfterMs;

    const target =
      canArchive ? "archived" :
      idleMs >= staleAfterMs ? "stale" :
      "active";

    if (target === record.state) continue;

    try {
      if (target === "archived") {
        const src = resolveSkillDir(name);
        if (existsSync(src)) {
          const ts = now.toISOString().replace(/[:.]/g, "-");
          const dest = join(archiveDir(), `${name}-${ts}`);
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(src, dest);
          log.info("Auto-archived stale skill", {
            name,
            idleDays: Math.round(idleMs / 86400000),
            score: s.score,
          });
        }
        usage[name] = { ...rec, state: "archived", archived_at: now.toISOString() };
        counts.archived += 1;
        dirty = true;
      } else if (target === "stale") {
        usage[name] = { ...rec, state: "stale" };
        counts.marked_stale += 1;
        dirty = true;
        log.info("Marked skill stale", { name, idleDays: Math.round(idleMs / 86400000) });
      } else if (target === "active" && record.state === "stale") {
        usage[name] = { ...rec, state: "active" };
        counts.reactivated += 1;
        dirty = true;
        log.info("Reactivated skill", { name });
      }
    } catch (e) {
      log.warn("Auto-transition failed", { name, error: String(e) });
    }
  }

  if (dirty) saveUsage(usage);
  return counts;
}
