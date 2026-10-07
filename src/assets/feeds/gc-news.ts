/**
 * Government of Canada news API → `opportunity` assets for calls for
 * proposals, program launches and intakes.
 *
 * Rules: a 7-day window of news releases, kept when the title or teaser reads
 * like an intake ("call for proposals", "applications open", "launches … fund")
 * or like funding aimed at small business, innovation or digital adoption.
 * Survivors get their article text fetched (for deadline, amount, eligibility)
 * and go to the scorer.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, daysAgo, fetchJson, fetchText, isoDate, pickEffort, pickTrack, runFeed, stripHtml, textOr, toIsoDate } from "./common.ts";

export const FEED = "gc-news";

export interface GcNewsEntry { title: string; link: string; teaser: string; publishedDate: string }

export const INTAKE = /(call for (proposals|applications|submissions|projects)|applications? (are |is )?(now )?open|accepting applications|now accepting|\bintake\b|funding opportunit|launch(es|ed)? .{0,60}\b(fund|program|programme|initiative|challenge|call|stream)\b|now open|open call|expressions? of interest|apply (now|by|before|for funding)|request for proposals|opens? applications|new funding stream)/i;
export const FUNDING = /\b(funding|fund|grant|contribution|investment)\b/i;
export const SMB = /\b(small (and medium-sized )?business(es)?|SMEs?|entrepreneur\w*|start-?ups?|digital (adoption|transformation|skills)|artificial intelligence|\bAI\b|innovation|tech(nology)? (firms?|companies|sector)|export\w*|marketing|tourism|creative industr\w*|cultural sector|Ottawa|eastern Ontario|FedDev|IRAP|CanExport)\b/i;
/** News that is never an opportunity for David. */
export const NEWS_EXCLUDE = /\b(meets with|statement by|joint statement|condolences|anniversary|sanctions|appoint\w*|nominat\w*|minister .* to (travel|visit)|delegation to|recall|advisory: |media advisory|weather|wildfire|flood|military|defence procurement)\b/i;

export function gcNewsRule(e: GcNewsEntry): { pass: boolean; prior: number } {
  const t = `${e.title} ${e.teaser}`;
  if (NEWS_EXCLUDE.test(e.title)) return { pass: false, prior: 0 };
  if (INTAKE.test(t)) return { pass: true, prior: 2 };
  if (FUNDING.test(t) && SMB.test(t)) return { pass: true, prior: 1 };
  return { pass: false, prior: 0 };
}

export function newsUrl(since: Date): string {
  return `https://api.io.canada.ca/io-server/gc/news/en/v2?sort=publishedDate&orderBy=desc&publishedDate%3E=${isoDate(since)}&pick=200&format=json`;
}

/** Main text of a canada.ca news release, trimmed. */
export function articleText(html: string): string {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  return stripHtml(main.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " "));
}

const INSTRUCTIONS = `Items are Government of Canada news releases that mention an intake, a call for proposals or new funding.
Keep only real, still-open opportunities that David's tiny Ottawa AI/web/marketing/video consultancy (Cloud Nexus) could apply to, or that fund his likely clients (Canadian small businesses, non-profits, Ottawa/eastern Ontario organisations) to buy digital, web, marketing, video, AI or training services.
Score below 20: announcements of money already awarded to named recipients, programs only for Indigenous governments, provinces, municipalities' infrastructure, farmers, fishers, health providers, housing, research universities, or calls to join delegations/committees; anything already closed.
Extra fields for kept items: "opportunity_type" ("grant", "program" or "rfp"), "deadline" (ISO date if the text states one, else null), "amount" (only if stated), "eligibility" (one sentence: who can apply).`;

export interface GcNewsDeps {
  fetchFeed?: (url: string) => Promise<{ feed?: { entry?: GcNewsEntry[] } }>;
  fetchArticle?: (url: string) => Promise<string>;
  now?: Date;
}

interface GcCandidate { entry: GcNewsEntry; text: string }

export function gcNewsSpec(deps: GcNewsDeps = {}): FeedSpec<GcCandidate> {
  const fetchFeed = deps.fetchFeed ?? ((u: string) => fetchJson<{ feed?: { entry?: GcNewsEntry[] } }>(u, { timeoutMs: 45_000 }));
  const fetchArticle = deps.fetchArticle ?? ((u: string) => fetchText(u, { timeoutMs: 30_000, retries: 0 }));
  return {
    name: FEED,
    sourceKind: "gc-news",
    instructions: INSTRUCTIONS,
    maxScore: 30,
    async collect(stats: FeedStats): Promise<Candidate<GcCandidate>[]> {
      const data = await fetchFeed(newsUrl(daysAgo(7, deps.now)));
      const entries = data.feed?.entry ?? [];
      stats.seen = entries.length;
      const seen = new Set<string>();
      const out: Candidate<GcCandidate>[] = [];
      for (const e of entries) {
        if (!e?.link || seen.has(e.link)) continue;
        seen.add(e.link);
        const v = gcNewsRule(e);
        if (!v.pass) continue;
        out.push({
          ref: e.link,
          version: "1",
          prior: v.prior,
          brief: {
            title: e.title,
            published: e.publishedDate.slice(0, 10),
            department: e.link.match(/canada\.ca\/en\/([^/]+)/)?.[1],
            text: clip(e.teaser, 1800),
          },
          raw: { entry: e, text: "" },
        });
      }
      return out;
    },
    async enrich(c: Candidate<GcCandidate>) {
      const text = articleText(await fetchArticle(c.raw.entry.link));
      if (text) { c.raw.text = text; c.brief.text = clip(text, 1800); }
    },
    toAsset(c: Candidate<GcCandidate>, j: Judgment) {
      const e = c.raw.entry;
      const { track, tracks } = pickTrack(j, "bids");
      const type = j.opportunity_type === "program" || j.opportunity_type === "rfp" ? j.opportunity_type : "grant";
      const dept = e.link.match(/canada\.ca\/en\/([^/]+)/)?.[1]?.replace(/-/g, " ");
      return {
        asset: {
          kind: "opportunity",
          title: textOr(j.title, e.title),
          url: e.link,
          summary: textOr(j.summary, clip(e.teaser, 240)),
          track,
          tracks: [...new Set([...tracks, "bids"])],
          value_score: j.score,
          value_reason: textOr(j.reason, "Federal intake relevant to the bids track."),
          next_action: textOr(j.next_action, "Open the release, check eligibility and the deadline."),
          effort: pickEffort(j.effort) ?? "M",
          deadline: toIsoDate(j.deadline),
          amount: j.amount || null,
          published_at: e.publishedDate.slice(0, 10),
          extractor: "feed:gc-news:v1",
          details: {
            opportunity_type: type,
            org: dept ? `Government of Canada (${dept})` : "Government of Canada",
            eligibility: j.eligibility || undefined,
            region: "Canada",
          },
        },
        source: { source_kind: "gc-news", source_ref: e.link, source_url: e.link, source_title: e.title, evidence: clip(e.teaser, 280) },
      };
    },
  };
}

export const runGcNews = (deps?: GcNewsDeps) => runFeed(gcNewsSpec(deps));
