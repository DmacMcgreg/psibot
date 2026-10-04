/**
 * Search seeds for discovery's search.list fan-out.
 *
 * Before 2026-09-26 every run searched YouTube for the display names of the
 * top 5 interest-profile topics, in weight order. Two problems followed:
 *   1. The same 5 queries ran every run, so each 100-unit search mostly
 *      re-found videos it had already seen.
 *   2. Topic names are abstract labels invented by the video analyzer
 *      ("Hidden Identity & Power Reveal", "Hidden Power & Global Elites"),
 *      and YouTube answers abstract phrases with clickbait. The search
 *      source produced 51% junk vs 6% for RSS.
 *
 * Seeds now come from two places:
 *   - Jev taxonomy leaves (data/relevance/taxonomy.json), weighted by how many
 *     videos David chose in each leaf plus his Discover ratings. Leaf labels
 *     are short human-written subject names ("Gnosticism", "Open-weight
 *     models"), which are better search strings than analyzer topic names.
 *   - Interest-profile topics (built from his picks only since 2026-09-25).
 * They rotate: a used seed cools down, and a seed whose results keep failing
 * the gates is benched for a while. Numbers:
 * docs/plans/2026-09-26-discovery-quality.md.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { isNonTopic } from "./profile.ts";

export interface Seed {
  /** Stable key for per-seed stats: `${origin}:${lowercased query}`. */
  key: string;
  query: string;
  /** Relative interest, max 1. */
  weight: number;
  origin: "taxonomy" | "profile" | "goal";
  /** GOALS.md track id, for goal seeds. */
  track?: string;
}

export interface SeedStats {
  uses: number;
  lastUsedAt: string | null;
  /** Exponential moving average of the share of this seed's new candidates that survived the gates. */
  yieldEma: number | null;
}

export type SeedState = Record<string, SeedStats>;

export interface SeedPickOptions {
  /** A seed is not reused within this many hours. */
  cooldownHours: number;
  /** Share of the picks drawn from taxonomy seeds (the rest from profile topics). */
  taxonomyShare: number;
  /** Bench a seed after this many uses if its yield EMA is below `benchBelowYield`. */
  minUsesToBench: number;
  benchBelowYield: number;
  /** A benched seed gets another try after this many days. */
  benchDays: number;
}

export const DEFAULT_SEED_PICK_OPTIONS: SeedPickOptions = {
  cooldownHours: 48,
  taxonomyShare: 0.6,
  minUsesToBench: 2,
  benchBelowYield: 0.15,
  benchDays: 14,
};

const YIELD_ALPHA = 0.5;

/** Turn a topic or leaf name into a search string: no "&", no parentheses, at most 8 words. */
export function cleanQuery(name: string): string {
  return name
    .replace(/\([^)]*\)/g, " ")
    .replace(/[&,;:/|]+/g, " ")
    .replace(/\b(?:and|vs\.?|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 8)
    .join(" ");
}

export interface LeafWeight {
  id: string;
  label: string;
  weight: number;
}

export interface ProfileTopic {
  name: string;
  weight: number;
}

/** Merge taxonomy leaves and profile topics into one deduplicated seed pool. */
export function buildSeedPool(leaves: LeafWeight[], profile: ProfileTopic[]): Seed[] {
  const out: Seed[] = [];
  const seen = new Set<string>();
  const add = (origin: Seed["origin"], raw: string, weight: number) => {
    const query = cleanQuery(raw);
    const norm = query.toLowerCase();
    if (query.length < 3 || seen.has(norm) || weight <= 0) return;
    seen.add(norm);
    out.push({ key: `${origin}:${norm}`, query, weight, origin });
  };
  const maxLeaf = Math.max(0, ...leaves.map((l) => l.weight));
  for (const l of [...leaves].sort((a, b) => b.weight - a.weight)) {
    if (l.id.endsWith("/other") || maxLeaf <= 0) continue;
    add("taxonomy", l.label, l.weight / maxLeaf);
  }
  const maxTopic = Math.max(0, ...profile.map((t) => t.weight));
  for (const t of [...profile].sort((a, b) => b.weight - a.weight)) {
    if (isNonTopic(t.name) || maxTopic <= 0) continue;
    add("profile", t.name, t.weight / maxTopic);
  }
  return out;
}

const hoursSince = (iso: string | null, now: Date) =>
  iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Number.POSITIVE_INFINITY;

export function isBenched(s: SeedStats | undefined, now: Date, o: SeedPickOptions): boolean {
  if (!s || s.uses < o.minUsesToBench || s.yieldEma === null) return false;
  return s.yieldEma < o.benchBelowYield && hoursSince(s.lastUsedAt, now) < o.benchDays * 24;
}

/**
 * Pick `n` seeds. Eligible = not used within the cooldown and not benched.
 * Priority = weight × staleness, where staleness grows from 0 at the end of
 * the cooldown to 1 at four cooldowns (never-used seeds count as fully
 * stale). Draws `taxonomyShare` of the slots from taxonomy seeds, fills the
 * rest from profile seeds, and backfills from either list when one runs dry.
 */
export function pickSeeds(pool: Seed[], n: number, state: SeedState, now: Date, o: SeedPickOptions = DEFAULT_SEED_PICK_OPTIONS): Seed[] {
  if (n <= 0) return [];
  const priority = (s: Seed) => {
    const h = hoursSince(state[s.key]?.lastUsedAt ?? null, now);
    const staleness = Number.isFinite(h) ? Math.min(1, Math.max(0, (h - o.cooldownHours) / (3 * o.cooldownHours)) + 0.05) : 1;
    return s.weight * staleness;
  };
  const eligible = pool.filter((s) => hoursSince(state[s.key]?.lastUsedAt ?? null, now) >= o.cooldownHours && !isBenched(state[s.key], now, o));
  const ranked = (origin: Seed["origin"]) =>
    eligible.filter((s) => s.origin === origin).sort((a, b) => priority(b) - priority(a) || a.key.localeCompare(b.key));
  const tax = ranked("taxonomy");
  const prof = ranked("profile");
  const nTax = Math.min(tax.length, Math.round(n * o.taxonomyShare));
  const picked = [...tax.slice(0, nTax), ...prof.slice(0, n - nTax)];
  if (picked.length < n) {
    const rest = [...tax.slice(nTax), ...prof.slice(n - nTax)].sort((a, b) => priority(b) - priority(a));
    picked.push(...rest.slice(0, n - picked.length));
  }
  return picked;
}

/** Record one use of a seed and the share of its new candidates that survived the gates. */
export function recordSeedUse(state: SeedState, key: string, found: number, survived: number, now: Date): SeedState {
  const prev = state[key] ?? { uses: 0, lastUsedAt: null, yieldEma: null };
  let yieldEma = prev.yieldEma;
  if (found > 0) {
    const y = survived / found;
    yieldEma = yieldEma === null ? y : YIELD_ALPHA * y + (1 - YIELD_ALPHA) * yieldEma;
  }
  return { ...state, [key]: { uses: prev.uses + 1, lastUsedAt: now.toISOString(), yieldEma } };
}

export function parseSeedState(raw: string | null): SeedState {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SeedState) : {};
  } catch {
    return {};
  }
}

// ─── Goal seeds (knowledge/GOALS.md tracks) ─────────────────────────────────

/**
 * Hand-written search strings per GOALS.md track. Concrete "how to" phrasing
 * on purpose: YouTube answers it with tutorials and teardowns rather than
 * commentary. A track in GOALS.md with no entry here falls back to its
 * description line. Added 2026-09-26 (research revamp).
 */
export const GOAL_SEED_QUERIES: Record<string, string[]> = {
  marketing: [
    "claude code marketing skills",
    "AI copywriting workflow tutorial",
    "landing page conversion teardown",
    "local SEO small business tutorial",
    "brand voice guide with AI",
    "cold email lead generation playbook",
  ],
  social: [
    "TikTok growth tactics",
    "short form video hooks that work",
    "faceless shorts automation",
    "auto post reels shorts tiktok API",
    "AI captions subtitles short form",
  ],
  video: [
    "AI video editing agent",
    "ffmpeg tutorial video editing",
    "drone video editing tips",
    "DJI D-Log M color grading",
    "DaVinci Resolve scripting automation",
    "speed ramp transitions tutorial",
    "drone cinematic shots techniques",
  ],
  "client-sites": [
    "AI website builder for agencies",
    "shadcn landing page blocks",
    "web design agency client acquisition",
    "small business website workflow AI",
  ],
  bids: [
    "how to win government contracts canada",
    "CanadaBuys bidding tips",
    "IRAP funding small business",
    "writing a winning RFP response",
  ],
  data: [
    "new hugging face datasets",
    "fine tune small model marketing copy",
    "scraping datasets for training tutorial",
  ],
  "ai-services": [
    "AI automation agency offers",
    "claude code MCP business automation",
    "productized AI service pricing",
  ],
};

/**
 * One seed per query for every track in GOALS.md. Weight follows the track
 * weight (0–3 → 0–1); tracks with weight 0 get no seeds.
 */
export function buildGoalSeedPool(tracks: Array<{ id: string; weight: number; description: string }>): Seed[] {
  const out: Seed[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    if (t.weight <= 0) continue;
    const queries = GOAL_SEED_QUERIES[t.id] ?? (t.description ? [t.description] : []);
    for (const raw of queries) {
      const query = cleanQuery(raw);
      const norm = query.toLowerCase();
      if (query.length < 3 || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ key: `goal:${norm}`, query, weight: Math.min(1, t.weight / 3), origin: "goal", track: t.id });
    }
  }
  return out;
}

/**
 * Pick `n` goal seeds for this run: eligible ones only (cooldown, bench),
 * one per track in turn so a run doesn't spend every slot on one track,
 * higher-weight and staler tracks first.
 */
export function pickGoalSeeds(pool: Seed[], n: number, state: SeedState, now: Date, o: SeedPickOptions = DEFAULT_SEED_PICK_OPTIONS): Seed[] {
  if (n <= 0) return [];
  const priority = (s: Seed) => {
    const h = hoursSince(state[s.key]?.lastUsedAt ?? null, now);
    const staleness = Number.isFinite(h) ? Math.min(1, Math.max(0, (h - o.cooldownHours) / (3 * o.cooldownHours)) + 0.05) : 1;
    return s.weight * staleness;
  };
  const eligible = pool
    .filter((s) => s.origin === "goal")
    .filter((s) => hoursSince(state[s.key]?.lastUsedAt ?? null, now) >= o.cooldownHours && !isBenched(state[s.key], now, o))
    .sort((a, b) => priority(b) - priority(a) || a.key.localeCompare(b.key));
  const byTrack = new Map<string, Seed[]>();
  for (const s of eligible) {
    const k = s.track ?? "";
    if (!byTrack.has(k)) byTrack.set(k, []);
    byTrack.get(k)!.push(s);
  }
  // Tracks in order of their best seed's priority, then round-robin.
  const queues = [...byTrack.values()];
  const picked: Seed[] = [];
  while (picked.length < n && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const s = q.shift();
      if (s) picked.push(s);
      if (picked.length >= n) break;
    }
  }
  return picked;
}

// ─── DB-derived inputs ──────────────────────────────────────────────────────

interface TaxNodeLite {
  id: string;
  label: string;
  children?: TaxNodeLite[];
}

/** id → label for every node in the Jev taxonomy file; empty when the file is missing. */
export function loadTaxonomyLabels(path = "data/relevance/taxonomy.json"): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  try {
    const walk = (n: TaxNodeLite) => {
      out.set(n.id, n.label);
      for (const c of n.children ?? []) walk(c);
    };
    for (const n of JSON.parse(readFileSync(path, "utf-8")) as TaxNodeLite[]) walk(n);
  } catch {
    /* unreadable taxonomy: no taxonomy seeds */
  }
  return out;
}

/** Discover rating weights, matching profile.ts FEEDBACK_WEIGHTS. */
const RATING_WEIGHT: Record<string, number> = { interested: 1.5, not_interested: -2 };

/**
 * Weight per taxonomy leaf: +1 for each video David chose in it (Watch Later,
 * or sent before discovery found it), plus his latest Discover rating on
 * items filed there (interested +1.5, not interested −2). Leaves with a net
 * weight ≤ 0 are dropped. Needs `item_categories` (written by the nightly
 * Jev categorize job); returns [] without it.
 */
export function loadLeafWeights(db: Database, labels: Map<string, string> = loadTaxonomyLabels()): LeafWeight[] {
  const hasCats = !!db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='item_categories'`).get();
  if (!hasCats || labels.size === 0) return [];
  const chosen = db
    .query<{ leaf: string; n: number }, []>(
      `SELECT c.leaf, COUNT(*) AS n
         FROM youtube_videos v
         JOIN item_categories c ON c.item_key = 'video:' || v.video_id
        WHERE v.playlist_item_id IS NOT NULL
           OR NOT EXISTS (SELECT 1 FROM discovery_candidates dc
                           WHERE dc.video_id = v.video_id
                             AND julianday(dc.discovered_at) <= julianday(v.created_at))
        GROUP BY c.leaf`,
    )
    .all();
  const rated = db
    .query<{ leaf: string; sentiment: string; n: number }, []>(
      `SELECT c.leaf, f.sentiment, COUNT(*) AS n
         FROM discover_feedback f
         JOIN atlas_items a ON a.id = f.atlas_item_id AND a.kind = 'youtube'
         JOIN item_categories c ON c.item_key = 'video:' || a.source_id
        WHERE f.id = (SELECT MAX(id) FROM discover_feedback f2 WHERE f2.atlas_item_id = f.atlas_item_id)
        GROUP BY c.leaf, f.sentiment`,
    )
    .all();
  const w = new Map<string, number>();
  for (const r of chosen) w.set(r.leaf, (w.get(r.leaf) ?? 0) + r.n);
  for (const r of rated) w.set(r.leaf, (w.get(r.leaf) ?? 0) + (RATING_WEIGHT[r.sentiment] ?? 0) * r.n);
  const out: LeafWeight[] = [];
  for (const [id, weight] of w) {
    const label = labels.get(id);
    if (label && weight > 0) out.push({ id, label, weight });
  }
  return out.sort((a, b) => b.weight - a.weight);
}
