/**
 * Curator state file — persistent scheduler/status for the autonomous curator.
 *
 * Lives at <skillsDir>/.curator_state.json. Atomic writes via tmp+rename.
 * First-run rule: when last_run_at is null, seed it to now and DEFER. The
 * curator never runs immediately — it waits one full interval before its
 * first real pass, so a fresh install or `psibot install` doesn't trigger a
 * stampede over a freshly-imported library.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { skillsDir, ensureSkillsDir } from "../skills/index.ts";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("curator.state");

export interface CuratorState {
  lastRunAt: string | null;
  lastRunDurationMs: number | null;
  lastRunSummary: string | null;
  lastReportPath: string | null;
  paused: boolean;
  runCount: number;
}

function defaultState(): CuratorState {
  return {
    lastRunAt: null,
    lastRunDurationMs: null,
    lastRunSummary: null,
    lastReportPath: null,
    paused: false,
    runCount: 0,
  };
}

function statePath(): string {
  return join(skillsDir(), ".curator_state.json");
}

export function loadState(): CuratorState {
  const path = statePath();
  if (!existsSync(path)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CuratorState>;
    return { ...defaultState(), ...parsed };
  } catch (e) {
    log.warn("Failed to read curator state", { error: String(e) });
    return defaultState();
  }
}

export function saveState(s: CuratorState): void {
  ensureSkillsDir();
  const path = statePath();
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, path);
  } catch (e) {
    log.warn("Failed to save curator state", { error: String(e) });
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
  }
}

export function setPaused(paused: boolean): void {
  const s = loadState();
  s.paused = paused;
  saveState(s);
}

export function isPaused(): boolean {
  return loadState().paused;
}

/**
 * Should the curator run NOW? Direct port of Hermes' `should_run_now`:
 *
 *   - enabled AND not paused
 *   - last_run_at present AND >= interval_hours ago
 *
 * First-run defer: if last_run_at is null, seed it to now and return false.
 * Caller's idle gate (min_idle_hours) is checked separately at the call site
 * where we know whether an agent is actively running.
 */
export function shouldRunNow(now: Date = new Date()): boolean {
  const cfg = getConfig();
  if (!cfg.CURATOR_ENABLED) return false;
  const s = loadState();
  if (s.paused) return false;

  if (!s.lastRunAt) {
    // Seed and defer.
    s.lastRunAt = now.toISOString();
    s.lastRunSummary = "deferred first run — seeded; next pass after one full interval";
    saveState(s);
    log.info("Curator first-run seeded", { lastRunAt: s.lastRunAt });
    return false;
  }

  const last = new Date(s.lastRunAt);
  const elapsedMs = now.getTime() - last.getTime();
  const intervalMs = cfg.CURATOR_INTERVAL_HOURS * 3600 * 1000;
  return elapsedMs >= intervalMs;
}
