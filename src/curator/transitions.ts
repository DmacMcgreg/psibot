/**
 * Pure-logic skill state transitions — Phase A of the curator pass.
 *
 * Walks every agent-created skill and moves between states based on
 * activity timestamps. No LLM involved. Mirrors Hermes'
 * `apply_automatic_transitions` (agent/curator.py:255).
 *
 * State machine:
 *   active   — has been used / patched recently
 *   stale    — no activity for STALE_AFTER_DAYS (default 30)
 *   archived — no activity for ARCHIVE_AFTER_DAYS (default 90); dir moved to .archive/
 *
 * Pinned skills bypass everything — they stay in whatever state they're in.
 * Anchor for "no activity": last_used_at OR last_patched_at OR last_viewed_at,
 * fallback to created_at so brand-new skills don't immediately archive.
 */

import { existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { archiveDir, resolveSkillDir } from "../skills/index.ts";
import { agentCreatedReport, loadUsage, saveUsage } from "../skills/usage.ts";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import type { SkillUsageRecord } from "../skills/types.ts";

const log = createLogger("curator.transitions");

export interface TransitionCounts {
  checked: number;
  marked_stale: number;
  archived: number;
  reactivated: number;
}

function latestActivity(rec: SkillUsageRecord): Date {
  const candidates = [rec.last_used_at, rec.last_patched_at, rec.last_viewed_at, rec.created_at]
    .filter((v): v is string => Boolean(v));
  if (candidates.length === 0) return new Date(0);
  // Most recent timestamp wins.
  let best = new Date(0);
  for (const c of candidates) {
    const d = new Date(c);
    if (!isNaN(d.getTime()) && d > best) best = d;
  }
  return best;
}

/**
 * Apply automatic state transitions. Returns counts for the report. Never
 * raises — a transition error logs and continues with the next skill.
 */
export function applyAutomaticTransitions(now: Date = new Date()): TransitionCounts {
  const cfg = getConfig();
  const staleAfterMs = cfg.CURATOR_STALE_AFTER_DAYS * 24 * 3600 * 1000;
  const archiveAfterMs = cfg.CURATOR_ARCHIVE_AFTER_DAYS * 24 * 3600 * 1000;

  const counts: TransitionCounts = { checked: 0, marked_stale: 0, archived: 0, reactivated: 0 };
  const usage = loadUsage();
  let dirty = false;

  for (const { name, record } of agentCreatedReport()) {
    counts.checked += 1;
    if (record.pinned) continue;

    const anchor = latestActivity(record);
    const idleMs = now.getTime() - anchor.getTime();
    const target =
      idleMs >= archiveAfterMs ? "archived" :
      idleMs >= staleAfterMs ? "stale" :
      "active";

    if (target === record.state) continue;

    try {
      if (target === "archived") {
        // Move the skill directory to .archive/ — recoverable.
        const src = resolveSkillDir(name);
        if (existsSync(src)) {
          const ts = now.toISOString().replace(/[:.]/g, "-");
          const dest = join(archiveDir(), `${name}-${ts}`);
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(src, dest);
          log.info("Auto-archived stale skill", { name, idleDays: Math.round(idleMs / 86400000) });
        }
        // Mark archived in sidecar.
        usage[name] = { ...record, state: "archived", archived_at: now.toISOString() };
        counts.archived += 1;
        dirty = true;
      } else if (target === "stale") {
        usage[name] = { ...record, state: "stale" };
        counts.marked_stale += 1;
        dirty = true;
        log.info("Marked skill stale", { name, idleDays: Math.round(idleMs / 86400000) });
      } else if (target === "active" && record.state === "stale") {
        // Recent activity reactivated a stale skill (rare — usually means
        // the agent re-discovered an old skill).
        usage[name] = { ...record, state: "active" };
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
