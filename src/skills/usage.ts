/**
 * Skill usage sidecar — telemetry that the curator reads.
 *
 * Single JSON file at <skillsDir>/.usage.json keyed by skill name. Atomic
 * writes via tmp file + rename.
 *
 * Three counters per skill (view / use / patch) bumped from instrumented call
 * sites, plus a capped append-only `events[]` log tagged with the actor
 * (workflow / maintenance / hub) — maintenance activity carries zero weight
 * in the freshness score so the curator can't keep dead skills alive by
 * looking at them. The curator recomputes score + HOT/COLD tier each tick;
 * pinned skills never decay but get a periodic verification pass instead.
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
import { isBackgroundReview } from "./provenance.ts";
import type {
  SkillActor,
  SkillEvent,
  SkillEventKind,
  SkillExportRecord,
  SkillState,
  SkillTier,
  SkillUsageRecord,
} from "./types.ts";

const log = createLogger("skills.usage");

const STATE_ACTIVE: SkillState = "active";
const STATE_ARCHIVED: SkillState = "archived";
const VALID_STATES = new Set<SkillState>(["active", "stale", "archived"]);

/** Cap on the per-skill append-only event log. Oldest events fall off. */
const MAX_EVENTS = 200;

/**
 * Resolve the actor for a usage event from the write-origin provenance
 * context. Curator + background-review runs are wrapped in
 * `withWriteOriginAsync(BACKGROUND_REVIEW, ...)`, so their skill_view /
 * skill_manage activity is automatically tagged "maintenance" — no tool
 * parameter for the model to forget. Everything else is real consumption.
 */
function currentActor(): SkillActor {
  return isBackgroundReview() ? "maintenance" : "workflow";
}

function appendEvent(rec: SkillUsageRecord, kind: SkillEventKind, actor: SkillActor, at?: string): void {
  rec.events.push({ kind, at: at ?? nowIso(), actor });
  if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
}

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
    events: [],
    verdicts: { helped: 0, neutral: 0, misled: 0 },
    first_exposed_at: null,
    last_verified_at: null,
    needs_review: false,
    tier: "cold",
    score: 0,
    export_approved: false,
    exported: null,
  };
}

/**
 * Merge a possibly pre-v2 raw record onto the full shape, deep-merging the
 * nested objects a shallow spread would clobber.
 */
function hydrateRecord(raw: Partial<SkillUsageRecord>): SkillUsageRecord {
  const base = emptyRecord();
  const rec: SkillUsageRecord = { ...base, ...raw };
  rec.events = Array.isArray(raw.events) ? raw.events : [];
  rec.verdicts = { ...base.verdicts, ...(raw.verdicts ?? {}) };
  return rec;
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
        out[k] = hydrateRecord(v as Partial<SkillUsageRecord>);
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
  return hydrateRecord(rec);
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
  const actor = currentActor();
  mutate(name, (r) => {
    r.view_count = (r.view_count ?? 0) + 1;
    r.last_viewed_at = nowIso();
    appendEvent(r, "view", actor);
  });
}

export function bumpUse(name: string): void {
  const actor = currentActor();
  mutate(name, (r) => {
    r.use_count = (r.use_count ?? 0) + 1;
    r.last_used_at = nowIso();
    appendEvent(r, "use", actor);
  });
}

export function bumpPatch(name: string): void {
  const actor = currentActor();
  mutate(name, (r) => {
    r.patch_count = (r.patch_count ?? 0) + 1;
    r.last_patched_at = nowIso();
    appendEvent(r, "patch", actor);
  });
}

/**
 * Record a cross-harness use observed in the hub's telemetry store.
 * `at` is the span timestamp, not "now" — freshness must reflect when the
 * skill was actually used.
 */
export function recordHubUse(name: string, at: string): void {
  mutate(name, (r) => {
    r.use_count = (r.use_count ?? 0) + 1;
    if (!r.last_used_at || at > r.last_used_at) r.last_used_at = at;
    appendEvent(r, "use", "hub", at);
  });
}

/** Background-review outcome verdict for a run that loaded this skill. */
export function recordVerdict(name: string, verdict: "helped" | "neutral" | "misled"): void {
  mutate(name, (r) => {
    r.verdicts[verdict] = (r.verdicts[verdict] ?? 0) + 1;
  });
}

/**
 * Stamp first exposure (system-prompt listing or job injection). Only the
 * first call writes; afterwards it's a cheap read + no-op, safe to call on
 * every prompt build.
 */
export function markExposed(names: string[]): void {
  if (names.length === 0) return;
  try {
    const data = loadUsage();
    let dirty = false;
    const ts = nowIso();
    for (const name of names) {
      const rec = data[name] ?? emptyRecord();
      if (rec.first_exposed_at) continue;
      rec.first_exposed_at = ts;
      data[name] = rec;
      dirty = true;
    }
    if (dirty) saveUsage(data);
  } catch (e) {
    log.debug("markExposed failed", { error: String(e) });
  }
}

export function setTierAndScore(name: string, tier: SkillTier, score: number): void {
  mutate(name, (r) => {
    r.tier = tier;
    r.score = Math.round(score * 1000) / 1000;
  });
}

export function setNeedsReview(name: string, needsReview: boolean): void {
  mutate(name, (r) => {
    r.needs_review = needsReview;
    if (!needsReview) r.last_verified_at = nowIso();
  });
}

export function markVerified(name: string): void {
  mutate(name, (r) => {
    r.last_verified_at = nowIso();
  });
}

export function setExportApproved(name: string, approved: boolean): void {
  mutate(name, (r) => {
    r.export_approved = approved;
  });
}

export function setExported(name: string, exported: SkillExportRecord | null): void {
  mutate(name, (r) => {
    r.exported = exported;
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
  return allSkillsReport().filter(({ record }) => record.created_by === "agent");
}

/**
 * Like agentCreatedReport but covering ALL on-disk skills — hand-authored
 * ones included. The lifecycle (scoring, tiers, verification, export) covers
 * everything; only destructive auto-archival stays agent-created-only.
 */
export function allSkillsReport(): Array<{ name: string; record: SkillUsageRecord }> {
  const usage = loadUsage();
  const onDisk = listSkills();
  const out: Array<{ name: string; record: SkillUsageRecord }> = [];
  for (const s of onDisk) {
    out.push({ name: s.name, record: usage[s.name] ? hydrateRecord(usage[s.name]) : emptyRecord() });
  }
  return out;
}
