/**
 * Kaggle dataset listings → `dataset` assets.
 *
 * Anonymous listing API, newest first, one request per track keyword. Rules
 * keep datasets updated in the last 21 days with a usable card (Kaggle's
 * usability rating), on-track titles, and drop synthetic/simulated tables and
 * news-article scrapes. Downloading needs a Kaggle key, which "Get" handles.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, daysAgo, fetchJson, humanBytes, pickEffort, pickTrack, runFeed, textOr } from "./common.ts";

export const FEED = "kaggle";
export const QUERIES = ["tiktok", "instagram", "youtube", "social media", "marketing", "advertising", "ads", "drone", "aerial", "landing page", "ui screenshots", "captions", "short form video", "ecommerce"];

export interface KaggleDataset {
  ref: string;
  title: string;
  subtitle?: string;
  url: string;
  lastUpdated: string;
  downloadCount?: number;
  voteCount?: number;
  usabilityRating?: number;
  totalBytes?: number;
  licenseName?: string;
  description?: string;
}

export const RELEVANT = /(tik ?tok|instagram|youtube|shorts|reels|social[- ]?media|influencer|marketing|advertis|\bads?\b|campaign|ctr|conversion|e-?commerce|drone|\buav\b|aerial|landing page|\bui\b|screenshot|caption|subtitle|video|thumbnail|engagement|brand|seo)/i;
const EXCLUDE = /(synthetic|simulated|fake|mock|generated data|survey of students|homework|assignment)/i;

export function kaggleRule(d: KaggleDataset, since: string): { pass: boolean; why?: string } {
  if ((d.lastUpdated ?? "") < since) return { pass: false, why: "old" };
  const text = `${d.title} ${d.subtitle ?? ""}`;
  if (EXCLUDE.test(text)) return { pass: false, why: "synthetic" };
  if ((d.usabilityRating ?? 0) < 0.55) return { pass: false, why: "low usability" };
  if ((d.totalBytes ?? 0) < 20_000) return { pass: false, why: "tiny" };
  if (!RELEVANT.test(text)) return { pass: false, why: "off-track" };
  return { pass: true };
}

const INSTRUCTIONS = `Items are recently updated Kaggle datasets. Keep only datasets David could use for his tracks: real (not synthetic) social-post, ad, marketing, e-commerce, short-form-video, caption, UI/screenshot or drone/aerial data with enough rows to train, benchmark or analyse something useful for marketing skills or clients.
Score below 20: synthetic or simulated tables, student projects, health/psychology surveys about social media use, news-article scrapes, tiny samples, unclear or missing licences for anything he would use commercially (cap those at 50).
Extra field for kept items: "contents" (one sentence: what the rows/files are, with counts if stated).`;

export interface KaggleDeps { get?: <T>(url: string) => Promise<T>; now?: Date }

export function kaggleSpec(deps: KaggleDeps = {}): FeedSpec<KaggleDataset> {
  const get = deps.get ?? (<T>(url: string) => fetchJson<T>(url, { timeoutMs: 20_000 }));
  return {
    name: FEED,
    sourceKind: "kaggle",
    instructions: INSTRUCTIONS,
    keepScore: 50,
    maxScore: 30,
    async collect(stats: FeedStats): Promise<Candidate<KaggleDataset>[]> {
      const since = daysAgo(21, deps.now).toISOString();
      const found = new Map<string, KaggleDataset>();
      let seen = 0;
      for (const q of QUERIES) {
        try {
          const list = await get<KaggleDataset[]>(`https://www.kaggle.com/api/v1/datasets/list?search=${encodeURIComponent(q)}&sortBy=published&page=1`);
          for (const d of list ?? []) { seen++; if (d?.ref && !found.has(d.ref)) found.set(d.ref, d); }
        } catch (e) { stats.errors.push(`${q}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      stats.seen = seen;
      const why: Record<string, number> = {};
      const out: Candidate<KaggleDataset>[] = [];
      for (const d of found.values()) {
        const v = kaggleRule(d, since);
        if (!v.pass) { why[v.why!] = (why[v.why!] ?? 0) + 1; continue; }
        out.push({
          ref: d.ref,
          version: "1",
          prior: Math.log10(1 + (d.downloadCount ?? 0)) + Math.log10(1 + (d.voteCount ?? 0)),
          brief: {
            ref: d.ref,
            title: d.title,
            subtitle: d.subtitle || undefined,
            updated: d.lastUpdated.slice(0, 10),
            downloads: d.downloadCount ?? 0,
            votes: d.voteCount ?? 0,
            usability: d.usabilityRating,
            size: humanBytes(d.totalBytes),
            license: d.licenseName,
            description: d.description ? clip(d.description, 500) : undefined,
          },
          raw: d,
        });
      }
      // Some accounts publish dozens of near-identical scrapes: keep each owner's best two.
      const perOwner = new Map<string, number>();
      const capped = out.sort((a, b) => (b.prior ?? 0) - (a.prior ?? 0)).filter((c) => {
        const owner = c.ref.split("/")[0];
        const n = (perOwner.get(owner) ?? 0) + 1;
        perOwner.set(owner, n);
        return n <= 2;
      });
      if (capped.length < out.length) why["owner cap"] = out.length - capped.length;
      stats.notes.push(`rule drops: ${JSON.stringify(why)}`);
      return capped;
    },
    toAsset(c: Candidate<KaggleDataset>, j: Judgment) {
      const d = c.raw;
      const { track, tracks } = pickTrack(j, "data");
      return {
        asset: {
          kind: "dataset",
          title: d.title,
          url: d.url || `https://www.kaggle.com/datasets/${d.ref}`,
          summary: textOr(j.summary, textOr(d.subtitle, d.title)),
          track,
          tracks,
          value_score: j.score,
          value_reason: textOr(j.reason, "Dataset relevant to the data track."),
          next_action: textOr(j.next_action, "Open the dataset page and inspect the columns."),
          effort: pickEffort(j.effort) ?? "S",
          published_at: d.lastUpdated.slice(0, 10),
          extractor: "feed:kaggle:v1",
          // No repo_id here: assetKey treats repo_id as a Hugging Face id.
          details: {
            host: "kaggle",
            kaggle_ref: d.ref,
            license: d.licenseName,
            size: humanBytes(d.totalBytes),
            contents: j.contents || d.subtitle || undefined,
            downloads: d.downloadCount ?? 0,
          },
        },
        source: { source_kind: "kaggle", source_ref: d.ref, source_url: d.url, source_title: d.title },
      };
    },
  };
}

export const runKaggle = (deps?: KaggleDeps) => runFeed(kaggleSpec(deps));
