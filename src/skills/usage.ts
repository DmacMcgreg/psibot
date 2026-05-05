/**
 * Skill usage sidecar — telemetry that the curator reads.
 *
 * Single JSON file at <skillsDir>/.usage.json keyed by skill name. Atomic
 * writes via tmp file + rename.
 *
 * Three counters per skill (view / use / patch) bumped from instrumented call
 * sites. State machine drives the curator: active → stale (30d idle) →
 * archived (90d idle). Pinned skills bypass auto-transitions entirely.
 *
 * Critical safety rail: only skills with `created_by === "agent"` are eligible
 * for autonomous curator management. The provenance context (skills/provenance.ts)
 * gates writes — only the background review fork sets created_by="agent".
 * User-authored skills accrue counters but the curator never touches them.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../shared/logger.ts";
import { skillsDir, ensureSkillsDir, listSkills } from "./index.ts";
import type { SkillState, SkillUsageRecord } from "./types.ts";

const log = createLogger("skills.usage");

const STATE_ACTIVE: SkillState = "active";
const STATE_ARCHIVED: SkillState = "archived";
const VALID_STATES = new Set<SkillState>(["active", "stale", "archived"]);

function usageFile(): string {
  return join(skillsDir(), ".usage.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyRecord(): SkillUsageRecord {
  return {
    created_by: null,
    use_count: 0,
    view_count: 0,
    patch_count: 0,
    last_used_at: null,
    last_viewed_at: null,
    last_patched_at: null,
    created_at: nowIso(),
    state: STATE_ACTIVE,
    pinned: false,
    archived_at: null,
  };
}

export function loadUsage(): Record<string, SkillUsageRecord> {
  const path = usageFile();
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SkillUsageRecord> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = { ...emptyRecord(), ...(v as Partial<SkillUsageRecord>) };
      }
    }
    return out;
  } catch (e) {
    log.warn("Failed to read .usage.json", { error: String(e) });
    return {};
  }
}

export function saveUsage(data: Record<string, SkillUsageRecord>): void {
  ensureSkillsDir();
  const path = usageFile();
  // tmp must be on the same filesystem as the target for atomic rename.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8" });
    renameSync(tmp, path);
  } catch (e) {
    log.warn("Failed to write .usage.json", { error: String(e) });
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
  }
}

export function getRecord(name: string): SkillUsageRecord {
  const data = loadUsage();
  const rec = data[name];
  if (!rec) return emptyRecord();
  return { ...emptyRecord(), ...rec };
}

/**
 * Read-modify-write helper. Best-effort: a write failure logs but does not
 * raise — telemetry should never block agent runs. Bundled / hub-installed
 * skill names would go here too in a future world; for now we accept any
 * locally-authored skill, but only `created_by==="agent"` ones become
 * curator-eligible.
 */
function mutate(name: string, fn: (rec: SkillUsageRecord) => void): void {
  if (!name) return;
  try {
    const data = loadUsage();
    const rec = data[name] ?? emptyRecord();
    fn(rec);
    data[name] = rec;
    saveUsage(data);
  } catch (e) {
    log.debug("usage mutate failed", { name, error: String(e) });
  }
}

export function bumpView(name: string): void {
  mutate(name, (r) => {
    r.view_count = (r.view_count ?? 0) + 1;
    r.last_viewed_at = nowIso();
  });
}

export function bumpUse(name: string): void {
  mutate(name, (r) => {
    r.use_count = (r.use_count ?? 0) + 1;
    r.last_used_at = nowIso();
  });
}

export function bumpPatch(name: string): void {
  mutate(name, (r) => {
    r.patch_count = (r.patch_count ?? 0) + 1;
    r.last_patched_at = nowIso();
  });
}

export function markAgentCreated(name: string): void {
  mutate(name, (r) => {
    r.created_by = "agent";
  });
}

export function setState(name: string, state: SkillState): void {
  if (!VALID_STATES.has(state)) {
    log.debug("setState: invalid state", { name, state });
    return;
  }
  mutate(name, (r) => {
    r.state = state;
    if (state === STATE_ARCHIVED) r.archived_at = nowIso();
    else if (state === STATE_ACTIVE) r.archived_at = null;
  });
}

export function setPinned(name: string, pinned: boolean): void {
  mutate(name, (r) => {
    r.pinned = pinned;
  });
}

export function forget(name: string): void {
  if (!name) return;
  try {
    const data = loadUsage();
    if (name in data) {
      delete data[name];
      saveUsage(data);
    }
  } catch (e) {
    log.debug("forget failed", { name, error: String(e) });
  }
}

export function isAgentCreated(name: string): boolean {
  const rec = getRecord(name);
  return rec.created_by === "agent";
}

/**
 * Snapshot of every locally-installed skill's record. Used by the curator
 * to build the candidate list and to diff before/after a run. Returns one
 * row per skill present on disk, with the usage record (creating an empty
 * one if the sidecar entry is missing).
 */
export function agentCreatedReport(): Array<{ name: string; record: SkillUsageRecord }> {
  const usage = loadUsage();
  const onDisk = listSkills();
  const out: Array<{ name: string; record: SkillUsageRecord }> = [];
  for (const s of onDisk) {
    const rec = usage[s.name] ?? emptyRecord();
    if (rec.created_by !== "agent") continue;
    out.push({ name: s.name, record: rec });
  }
  return out;
}
