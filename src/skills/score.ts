/**
 * Freshness score — the ranking signal that replaces raw timestamps.
 *
 *   score = Σ_events  w(kind) · 2^(−Δdays / H)   +   Σ_pre-log-legacy  ...   +   B_new
 *
 * - Events weighted use=1.0, patch=0.5, view=0.15; "maintenance" actor
 *   events (curator / background review) weigh ZERO — the maintainer must
 *   not reset the decay clock it enforces. "hub" events (cross-harness
 *   usage read from the hub telemetry store) count like real uses.
 * - Half-life H defaults to 21 days (SKILL_SCORE_HALF_LIFE_DAYS).
 * - New-skill boost B_new = 0.5 · 2^(−age_days / 14): a fresh skill ranks
 *   as if it had HALF a recent use, decaying over ~2 weeks — "recent =
 *   fresh", and a grace period so a skill can't die before it was ever
 *   surfaceable — but capped below one real use so genuine usage history
 *   always outranks an untried skill (see skill-4).
 * - Legacy counters (use_count/patch_count/view_count + their last_*_at
 *   timestamps) are ALWAYS blended in, not just as an events.length===0
 *   fallback: they are treated as synthetic events at their last_*_at
 *   timestamp, but only counted for activity that PREDATES the earliest
 *   real (non-maintenance) event in events[]. This avoids double-counting
 *   activity that both the legacy counters and the event log recorded,
 *   while making sure a record that predates the v2 event log — and then
 *   only ever receives maintenance touches afterward — doesn't have its
 *   entire real history zeroed out (see skill-1: docker-smart-home-setup
 *   had 2 real legacy uses + 42 legacy patches but only maintenance
 *   events, and scored ~0.062 before this fix).
 *
 * Calibration (H=21d): one use today = 1.0; one use 3 weeks ago = 0.5;
 * a view today = 0.15; a brand-new unused skill = 0.5 → 0.25 after 2 weeks.
 */

import type { SkillEventKind, SkillUsageRecord } from "./types.ts";

const DAY_MS = 24 * 3600 * 1000;
const NEW_SKILL_BOOST_HALF_LIFE_DAYS = 14;
/** Cap on the new-skill boost, expressed as a fraction of one real "use"
 * event's weight (1.0). Kept below 1.0 so a skill with any real usage
 * history — even a single decayed use — outranks an untried skill. */
const NEW_SKILL_BOOST_MAX = 0.5;

const EVENT_WEIGHTS: Record<SkillEventKind, number> = {
  use: 1.0,
  patch: 0.5,
  view: 0.15,
};

export interface ScoreOptions {
  /** Half-life in days for event decay. */
  halfLifeDays: number;
  now: Date;
}

function decayed(weight: number, atMs: number, opts: ScoreOptions): number {
  const deltaDays = Math.max(0, (opts.now.getTime() - atMs) / DAY_MS);
  return weight * Math.pow(2, -deltaDays / opts.halfLifeDays);
}

/**
 * Sum decayed event contributions. Only workflow + hub actors count;
 * maintenance is weight zero by design.
 */
function eventScore(rec: SkillUsageRecord, opts: ScoreOptions): number {
  let sum = 0;
  for (const ev of rec.events) {
    if (ev.actor === "maintenance") continue;
    const w = EVENT_WEIGHTS[ev.kind];
    if (!w) continue;
    const t = Date.parse(ev.at);
    if (isNaN(t)) continue;
    sum += decayed(w, t, opts);
  }
  return sum;
}

/**
 * Earliest REAL (non-maintenance) event timestamp in the log, or null if
 * there are none (either events[] is empty, or it contains only
 * maintenance touches). Used to bound how much legacy counter activity we
 * blend in — legacy activity at/after this point is already represented
 * by the event log and must not be double-counted.
 */
function earliestRealEventMs(rec: SkillUsageRecord): number | null {
  let best: number | null = null;
  for (const ev of rec.events) {
    if (ev.actor === "maintenance") continue;
    const t = Date.parse(ev.at);
    if (isNaN(t)) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

/**
 * Legacy counter contribution: approximate each counter as `count` events
 * all at the corresponding last_*_at timestamp. Overestimates recent
 * activity (all N uses treated as happening at the latest one) but the
 * error decays away within a half-life. Note: legacy counters include
 * curator observer pollution — another reason this path is capped.
 *
 * `beforeMs` (from earliestRealEventMs) restricts this to activity that
 * predates the event log's first real entry, so it blends in pre-v2
 * history without double-counting anything the event log already covers.
 * When `beforeMs` is null (no real events at all — including the
 * events.length===0 case) every legacy counter is eligible.
 */
function legacyScore(rec: SkillUsageRecord, opts: ScoreOptions, beforeMs: number | null): number {
  let sum = 0;
  const parts: Array<[number, string | null, SkillEventKind]> = [
    [rec.use_count, rec.last_used_at, "use"],
    [rec.patch_count, rec.last_patched_at, "patch"],
    [rec.view_count, rec.last_viewed_at, "view"],
  ];
  for (const [count, lastAt, kind] of parts) {
    if (!count || !lastAt) continue;
    const t = Date.parse(lastAt);
    if (isNaN(t)) continue;
    if (beforeMs !== null && t >= beforeMs) continue;
    // Cap the multiplier — 50 stale views must not outrank one real use.
    sum += decayed(EVENT_WEIGHTS[kind] * Math.min(count, 5), t, opts);
  }
  return sum;
}

function newSkillBoost(rec: SkillUsageRecord, opts: ScoreOptions): number {
  const created = Date.parse(rec.created_at);
  if (isNaN(created)) return 0;
  const ageDays = Math.max(0, (opts.now.getTime() - created) / DAY_MS);
  return NEW_SKILL_BOOST_MAX * Math.pow(2, -ageDays / NEW_SKILL_BOOST_HALF_LIFE_DAYS);
}

export function computeScore(rec: SkillUsageRecord, opts: ScoreOptions): number {
  const boundary = earliestRealEventMs(rec);
  const activity = eventScore(rec, opts) + legacyScore(rec, opts, boundary);
  return activity + newSkillBoost(rec, opts);
}

/**
 * Latest REAL activity (workflow/hub events; legacy fallback includes all
 * timestamps since pre-v2 data can't distinguish actors). Used for the
 * idle-time archival check — exposure-anchored by the caller.
 */
export function latestRealActivity(rec: SkillUsageRecord): Date | null {
  if (rec.events.length > 0) {
    let best = 0;
    for (const ev of rec.events) {
      if (ev.actor === "maintenance") continue;
      const t = Date.parse(ev.at);
      if (!isNaN(t) && t > best) best = t;
    }
    return best > 0 ? new Date(best) : null;
  }
  let best = 0;
  for (const c of [rec.last_used_at, rec.last_patched_at, rec.last_viewed_at]) {
    if (!c) continue;
    const t = Date.parse(c);
    if (!isNaN(t) && t > best) best = t;
  }
  return best > 0 ? new Date(best) : null;
}
