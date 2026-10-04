import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  DEFAULT_PREFILTER_CONFIG,
  decodeHtmlEntities,
  loadJunkChannels,
  loadKnownChannels,
  nonLatinRatio,
  prefilterCandidate,
  prefilterReason,
  type PrefilterInput,
} from "./prefilter.ts";

const cfg = { ...DEFAULT_PREFILTER_CONFIG, blockedChannels: new Set(["duoduo shortdrama"]) };
const check = (input: PrefilterInput) => prefilterCandidate(input, cfg);
const rule = (input: PrefilterInput) => {
  const v = check(input);
  return v.reject ? v.rule : null;
};

describe("nonLatinRatio", () => {
  test("pure English and emoji are 0", () => {
    expect(nonLatinRatio("Claude Code skills are insane 🔥")).toBe(0);
  });
  test("Chinese drama title is ~1", () => {
    expect(nonLatinRatio("首富大佬派1000輛勞斯萊斯接搬磚小夥")).toBeGreaterThan(0.9);
  });
  test("accented Latin (French, Spanish) counts as Latin", () => {
    expect(nonLatinRatio("L’héritage ottoman : musulmans d’Europe")).toBe(0);
  });
  test("empty is 0", () => {
    expect(nonLatinRatio("")).toBe(0);
    expect(nonLatinRatio(null)).toBe(0);
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes what search.list returns", () => {
    expect(decodeHtmlEntities("Kash Patel&#39;s Epstein Video &amp; &quot;Files&quot;")).toBe(`Kash Patel's Epstein Video & "Files"`);
    expect(decodeHtmlEntities("a &lt;b&gt; &#x27;c&#x27;")).toBe("a <b> 'c'");
  });
});

describe("prefilterCandidate", () => {
  test("keeps David-style picks", () => {
    for (const title of [
      "These New Claude Skills Are Actually Insane",
      "The 7 Hermetic Laws Explained (in detail)",
      "Ex-CIA Agent EXPOSES Epstein, Charlie Kirk, and Mossad's Influence Over America",
      "Anthropic CEO issues WARNING about superintelligence",
      "How To Create a FULL Movie in MINUTES With AI Agents (n8n)",
      "Spacetime Is The Memory Of A Self Knowing Universe",
    ]) {
      expect(check({ title, durationSeconds: 1500, categoryId: "28", audioLanguage: "en" })).toEqual({ reject: false });
    }
  });

  test("Shorts: under the minimum duration, or a #shorts tag", () => {
    expect(rule({ title: "AI news", durationSeconds: 45 })).toBe("short");
    expect(rule({ title: "The Elite Club Of Nuclear Submarine Power #science #ytshorts", durationSeconds: null })).toBe("title");
    expect(rule({ title: "AI news #Shorts" })).toBe("title");
  });

  test("duration 0 means live or upcoming", () => {
    expect(rule({ title: "41-0 UNANIMOUS VOTE", durationSeconds: 0 })).toBe("live");
  });

  test("long videos: rejected from unknown channels, kept from known ones", () => {
    const long = { title: "Kash Patel LIVE: Senate Hearing", durationSeconds: 714 * 60 };
    expect(rule({ ...long, knownChannel: false })).toBe("long");
    expect(rule({ ...long, knownChannel: true })).toBeNull();
  });

  test("Film & Animation / Gaming only from unknown channels", () => {
    expect(rule({ title: "Some recap", categoryId: "1", durationSeconds: 900 })).toBe("category");
    expect(rule({ title: "The Terrifying Psychology Of Dune", categoryId: "1", durationSeconds: 900, knownChannel: true })).toBeNull();
    expect(rule({ title: "Prison Life Sim demo", categoryId: "20", durationSeconds: 900 })).toBe("category");
  });

  test("non-Latin titles", () => {
    expect(rule({ title: "남편이 인턴과 바람피우는 아내를 현장에서 잡았다!" })).toBe("script");
  });

  test("reported non-English language, but not zxx/und", () => {
    expect(rule({ title: "Gardez votre Paix", audioLanguage: "fr" })).toBe("language");
    expect(rule({ title: "Talk", audioLanguage: "en-GB" })).toBeNull();
    expect(rule({ title: "Ambient", audioLanguage: "zxx" })).toBeNull();
    expect(rule({ title: "No language info" })).toBeNull();
  });

  test("scripted drama and recap title patterns", () => {
    for (const title of [
      "They Humiliated Her For Helping A Beggar—Not Knowing She Was The CEO's Mother",
      "My Son And His Wife Claimed \"You Eat But Don't Help\"—So I Sold Their House For $3.5M",
      "Reborn As Disfigured True Heir, I Tear Off Family's Hypocritical Masks",
      "Everyone Thought He Had No Magic…Until the Academy Found Out | Manhwa Recap",
      "[New] No Spirit Root? I Still Cultivate Immortality Season 1-6 | MULTI SUB",
      "[FULL] Evil Stepmother Forces Substitute Marriage #minidramas",
      "ALL SPRUNKI FAMILY PHASES – SIZE COMPARISON",
    ]) {
      expect(rule({ title })).toBe("title");
    }
  });

  test("blocked channel wins first", () => {
    expect(rule({ title: "Anything", channelTitle: "DUODUO SHORTDRAMA" })).toBe("channel");
  });

  test("reason carries a greppable prefix", () => {
    const v = check({ title: "x", durationSeconds: 30 });
    if (!v.reject) throw new Error("expected reject");
    expect(prefilterReason(v)).toBe("prefilter:short: 30s < 120s");
  });

  test("rules can be disabled via config", () => {
    const off = { ...cfg, minDurationSec: 0, maxDurationMinUnknownChannel: 0, blockedCategoryIds: [], allowedLanguages: [], titlePatterns: [] };
    expect(prefilterCandidate({ title: "AI #shorts", durationSeconds: 30, categoryId: "20", audioLanguage: "fr" }, off)).toEqual({ reject: false });
  });
});

function fixtureDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE youtube_videos (video_id TEXT PRIMARY KEY, title TEXT, channel_title TEXT, playlist_item_id TEXT, created_at TEXT);
    CREATE TABLE discovery_candidates (id INTEGER PRIMARY KEY, video_id TEXT, status TEXT, discovered_at TEXT);
    CREATE TABLE atlas_items (id INTEGER PRIMARY KEY, kind TEXT, source_id TEXT);
    CREATE TABLE discover_feedback (id INTEGER PRIMARY KEY, atlas_item_id INTEGER, sentiment TEXT);
    CREATE TABLE discover_jev_triage (atlas_item_id INTEGER PRIMARY KEY, decision TEXT);
  `);
  const v = db.prepare(`INSERT INTO youtube_videos VALUES (?, ?, ?, ?, '2026-09-01 10:00:00')`);
  const dc = db.prepare(`INSERT INTO discovery_candidates (video_id, status, discovered_at) VALUES (?, ?, '2026-08-31T10:00:00Z')`);
  const a = db.prepare(`INSERT INTO atlas_items (id, kind, source_id) VALUES (?, 'youtube', ?)`);
  // Drama channel: 3 discovery videos, all hidden by Jev.
  for (const [i, id] of ["d1", "d2", "d3"].entries()) {
    v.run(id, "drama", "Short Drama Now", null);
    dc.run(id, "surfaced");
    a.run(10 + i, id);
    db.run(`INSERT INTO discover_jev_triage VALUES (?, 'hide')`, [10 + i]);
  }
  // News channel: 3 junk, but David saved one to Watch Later and Jev picked one.
  for (const [i, id] of ["n1", "n2", "n3", "n4", "n5"].entries()) {
    v.run(id, "news", "CTV News", id === "n5" ? "PLI" : null);
    if (id !== "n5") dc.run(id, "surfaced");
    a.run(20 + i, id);
  }
  db.run(`INSERT INTO discover_feedback (atlas_item_id, sentiment) VALUES (20, 'not_interested'), (21, 'not_interested'), (22, 'interested'), (22, 'not_interested')`);
  db.run(`INSERT INTO discover_jev_triage VALUES (23, 'pick')`);
  // A video David sent himself, discovered later by RSS: his own pick.
  v.run("s1", "agents", "AI Engineer", null);
  db.run(`INSERT INTO discovery_candidates (video_id, status, discovered_at) VALUES ('s1', 'expired_stale', '2026-09-02T10:00:00Z')`);
  return db;
}

describe("DB-derived channel lists", () => {
  test("loadJunkChannels blocks all-junk channels, not channels with his picks", () => {
    const junk = loadJunkChannels(fixtureDb());
    expect(junk.has("short drama now")).toBe(true);
    // CTV: 3 junk (2 rejected + latest-rating-rejected) vs 2 good (Watch Later + Jev pick) = 40% good.
    expect(junk.has("ctv news")).toBe(false);
  });

  test("loadKnownChannels counts Watch Later and videos sent before discovery", () => {
    const known = loadKnownChannels(fixtureDb());
    expect(known.get("ctv news")).toBe(1);
    expect(known.get("ai engineer")).toBe(1);
    expect(known.has("short drama now")).toBe(false);
  });
});
