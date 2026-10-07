/**
 * Hacker News (Algolia) → `tool`, `skill`, `technique` or `dataset` assets.
 *
 * Topic searches over the last 7 days with a points floor, plus Show HN with a
 * higher floor. The community vote does the first cut; rules drop Ask HN,
 * jobs and link-less posts; the scorer keeps only things David can use.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, fetchJson, pickEffort, pickKind, pickTrack, runFeed, textOr } from "./common.ts";

export const FEED = "hackernews";
const API = "https://hn.algolia.com/api/v1";
export const QUERIES = ["Claude Code", "agent skills", "MCP", "ffmpeg", "video editing", "drone", "marketing", "landing page", "SEO", "static site", "captions"];
export const POINTS_FLOOR = 40;
export const SHOW_HN_FLOOR = 60;

export interface HnHit {
  objectID: string;
  title: string;
  url?: string | null;
  points: number;
  num_comments?: number;
  created_at: string;
  created_at_i: number;
  author?: string;
  story_text?: string | null;
  _tags?: string[];
}

export function hnUrl(path: "search" | "search_by_date", params: Record<string, string>): string {
  return `${API}/${path}?${new URLSearchParams(params)}`;
}

/** Algolia matches comments and body text too, so the title or URL must itself be on-track. */
export const HN_RELEVANT = /\b(claude|agents?|agentic|skills?|mcp|ffmpeg|video|drone|dji|fpv|marketing|seo|landing pages?|websites?|static site|site builder|captions?|subtitles?|design system|ui kit|components?|figma|tiktok|youtube|shorts|reels|social media|ads|advertis\w*|newsletter|cold email|automation|workflows?|scrap(er|ing)|dataset|no-?code|cms)\b/i;

export function hnRule(h: HnHit): boolean {
  if (!HN_RELEVANT.test(`${h.title} ${h.url ?? ""}`)) return false;
  if (!h.title || /^(Ask HN|Tell HN|Poll):/i.test(h.title)) return false;
  if ((h._tags ?? []).includes("job")) return false;
  const floor = (h._tags ?? []).includes("show_hn") ? SHOW_HN_FLOOR : POINTS_FLOOR;
  if ((h.points ?? 0) < floor) return false;
  // Link-less posts only count when they are Show HN with a body.
  if (!h.url && !((h._tags ?? []).includes("show_hn") && h.story_text)) return false;
  return true;
}

const INSTRUCTIONS = `Items are popular Hacker News stories from the last week. Keep only concrete things David can use this week: a tool/CLI/library to adopt, an agent skill or Claude Code capability, a dataset, or a technique with concrete steps (ffmpeg, video, drone, site building, SEO/marketing, SMB automation).
Score below 20: news, opinion essays, funding/acquisition stories, model-benchmark races, politics/drama, launches of closed enterprise products, anything off his tracks.
Extra field for kept items: "kind": one of "tool", "skill", "technique", "dataset"; "install": only if the title/text states a command, else null.`;

export interface HnDeps { get?: <T>(url: string) => Promise<T>; now?: Date }

export function hnSpec(deps: HnDeps = {}): FeedSpec<HnHit> {
  const get = deps.get ?? (<T>(url: string) => fetchJson<T>(url, { timeoutMs: 20_000 }));
  return {
    name: FEED,
    sourceKind: "hn",
    instructions: INSTRUCTIONS,
    maxScore: 40,
    async collect(stats: FeedStats): Promise<Candidate<HnHit>[]> {
      const since = Math.floor(((deps.now ?? new Date()).getTime() - 7 * 86_400_000) / 1000);
      const hits = new Map<string, HnHit>();
      let seen = 0;
      const pull = async (url: string) => {
        try {
          const r = await get<{ hits?: HnHit[] }>(url);
          for (const h of r.hits ?? []) { seen++; if (!hits.has(h.objectID)) hits.set(h.objectID, h); }
        } catch (e) { stats.errors.push(`${url.slice(0, 90)}: ${e instanceof Error ? e.message : String(e)}`); }
      };
      for (const q of QUERIES) {
        await pull(hnUrl("search", { query: q, tags: "story", numericFilters: `created_at_i>${since},points>${POINTS_FLOOR}`, hitsPerPage: "30" }));
      }
      await pull(hnUrl("search_by_date", { tags: "show_hn", numericFilters: `created_at_i>${since},points>${SHOW_HN_FLOOR}`, hitsPerPage: "50" }));
      stats.seen = seen;
      return [...hits.values()].filter(hnRule).map((h) => ({
        ref: h.objectID,
        version: "1",
        prior: Math.log10(1 + h.points),
        brief: {
          title: h.title,
          url: h.url ?? undefined,
          points: h.points,
          comments: h.num_comments ?? 0,
          show_hn: (h._tags ?? []).includes("show_hn") || undefined,
          text: h.story_text ? clip(h.story_text.replace(/<[^>]+>/g, " "), 400) : undefined,
        },
        raw: h,
      }));
    },
    toAsset(c: Candidate<HnHit>, j: Judgment) {
      const h = c.raw;
      const kind = pickKind(j.kind, ["tool", "skill", "technique", "dataset"], "tool");
      const { track, tracks } = pickTrack(j, "ai-services");
      const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
      // Keep an install command only when the post itself states it.
      const install = j.install && `${h.title} ${h.story_text ?? ""}`.includes(j.install) ? j.install : undefined;
      const gh = (h.url ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+)/i)?.[1]?.replace(/\.git$/, "");
      return {
        asset: {
          kind,
          title: textOr(j.title, h.title.replace(/^Show HN:\s*/i, "")),
          url: h.url || discussion,
          summary: textOr(j.summary, h.title),
          track,
          tracks,
          value_score: j.score,
          value_reason: textOr(j.reason, "Popular on Hacker News and on-track."),
          next_action: textOr(j.next_action, "Read the post and try it."),
          effort: pickEffort(j.effort) ?? "S",
          published_at: h.created_at.slice(0, 10),
          extractor: "feed:hackernews:v1",
          details: {
            host: gh ? "github" : undefined,
            repo: gh ?? undefined,
            install,
            points: h.points,
            hn_discussion: discussion,
          },
        },
        source: { source_kind: "hn", source_ref: h.objectID, source_url: discussion, source_title: h.title, evidence: `${h.points} points, ${h.num_comments ?? 0} comments` },
      };
    },
  };
}

export const runHackerNews = (deps?: HnDeps) => runFeed(hnSpec(deps));
