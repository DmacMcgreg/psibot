/**
 * GitHub search → `skill` and `tool` assets.
 *
 * Topic searches (claude-skills, agent-skills, claude-code-plugin) plus
 * keyword searches for marketing automation, video-editing automation,
 * ffmpeg pipelines, site generators and drone video, all limited to repos
 * created in the last 7–14 days and sorted by stars (new + trending). Rules
 * keep repos with a star floor that are not forks or archived. Survivors get
 * their README fetched so the scorer sees what the repo does and the feed can
 * copy the install command the README states.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, daysAgo, fetchWithTimeout, isoDate, pickEffort, pickKind, pickTrack, runFeed, textOr } from "./common.ts";
import { getConfig } from "../../config.ts";

export const FEED = "github";

export interface GhQuery { q: string; days: number; minStars: number; skillish?: boolean }

export const QUERIES: GhQuery[] = [
  { q: "topic:claude-skills", days: 7, minStars: 20, skillish: true },
  { q: "topic:agent-skills", days: 7, minStars: 20, skillish: true },
  { q: "topic:claude-code-plugin", days: 7, minStars: 15, skillish: true },
  { q: "ffmpeg automation", days: 7, minStars: 10 },
  { q: "ffmpeg shorts OR reels OR tiktok", days: 14, minStars: 10 },
  { q: "video editing agent", days: 14, minStars: 15 },
  { q: "marketing automation agent", days: 7, minStars: 15 },
  { q: "social media automation", days: 7, minStars: 15 },
  { q: "website builder ai", days: 7, minStars: 15 },
  { q: "landing page generator", days: 14, minStars: 10 },
  { q: "static site generator", days: 14, minStars: 20 },
  { q: "drone video OR dji", days: 14, minStars: 10 },
];

export interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count?: number;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  created_at: string;
  pushed_at?: string;
  fork?: boolean;
  archived?: boolean;
  homepage?: string | null;
}

export interface GhItem { repo: GhRepo; queries: string[]; skillish: boolean; readme?: string; install?: string | null }

export function searchUrl(q: GhQuery, now = new Date()): string {
  const full = `${q.q} created:>${isoDate(daysAgo(q.days, now))}`;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(full)}&sort=stars&order=desc&per_page=30`;
}

/**
 * The install command a README states for this repo, most agent-specific first,
 * or null. Generic installers (pip, npm, brew, git clone…) count only when the
 * command names the repo itself, so dependency installs such as
 * `pip install -r requirements.txt` or `npm i -g ffmpeg-static` are ignored.
 */
export function extractInstall(readme: string, repoFullName?: string): string | null {
  const blocks = [...readme.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const inline = [...readme.matchAll(/`([^`\n]{6,160})`/g)].map((m) => m[1]);
  const lines = [...blocks.flatMap((b) => b.split("\n")), ...inline].map((l) => l.replace(/^\s*[$>]\s*/, "").trim()).filter((l) => l && l.length <= 200);
  const norm = (x: string) => x.toLowerCase().replace(/[-_.]/g, "");
  const [owner, name] = (repoFullName ?? "").split("/");
  const namesRepo = (l: string) => !repoFullName || norm(l).includes(norm(name ?? "")) || norm(l).includes(norm(`${owner}/${name}`));
  const agentSpecific = [
    /^npx\s+skills\s+add\s+\S+.*$/i,
    /^\/plugin\s+(marketplace\s+add|install)\s+\S+.*$/i,
    /^claude\s+(plugin|mcp)\s+(install|add|marketplace\s+add)\s+\S+.*$/i,
  ];
  const generic = [
    /^(uvx|pipx\s+install|pip3?\s+install|uv\s+tool\s+install)\s+(?!-r\b)\S+.*$/i,
    /^(npm\s+(i|install)\s+(-g\s+)?|bun\s+(add|install)\s+-g\s+|pnpm\s+add\s+-g\s+|npx\s+(-y\s+)?)\S+.*$/i,
    /^(brew\s+install|cargo\s+install|go\s+install)\s+\S+.*$/i,
    /^git\s+clone\s+\S+.*$/i,
  ];
  for (const p of agentSpecific) {
    const hit = lines.find((l) => p.test(l) && namesRepo(l));
    if (hit) return hit;
  }
  for (const p of generic) {
    const hit = lines.find((l) => p.test(l) && namesRepo(l) && !/requirements\.txt|\s-r\s/.test(l));
    if (hit) return hit;
  }
  return null;
}

export function readmeText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<img[^>]*>/gi, " ")
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const INSTRUCTIONS = `Items are new GitHub repos (created in the last 1–2 weeks), with star counts and a README excerpt. Keep ones David would actually install or copy this week for his tracks: agent skills and Claude Code plugins for marketing, SEO, copywriting, design, site building, video/ffmpeg editing, social posting; CLIs that automate video editing, captioning, short-form clipping or drone footage; site generators and landing-page tooling usable for client sites; SMB automation he can resell.
Score below 20: awesome-lists and link dumps with no code (unless exceptionally on-track), toy demos, crypto/trading bots, course homework, generic "AI agent framework" clones, repos whose README is empty or only marketing copy, anything he already has an equivalent of (generic Claude Code wrappers).
Be harsh: these repos already passed a topic filter, so expect only about a third to deserve 50+. Generic developer-productivity skills (React/TypeScript guidance, code review, token savers, career/job-hunt, prompt routers) score below 40 unless they directly produce client deliverables.
Star count is evidence, not the goal: a 30-star skill that fits exactly beats a 900-star generic one.
Extra fields for kept items: "kind": "skill" (installable agent skill/plugin package) or "tool" (app, CLI, library, service); "install": the exact install command the README states, else null (never invent one).`;

export interface GithubDeps {
  get?: (url: string, accept?: string) => Promise<Response>;
  now?: Date;
  token?: string;
}

export function githubSpec(deps: GithubDeps = {}): FeedSpec<GhItem> {
  const token = deps.token ?? getConfig().GITHUB_TOKEN;
  const get = deps.get ?? ((url: string, accept = "application/vnd.github+json") =>
    fetchWithTimeout(url, { timeoutMs: 30_000, headers: { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }));
  return {
    name: FEED,
    sourceKind: "github-search",
    instructions: INSTRUCTIONS,
    keepScore: 50,
    maxScore: token ? 45 : 15,
    async collect(stats: FeedStats): Promise<Candidate<GhItem>[]> {
      const items = new Map<string, GhItem>();
      let seen = 0;
      for (const q of QUERIES) {
        try {
          const res = await get(searchUrl(q, deps.now));
          if (res.status === 403 || res.status === 429) { stats.errors.push(`rate limited on "${q.q}"`); break; }
          if (!res.ok) { stats.errors.push(`HTTP ${res.status} on "${q.q}"`); continue; }
          const body = (await res.json()) as { items?: GhRepo[] };
          for (const repo of body.items ?? []) {
            seen++;
            if (repo.fork || repo.archived || repo.stargazers_count < q.minStars) continue;
            const key = repo.full_name.toLowerCase();
            const cur = items.get(key);
            if (cur) { cur.queries.push(q.q); cur.skillish ||= !!q.skillish; }
            else items.set(key, { repo, queries: [q.q], skillish: !!q.skillish });
          }
        } catch (e) {
          stats.errors.push(`"${q.q}": ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!token) await Bun.sleep(6500); // anonymous search: 10 requests per minute
      }
      stats.seen = seen;
      return [...items.values()].map((it) => ({
        ref: it.repo.full_name.toLowerCase(),
        version: "1",
        prior: Math.log10(1 + it.repo.stargazers_count) + (it.skillish ? 1 : 0),
        brief: {
          repo: it.repo.full_name,
          stars: it.repo.stargazers_count,
          created: it.repo.created_at.slice(0, 10),
          language: it.repo.language ?? undefined,
          topics: (it.repo.topics ?? []).slice(0, 8),
          description: clip(it.repo.description, 240),
          matched: it.queries,
        },
        raw: it,
      }));
    },
    async enrich(c: Candidate<GhItem>) {
      const res = await get(`https://api.github.com/repos/${c.raw.repo.full_name}/readme`, "application/vnd.github.raw+json");
      if (!res.ok) return;
      const md = await res.text();
      c.raw.readme = md;
      c.raw.install = extractInstall(md, c.raw.repo.full_name);
      c.brief.readme = clip(readmeText(md), 1200);
      if (c.raw.install) c.brief.install_found = c.raw.install;
    },
    toAsset(c: Candidate<GhItem>, j: Judgment) {
      const { repo, skillish, install } = c.raw;
      const kind = pickKind(j.kind, ["skill", "tool"], skillish ? "skill" : "tool");
      const { track, tracks } = pickTrack(j, kind === "skill" ? "ai-services" : "client-sites");
      // Only a command the README states; the model's guess is ignored unless the README contains it.
      const stated = install ?? (j.install && c.raw.readme?.includes(j.install) ? j.install : null);
      return {
        asset: {
          kind,
          title: repo.full_name,
          url: repo.html_url,
          summary: textOr(j.summary, clip(repo.description, 240)),
          track,
          tracks,
          value_score: j.score,
          value_reason: textOr(j.reason, clip(repo.description, 200) || "New repo on a tracked topic."),
          next_action: textOr(j.next_action, "Read the README and try it on a real task."),
          effort: pickEffort(j.effort) ?? "S",
          published_at: repo.created_at.slice(0, 10),
          extractor: "feed:github:v1",
          details: {
            host: "github",
            repo: repo.full_name,
            install: stated ?? undefined,
            license: repo.license?.spdx_id ?? undefined,
            stars: repo.stargazers_count,
            language: repo.language ?? undefined,
            topics: repo.topics ?? [],
            homepage: repo.homepage || undefined,
          },
        },
        source: { source_kind: "github-search", source_ref: repo.full_name.toLowerCase(), source_url: repo.html_url, source_title: repo.full_name, evidence: c.raw.queries.join(" | ") },
      };
    },
  };
}

export const runGithub = (deps?: GithubDeps) => runFeed(githubSpec(deps));
