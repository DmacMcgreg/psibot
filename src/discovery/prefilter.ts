/**
 * Cheap, deterministic pre-filters for discovery candidates.
 *
 * These run before anything that costs money (Jev, transcript fetch, the
 * Claude summary). Each rule was checked against labelled data on 2026-09-26:
 * 860 discovery-processed videos labelled by the Jev /discover triage and
 * David's own ratings, plus the 699 videos he chose himself (Watch Later or
 * sent). A rule only ships if it removes junk without removing his picks.
 * Numbers: docs/plans/2026-09-26-discovery-quality.md.
 *
 * Pure functions only; the DB loaders at the bottom are thin reads.
 */

import type { Database } from "bun:sqlite";

export interface PrefilterConfig {
  /** Reject videos shorter than this (Shorts, clips). 0 disables. */
  minDurationSec: number;
  /** Reject videos longer than this from channels David never chose from. 0 disables. */
  maxDurationMinUnknownChannel: number;
  /** YouTube categoryIds rejected for channels David never chose from ("1" Film & Animation, "20" Gaming). */
  blockedCategoryIds: string[];
  /** Reject when more than this share of the title's letters are non-Latin script (CJK, Cyrillic, Arabic, Indic, Thai, Hangul). */
  maxNonLatinRatio: number;
  /** When YouTube reports a language, it must start with one of these ("en"). Empty disables. */
  allowedLanguages: string[];
  /** Case-insensitive title patterns that mark scripted drama, recaps and Shorts. */
  titlePatterns: RegExp[];
  /** Lower-cased channel titles that are always rejected. */
  blockedChannels: Set<string>;
}

/**
 * Title patterns. Every one matched only junk in the labelled set (see the
 * doc); "full movie" was dropped because it hit two of David's own picks.
 */
export const DEFAULT_TITLE_PATTERNS: RegExp[] = [
  /#\w*shorts?\b/i, // #shorts, #ytshorts
  /#minidramas?\b|\bshort ?dramas?\b|\bmini ?drama\b/i,
  /\bmanhwa\b|\bmanga recap\b|\banime recap\b|\bdonghua\b/i,
  /\bmulti ?sub\b|【multi/i,
  /\bseason \d+\s*[-–~]\s*\d+\b|\bep(?:isode)?s? ?\d+\s*[-–~]\s*\d+\b/i,
  /\bsprunki\b/i,
  /\breborn\b|\bcultivat\w+ (?:immortal|to)\b|\bop origins?\b/i,
  /\bzodiac\b|\bhoroscope\b/i,
  // Scripted revenge stories: a wrong done to the narrator, then the reveal.
  /\b(?:humiliat\w*|mock(?:ed|s)|laugh(?:ed|s) at|kicked (?:me|her|him|us) out|threw (?:me|her|him) out|disown\w*|betray\w*|stole (?:my|her|his)|cheat(?:ed|ing) on|divorc\w*|mistress|evict\w*)\b.*\b(?:not knowing|didn'?t know|until|then (?:learn|found|realiz|discover)\w*|regret\w*|little did|unaware|turns out)/i,
  /\b(?:my (?:son|daughter|husband|wife|sister|brother|mother-in-law|stepmother|daughter-in-law|son-in-law|in-?laws?)|her (?:husband|mother-in-law)|his (?:wife|mother-in-law))\b.*(?:\$\d|\bmillion\b|\bbillion\b|\binheritance\b|\bceo\b|\bheir\w*\b)/i,
];

export const DEFAULT_PREFILTER_CONFIG: PrefilterConfig = {
  minDurationSec: 120,
  maxDurationMinUnknownChannel: 120,
  blockedCategoryIds: ["1", "20"],
  maxNonLatinRatio: 0.3,
  allowedLanguages: ["en"],
  titlePatterns: DEFAULT_TITLE_PATTERNS,
  blockedChannels: new Set(),
};

export interface PrefilterInput {
  title: string | null;
  channelTitle?: string | null;
  /** null/undefined when unknown (RSS entries carry no duration). 0 = live or upcoming. */
  durationSeconds?: number | null;
  categoryId?: string | null;
  audioLanguage?: string | null;
  textLanguage?: string | null;
  /** David chose at least one video from this channel. */
  knownChannel?: boolean;
}

export type PrefilterVerdict = { reject: false } | { reject: true; rule: PrefilterRule; detail: string };
export type PrefilterRule = "channel" | "short" | "live" | "long" | "category" | "script" | "language" | "title";

// CJK, kana, Hangul, Cyrillic, Hebrew, Arabic, Indic scripts, Thai.
const NON_LATIN = /[Ѐ-ӿ֐-׿؀-ۿऀ-෿฀-๿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯豈-﫿]/u;
const LETTER = /\p{L}/u;

/** Share of letters in `text` that are in a non-Latin script. */
export function nonLatinRatio(text: string | null | undefined): number {
  let letters = 0;
  let foreign = 0;
  for (const ch of text ?? "") {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (NON_LATIN.test(ch)) foreign++;
  }
  return letters === 0 ? 0 : foreign / letters;
}

/** search.list returns HTML-escaped titles ("&#39;", "&amp;"); undo that. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * First matching rule wins. Rules that need metadata (duration, category,
 * language) are skipped when it is unknown, so RSS candidates only face the
 * title and channel rules until they are enriched.
 */
export function prefilterCandidate(input: PrefilterInput, cfg: PrefilterConfig = DEFAULT_PREFILTER_CONFIG): PrefilterVerdict {
  const title = input.title ?? "";
  const channel = (input.channelTitle ?? "").trim().toLowerCase();
  if (channel && cfg.blockedChannels.has(channel)) {
    return { reject: true, rule: "channel", detail: input.channelTitle ?? channel };
  }
  const d = input.durationSeconds;
  if (d === 0) return { reject: true, rule: "live", detail: "live or upcoming (duration 0)" };
  if (d != null && cfg.minDurationSec > 0 && d < cfg.minDurationSec) {
    return { reject: true, rule: "short", detail: `${d}s < ${cfg.minDurationSec}s` };
  }
  if (d != null && !input.knownChannel && cfg.maxDurationMinUnknownChannel > 0 && d > cfg.maxDurationMinUnknownChannel * 60) {
    return { reject: true, rule: "long", detail: `${Math.round(d / 60)}m > ${cfg.maxDurationMinUnknownChannel}m, unknown channel` };
  }
  if (input.categoryId && !input.knownChannel && cfg.blockedCategoryIds.includes(input.categoryId)) {
    return { reject: true, rule: "category", detail: `category ${input.categoryId}, unknown channel` };
  }
  const ratio = nonLatinRatio(title);
  if (ratio > cfg.maxNonLatinRatio) {
    return { reject: true, rule: "script", detail: `non-Latin title ${(ratio * 100).toFixed(0)}%` };
  }
  const lang = (input.audioLanguage || input.textLanguage || "").toLowerCase();
  if (lang && cfg.allowedLanguages.length > 0 && !["zxx", "und"].includes(lang)
      && !cfg.allowedLanguages.some((l) => lang === l || lang.startsWith(`${l}-`))) {
    return { reject: true, rule: "language", detail: lang };
  }
  for (const rx of cfg.titlePatterns) {
    const m = title.match(rx);
    if (m) return { reject: true, rule: "title", detail: m[0].slice(0, 40) };
  }
  return { reject: false };
}

/** Reason string stored on a rejected candidate; the prefix makes rejections reversible in bulk. */
export function prefilterReason(v: Extract<PrefilterVerdict, { reject: true }>): string {
  return `prefilter:${v.rule}: ${v.detail}`.slice(0, 200);
}

// ─── DB-derived lists ───────────────────────────────────────────────────────

/**
 * Channels David chose videos from (Watch Later, or sent before discovery
 * found them), by lower-cased channel title → count. Mirrors isChosenVideo()
 * in src/relevance/labels.ts without loading every video row.
 */
export function loadKnownChannels(db: Database): Map<string, number> {
  const rows = db
    .query<{ ch: string; n: number }, []>(
      `SELECT lower(v.channel_title) AS ch, COUNT(*) AS n
         FROM youtube_videos v
        WHERE v.channel_title IS NOT NULL AND v.channel_title != ''
          AND (v.playlist_item_id IS NOT NULL
               OR NOT EXISTS (
                 SELECT 1 FROM discovery_candidates dc
                  WHERE dc.video_id = v.video_id
                    AND julianday(dc.discovered_at) <= julianday(v.created_at)
               ))
        GROUP BY lower(v.channel_title)`,
    )
    .all();
  return new Map(rows.map((r) => [r.ch, r.n]));
}

export interface JunkChannelOptions {
  /** Minimum junk signals before a channel is blocked. */
  minJunk: number;
  /** Maximum share of good signals (picks, interested, chosen videos) a blocked channel may have. */
  maxGoodShare: number;
}

export const DEFAULT_JUNK_CHANNEL_OPTIONS: JunkChannelOptions = { minJunk: 3, maxGoodShare: 0.2 };

/**
 * Channels whose discovery videos David (or the Jev triage built from his
 * ratings) keeps rejecting. Junk signals: a Jev triage `hide`, a
 * not-interested rating, or a Telegram Drop. Good signals: a Jev `pick`, an
 * interested rating, or a video he chose from that channel.
 */
export function loadJunkChannels(db: Database, opts: JunkChannelOptions = DEFAULT_JUNK_CHANNEL_OPTIONS): Set<string> {
  const hasTriage = !!db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='discover_jev_triage'`).get();
  const triageJoin = hasTriage ? `LEFT JOIN discover_jev_triage t ON t.atlas_item_id = a.id` : "";
  const triageCol = hasTriage ? "t.decision" : "NULL";
  const rows = db
    .query<{ ch: string; junk: number; good: number }, []>(
      `WITH latest AS (
         SELECT f.atlas_item_id, f.sentiment FROM discover_feedback f
          WHERE f.id = (SELECT MAX(id) FROM discover_feedback f2 WHERE f2.atlas_item_id = f.atlas_item_id)
       ), per_video AS (
         SELECT lower(v.channel_title) AS ch,
                CASE WHEN l.sentiment = 'not_interested'
                       OR ${triageCol} = 'hide'
                       OR EXISTS (SELECT 1 FROM discovery_candidates dc WHERE dc.video_id = v.video_id AND dc.status = 'dismissed')
                     THEN 1 ELSE 0 END AS junk,
                CASE WHEN l.sentiment = 'interested' OR ${triageCol} = 'pick' OR v.playlist_item_id IS NOT NULL
                     THEN 1 ELSE 0 END AS good
           FROM youtube_videos v
           LEFT JOIN atlas_items a ON a.kind = 'youtube' AND a.source_id = v.video_id
           LEFT JOIN latest l ON l.atlas_item_id = a.id
           ${triageJoin}
          WHERE v.channel_title IS NOT NULL AND v.channel_title != ''
       )
       SELECT ch, SUM(junk) AS junk, SUM(good) AS good FROM per_video GROUP BY ch`,
    )
    .all();
  const out = new Set<string>();
  for (const r of rows) {
    if (r.junk >= opts.minJunk && r.good / (r.junk + r.good) <= opts.maxGoodShare) out.add(r.ch);
  }
  return out;
}
