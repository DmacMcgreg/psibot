/**
 * Hugging Face datasets → `dataset` assets.
 *
 * Pulls newly created datasets per track keyword, the overall trending list
 * and trending video datasets. Rules drop spam and empty repos (no card, no
 * downloads), robotics/LeRobot episode dumps, and anything whose id, tags or
 * card never mention a track keyword. Survivors are scored with their card
 * description, licence and size.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, daysAgo, fetchJson, humanBytes, pickEffort, pickTrack, runFeed, textOr } from "./common.ts";

export const FEED = "huggingface";
const API = "https://huggingface.co/api";
export const KEYWORDS = [
  "tiktok", "instagram", "youtube", "shorts", "reels", "ads", "advertising", "marketing", "social-media", "social media",
  "captions", "video", "drone", "aerial", "ui", "screenshots", "landing page", "website", "copywriting",
];
const EXPAND = ["cardData", "description", "downloads", "likes", "tags", "createdAt", "lastModified", "mainSize", "trendingScore"]
  .map((e) => `expand[]=${e}`).join("&");

/** On-track vocabulary. "video" alone is too broad (robotics, egocentric, world models), see VIDEO_CRAFT. */
export const RELEVANT = /(tik ?tok|instagram|youtube|\bshorts\b|\breels?\b|\bads\b|advertis|marketing|social[- ]?media|influencer|\bui\b|\bgui\b|screenshot|web ?page|website|landing[- ]?page|copywrit|e-?commerce|\bbrand|thumbnail|engagement|\bdrone|\buav\b|aerial)/i;
export const VIDEO_CRAFT = /\bvideo\b[\s\S]{0,80}(edit|short[- ]?form|caption|subtitle|highlight|clip|b-?roll|cinemat|colou?r[- ]?grad|transition|montage|trailer|promo)|(edit|short[- ]?form|caption|subtitle|highlight|b-?roll|cinemat|trailer|promo)[\s\S]{0,80}\bvideo\b/i;
const NOISE = /(lerobot|robotics|so10[01]|episode_|_\d{8}_\d{6}|test[-_]?dataset|unofficial mirror|^.*\/(test|tmp|demo)\d*$)/i;

export interface HfDataset {
  id: string;
  createdAt?: string;
  lastModified?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  description?: string;
  mainSize?: number;
  trendingScore?: number;
  cardData?: {
    license?: string | string[];
    license_name?: string;
    pretty_name?: string;
    size_categories?: string[];
    task_categories?: string[];
    tags?: string[];
  };
}

export interface HfTrendingItem { repoData?: { id: string; downloads?: number; likes?: number; lastModified?: string; datasetsServerInfo?: { numRows?: number; modalities?: string[] } } }

export function licenseOf(d: HfDataset): string | undefined {
  const l = d.cardData?.license;
  const s = Array.isArray(l) ? l.join(", ") : l;
  if (s === "other" && d.cardData?.license_name) return `other (${d.cardData.license_name})`;
  return s ?? d.tags?.find((t) => t.startsWith("license:"))?.slice(8);
}

export function sizeOf(d: HfDataset): string | undefined {
  const cat = d.cardData?.size_categories?.[0] ?? d.tags?.find((t) => t.startsWith("size_categories:"))?.slice(15);
  const bytes = humanBytes(d.mainSize);
  return [cat ? `${cat} rows` : null, bytes].filter(Boolean).join(", ") || undefined;
}

export function cleanDescription(s: string | undefined): string {
  return (s ?? "").replace(/See the full description on the dataset page:.*$/s, "").replace(/\s+/g, " ").trim();
}

/** Rules: not spam, some substance, and on-track. `trending` items skip the novelty requirement. */
export function hfRule(d: HfDataset, opts: { since: string; trending?: boolean }): { pass: boolean; prior: number; why?: string } {
  if (NOISE.test(d.id)) return { pass: false, prior: 0, why: "noise" };
  const tags = d.tags ?? [];
  if (tags.some((t) => /^(task_categories:robotics|library:lerobot)$/i.test(t))) return { pass: false, prior: 0, why: "robotics" };
  const desc = cleanDescription(d.description);
  const substantive = desc.length >= 80 || !!d.cardData?.pretty_name || (d.cardData?.task_categories?.length ?? 0) > 0;
  const traction = (d.downloads ?? 0) >= 10 || (d.likes ?? 0) >= 1;
  if (!substantive) return { pass: false, prior: 0, why: "empty card" };
  if (!opts.trending && !traction && desc.length < 200) return { pass: false, prior: 0, why: "no traction" };
  if (!opts.trending && (d.createdAt ?? "") < opts.since) return { pass: false, prior: 0, why: "old" };
  if (NOISE.test(d.cardData?.pretty_name ?? "") || /mirror of /i.test(desc.slice(0, 200))) return { pass: false, prior: 0, why: "mirror" };
  // Match on the repo name, not the author (an author called "dronefreak" is not a drone dataset).
  const name = d.id.split("/").pop() ?? d.id;
  const hay = `${name} ${d.cardData?.pretty_name ?? ""} ${tags.filter((t) => !t.includes(":")).join(" ")} ${(d.cardData?.tags ?? []).join(" ")} ${desc.slice(0, 600)}`;
  if (!RELEVANT.test(hay) && !VIDEO_CRAFT.test(hay)) return { pass: false, prior: 0, why: "off-track" };
  // On-track names first; popularity breaks ties.
  const named = RELEVANT.test(`${name} ${d.cardData?.pretty_name ?? ""}`) ? 3 : 0;
  const prior = named + Math.log10(1 + (d.downloads ?? 0)) + 2 * Math.log10(1 + (d.likes ?? 0));
  return { pass: true, prior };
}

const INSTRUCTIONS = `Items are Hugging Face datasets. Keep only datasets David could actually download and use for his tracks: training or evaluating marketing/copy/ad models, short-form video and caption work, social-post analysis, UI/landing-page/screenshot corpora for design reproduction, drone/aerial footage. Licence matters: note non-commercial or research-only licences in the reason and cap those at 60.
Score below 20: robotics episodes, generic LLM reasoning/RL/math/code corpora, academic benchmarks unrelated to his tracks, tiny or undocumented dumps, personal test uploads, mirrors of something he could not legally use.
Track is usually "data"; add others that fit (e.g. "social", "video", "client-sites", "marketing").
Extra field for kept items: "contents" (one sentence: what the rows/files actually are, with counts if stated).`;

export interface HfDeps { get?: <T>(url: string) => Promise<T>; now?: Date }

export function hfSpec(deps: HfDeps = {}): FeedSpec<HfDataset> {
  const get = deps.get ?? (<T>(url: string) => fetchJson<T>(url, { timeoutMs: 30_000 }));
  return {
    name: FEED,
    sourceKind: "hf",
    instructions: INSTRUCTIONS,
    keepScore: 50,
    maxScore: 45,
    async collect(stats: FeedStats): Promise<Candidate<HfDataset>[]> {
      const since = daysAgo(21, deps.now).toISOString();
      const found = new Map<string, { d: HfDataset; trending: boolean }>();
      const errors: string[] = [];
      for (const kw of KEYWORDS) {
        try {
          const list = await get<HfDataset[]>(`${API}/datasets?search=${encodeURIComponent(kw)}&sort=createdAt&direction=-1&limit=50&${EXPAND}`);
          for (const d of list) if (!found.has(d.id)) found.set(d.id, { d, trending: false });
        } catch (e) { errors.push(`${kw}: ${String(e)}`); }
      }
      // Trending: overall list (ids only) plus video-modality trending with full fields.
      try {
        const video = await get<HfDataset[]>(`${API}/datasets?filter=modality:video&sort=trendingScore&direction=-1&limit=30&${EXPAND}`);
        for (const d of video) found.set(d.id, { d, trending: true });
      } catch (e) { errors.push(`video trending: ${String(e)}`); }
      try {
        const tr = await get<{ recentlyTrending?: HfTrendingItem[] }>(`${API}/trending?type=dataset&limit=20`);
        const ids = (tr.recentlyTrending ?? []).map((t) => t.repoData?.id).filter((x): x is string => !!x && !found.has(x));
        for (const id of ids) {
          try {
            const d = await get<HfDataset>(`${API}/datasets/${id}?${EXPAND}`);
            found.set(d.id, { d, trending: true });
          } catch { /* skip one */ }
        }
      } catch (e) { errors.push(`trending: ${String(e)}`); }
      if (errors.length) stats.notes.push(`fetch errors: ${errors.slice(0, 3).join("; ")}`);
      if (found.size === 0 && errors.length) throw new Error(`all Hugging Face requests failed: ${errors[0]}`);
      stats.seen = found.size;
      const why: Record<string, number> = {};
      const out: Candidate<HfDataset>[] = [];
      for (const { d, trending } of found.values()) {
        const v = hfRule(d, { since, trending });
        if (!v.pass) { why[v.why!] = (why[v.why!] ?? 0) + 1; continue; }
        out.push({
          ref: d.id,
          version: "1",
          prior: v.prior,
          brief: {
            id: d.id,
            name: d.cardData?.pretty_name ?? undefined,
            created: d.createdAt?.slice(0, 10),
            downloads: d.downloads ?? 0,
            likes: d.likes ?? 0,
            trending,
            license: licenseOf(d),
            size: sizeOf(d),
            tasks: d.cardData?.task_categories?.slice(0, 4),
            tags: (d.cardData?.tags ?? []).slice(0, 8),
            description: clip(cleanDescription(d.description), 700),
          },
          raw: d,
        });
      }
      // Re-uploads of one dataset under many accounts: keep the most-downloaded copy.
      const best = new Map<string, Candidate<HfDataset>>();
      for (const c of out) {
        const k = (c.raw.cardData?.pretty_name ?? c.raw.id.split("/").pop() ?? c.raw.id).toLowerCase();
        const cur = best.get(k);
        if (!cur || (c.raw.downloads ?? 0) > (cur.raw.downloads ?? 0)) best.set(k, c);
      }
      if (best.size < out.length) why["duplicate upload"] = out.length - best.size;
      stats.notes.push(`rule drops: ${JSON.stringify(why)}`);
      return [...best.values()];
    },
    toAsset(c: Candidate<HfDataset>, j: Judgment) {
      const d = c.raw;
      const { track, tracks } = pickTrack(j, "data");
      const license = licenseOf(d);
      return {
        asset: {
          kind: "dataset",
          title: textOr(d.cardData?.pretty_name, d.id),
          url: `https://huggingface.co/datasets/${d.id}`,
          summary: textOr(j.summary, clip(cleanDescription(d.description), 240)),
          track,
          tracks,
          value_score: license && /nc|non-?commercial|research/i.test(license) ? Math.min(j.score, 60) : j.score,
          value_reason: textOr(j.reason, "Dataset relevant to the data track."),
          next_action: textOr(j.next_action, "Open the dataset card and pull a sample split."),
          effort: pickEffort(j.effort) ?? "S",
          published_at: d.createdAt?.slice(0, 10) ?? null,
          extractor: "feed:huggingface:v1",
          details: {
            host: "huggingface",
            repo_id: d.id,
            license,
            size: sizeOf(d),
            contents: j.contents || clip(cleanDescription(d.description), 200) || undefined,
            downloads: d.downloads ?? 0,
            likes: d.likes ?? 0,
          },
        },
        source: { source_kind: "hf", source_ref: d.id, source_url: `https://huggingface.co/datasets/${d.id}`, source_title: d.id },
      };
    },
  };
}

export const runHuggingFace = (deps?: HfDeps) => runFeed(hfSpec(deps));
