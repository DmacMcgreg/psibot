import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildGoalSeedPool,
  pickGoalSeeds,
  buildSeedPool,
  cleanQuery,
  DEFAULT_SEED_PICK_OPTIONS,
  isBenched,
  loadLeafWeights,
  parseSeedState,
  pickSeeds,
  recordSeedUse,
  type Seed,
  type SeedState,
} from "./seeds.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("cleanQuery", () => {
  test("drops ampersands, filler words and parentheses", () => {
    expect(cleanQuery("Hidden Power & Global Elites")).toBe("Hidden Power Global Elites");
    expect(cleanQuery("Vatican II, Ecumenism & Apologetics Discourse")).toBe("Vatican II Ecumenism Apologetics Discourse");
    expect(cleanQuery("Open-weight models (Qwen, Kimi)")).toBe("Open-weight models");
  });
  test("caps at 8 words", () => {
    expect(cleanQuery("a1 b2 c3 d4 e5 f6 g7 h8 i9 j10").split(" ")).toHaveLength(8);
  });
});

describe("buildSeedPool", () => {
  test("normalizes weights, skips /other leaves, non-topics and duplicates", () => {
    const pool = buildSeedPool(
      [
        { id: "gnosis-esoteric/gnosticism", label: "Gnosticism", weight: 11 },
        { id: "ai-agents/other", label: "Other agent topics", weight: 50 },
        { id: "ai-models/open-weights", label: "Open-weight models", weight: 22 },
      ],
      [
        { name: "Gnosticism", weight: 0.9 }, // duplicate of a leaf query
        { name: "General Content", weight: 1 }, // catch-all, never a seed
        { name: "Context Engineering", weight: 0.5 },
      ],
    );
    expect(pool.map((s) => s.query)).toEqual(["Open-weight models", "Gnosticism", "Context Engineering"]);
    // Leaf weights normalize against the max over ALL leaves passed in (including /other).
    expect(pool[0]).toMatchObject({ origin: "taxonomy", key: "taxonomy:open-weight models", weight: 22 / 50 });
    expect(pool[2]).toMatchObject({ origin: "profile", weight: 0.5 });
  });
});

const seed = (origin: Seed["origin"], query: string, weight: number): Seed => ({ key: `${origin}:${query.toLowerCase()}`, query, weight, origin });

describe("pickSeeds", () => {
  const pool = [
    seed("taxonomy", "T1", 1),
    seed("taxonomy", "T2", 0.8),
    seed("taxonomy", "T3", 0.5),
    seed("taxonomy", "T4", 0.3),
    seed("profile", "P1", 1),
    seed("profile", "P2", 0.6),
  ];

  test("fresh state: taxonomy share of slots, heaviest first", () => {
    const picked = pickSeeds(pool, 5, {}, NOW);
    expect(picked.map((s) => s.query)).toEqual(["T1", "T2", "T3", "P1", "P2"]);
  });

  test("seeds inside the cooldown are skipped, so runs rotate", () => {
    const state: SeedState = {
      "taxonomy:t1": { uses: 1, lastUsedAt: hoursAgo(6), yieldEma: 0.8 },
      "profile:p1": { uses: 1, lastUsedAt: hoursAgo(6), yieldEma: 0.8 },
    };
    const picked = pickSeeds(pool, 3, state, NOW).map((s) => s.query);
    expect(picked).not.toContain("T1");
    expect(picked).not.toContain("P1");
    expect(picked).toEqual(["T2", "T3", "P2"]);
  });

  test("a recently used seed ranks below a never-used lighter one", () => {
    const state: SeedState = { "taxonomy:t1": { uses: 3, lastUsedAt: hoursAgo(60), yieldEma: 0.9 } };
    const picked = pickSeeds(pool, 5, state, NOW).map((s) => s.query);
    expect(picked.indexOf("T2")).toBeLessThan(picked.indexOf("T1") === -1 ? 99 : picked.indexOf("T1"));
  });

  test("low-yield seeds are benched, then retried after benchDays", () => {
    const bad = { uses: 2, lastUsedAt: hoursAgo(50), yieldEma: 0.05 };
    expect(isBenched(bad, NOW, DEFAULT_SEED_PICK_OPTIONS)).toBe(true);
    expect(pickSeeds(pool, 6, { "taxonomy:t1": bad }, NOW).map((s) => s.query)).not.toContain("T1");
    const old = { ...bad, lastUsedAt: hoursAgo(15 * 24) };
    expect(isBenched(old, NOW, DEFAULT_SEED_PICK_OPTIONS)).toBe(false);
    // One bad use is not enough evidence to bench.
    expect(isBenched({ ...bad, uses: 1 }, NOW, DEFAULT_SEED_PICK_OPTIONS)).toBe(false);
  });

  test("backfills from the other origin when one runs dry", () => {
    const picked = pickSeeds([seed("profile", "P1", 1), seed("profile", "P2", 0.5)], 2, {}, NOW);
    expect(picked.map((s) => s.query)).toEqual(["P1", "P2"]);
  });

  test("n = 0 picks nothing", () => {
    expect(pickSeeds(pool, 0, {}, NOW)).toEqual([]);
  });
});

describe("recordSeedUse", () => {
  test("tracks uses, last use and an EMA of yield", () => {
    let s = recordSeedUse({}, "k", 10, 2, NOW);
    expect(s.k).toEqual({ uses: 1, lastUsedAt: NOW.toISOString(), yieldEma: 0.2 });
    s = recordSeedUse(s, "k", 10, 6, NOW);
    expect(s.k.yieldEma).toBeCloseTo(0.4);
    // A search that found nothing new counts as a use but leaves the yield alone.
    s = recordSeedUse(s, "k", 0, 0, NOW);
    expect(s.k).toMatchObject({ uses: 3, yieldEma: expect.closeTo(0.4, 5) });
  });

  test("parseSeedState tolerates junk", () => {
    expect(parseSeedState(null)).toEqual({});
    expect(parseSeedState("not json")).toEqual({});
    expect(parseSeedState("[1,2]")).toEqual({});
  });
});

describe("loadLeafWeights", () => {
  test("chosen videos +1, latest rating ±, discovery finds ignored", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE youtube_videos (video_id TEXT, playlist_item_id TEXT, created_at TEXT);
      CREATE TABLE discovery_candidates (video_id TEXT, discovered_at TEXT);
      CREATE TABLE item_categories (item_key TEXT, leaf TEXT);
      CREATE TABLE atlas_items (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT);
      CREATE TABLE discover_feedback (id INTEGER PRIMARY KEY, atlas_item_id INTEGER, sentiment TEXT);
    `);
    db.exec(`
      INSERT INTO youtube_videos VALUES ('wl', 'PLI', '2026-09-01 00:00:00'), ('sent', NULL, '2026-09-01 00:00:00'), ('disc', NULL, '2026-09-02 00:00:00'), ('drama', NULL, '2026-09-02 00:00:00');
      INSERT INTO discovery_candidates VALUES ('disc', '2026-09-01T00:00:00Z'), ('drama', '2026-09-01T00:00:00Z');
      INSERT INTO item_categories VALUES ('video:wl', 'gnosis/gnosticism'), ('video:sent', 'gnosis/gnosticism'), ('video:disc', 'ai/agents'), ('video:drama', 'viral/drama');
      INSERT INTO atlas_items VALUES (1, 'youtube', 'disc'), (2, 'youtube', 'drama');
      INSERT INTO discover_feedback (atlas_item_id, sentiment) VALUES (1, 'interested'), (2, 'interested'), (2, 'not_interested');
    `);
    const labels = new Map([["gnosis/gnosticism", "Gnosticism"], ["ai/agents", "Agents"], ["viral/drama", "Drama"]]);
    expect(loadLeafWeights(db, labels)).toEqual([
      { id: "gnosis/gnosticism", label: "Gnosticism", weight: 2 },
      { id: "ai/agents", label: "Agents", weight: 1.5 },
    ]);
  });

  test("no item_categories table: no taxonomy seeds", () => {
    const db = new Database(":memory:");
    expect(loadLeafWeights(db, new Map([["a", "A"]]))).toEqual([]);
  });
});

describe("goal seeds", () => {
  const tracks = [
    { id: "marketing", weight: 3, description: "Marketing skills." },
    { id: "video", weight: 2, description: "Edit video faster." },
    { id: "custom-track", weight: 1, description: "Sell handmade widgets online" },
    { id: "muted", weight: 0, description: "Never searched" },
  ];

  test("one seed per curated query; unknown tracks fall back to their description; weight 0 skipped", () => {
    const pool = buildGoalSeedPool(tracks);
    expect(pool.every((s) => s.origin === "goal" && s.key.startsWith("goal:"))).toBe(true);
    expect(pool.some((s) => s.track === "video" && /ffmpeg/i.test(s.query))).toBe(true);
    expect(pool.some((s) => s.track === "marketing")).toBe(true);
    expect(pool.find((s) => s.track === "custom-track")?.query).toBe("Sell handmade widgets online");
    expect(pool.some((s) => s.track === "muted")).toBe(false);
    expect(pool.find((s) => s.track === "marketing")!.weight).toBe(1);
  });

  test("picks round-robin across tracks and honours cooldown", () => {
    const pool = buildGoalSeedPool(tracks);
    const two = pickGoalSeeds(pool, 2, {}, NOW);
    expect(two).toHaveLength(2);
    expect(new Set(two.map((s) => s.track)).size).toBe(2);
    const state: SeedState = Object.fromEntries(two.map((s) => [s.key, { uses: 1, lastUsedAt: hoursAgo(1), yieldEma: 0.5 }]));
    const next = pickGoalSeeds(pool, 2, state, NOW);
    expect(next.some((s) => two.some((t) => t.key === s.key))).toBe(false);
  });

  test("goal seeds never enter the interest picks", () => {
    const goal = buildGoalSeedPool(tracks);
    const interest: Seed[] = [{ key: "taxonomy:gnosticism", query: "Gnosticism", weight: 1, origin: "taxonomy" }];
    const picked = pickSeeds([...interest, ...goal], 1, {}, NOW);
    expect(picked.map((s) => s.origin)).toEqual(["taxonomy"]);
  });
});
