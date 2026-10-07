/**
 * skills.sh search → `skill` assets, one per source repo.
 *
 * skills.sh indexes agent skills across agents with install counts. The feed
 * searches the track keywords, groups hits by source repo (a package usually
 * ships many skills), keeps packages with real install traction, and scores
 * each package once (re-scored only when it adds matching skills).
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchJson, pickEffort, pickTrack, runFeed, shortHash, textOr } from "./common.ts";

export const FEED = "skills-sh";
export const QUERIES = ["marketing", "seo", "copywriting", "ads", "email marketing", "brand", "landing page", "website", "web design", "video", "ffmpeg", "captions", "tiktok", "social media", "drone", "accessibility"];
/** Package traction floor; a package matching several track queries gets a lower bar. */
export const MIN_INSTALLS = 20_000;
export const MIN_INSTALLS_MULTI = 3_000;

export interface SkillHit { id: string; source: string; skillId: string; name: string; installs: number }
export interface SkillPackage { source: string; skills: SkillHit[]; installs: number; queries: string[] }

export function installCommand(source: string, skillId?: string): string {
  return `npx skills add https://github.com/${source}${skillId ? ` --skill ${skillId}` : ""}`;
}

/** Skill directory names already installed for Claude Code or other agents. */
export function installedSkills(dirs = [join(homedir(), ".claude/skills"), join(homedir(), ".agents/skills")]): Set<string> {
  const out = new Set<string>();
  for (const d of dirs) {
    try { for (const n of readdirSync(d)) out.add(n.toLowerCase()); } catch { /* missing dir */ }
  }
  return out;
}

/** Drop packages David already has: the top skill, or half the matched skills, installed. */
export function alreadyInstalled(p: SkillPackage, installed: Set<string>): boolean {
  if (!p.skills.length) return false;
  const have = p.skills.filter((s) => installed.has(s.skillId.toLowerCase())).length;
  return installed.has(p.skills[0].skillId.toLowerCase()) || have * 2 >= p.skills.length;
}

export function groupPackages(hitsByQuery: Record<string, SkillHit[]>): SkillPackage[] {
  const bySource = new Map<string, SkillPackage>();
  for (const [q, hits] of Object.entries(hitsByQuery)) {
    for (const h of hits) {
      if (!h?.source || !/^[\w.-]+\/[\w.-]+$/.test(h.source)) continue;
      let p = bySource.get(h.source);
      if (!p) { p = { source: h.source, skills: [], installs: 0, queries: [] }; bySource.set(h.source, p); }
      if (!p.skills.some((s) => s.id === h.id)) { p.skills.push(h); p.installs += h.installs ?? 0; }
      if (!p.queries.includes(q)) p.queries.push(q);
    }
  }
  for (const p of bySource.values()) p.skills.sort((a, b) => b.installs - a.installs);
  // Re-published copies of one package (same top skills under another owner): keep the most installed.
  const bySig = new Map<string, SkillPackage>();
  for (const p of bySource.values()) {
    const sig = p.skills.slice(0, 3).map((s) => s.skillId).sort().join(",");
    const cur = bySig.get(sig);
    if (!cur || p.installs > cur.installs) bySig.set(sig, p);
  }
  // Forks named like a popular package ("*/superpowers"): keep the most installed per repo name.
  const byName = new Map<string, SkillPackage>();
  for (const p of bySig.values()) {
    const name = p.source.split("/")[1].toLowerCase();
    const cur = byName.get(name);
    if (!cur || p.installs > cur.installs) byName.set(name, p);
  }
  return [...byName.values()];
}

const INSTRUCTIONS = `Items are agent-skill packages on skills.sh (a cross-agent skills index), with the matching skills and install counts. Keep packages David would install this week to run marketing, SEO, copywriting, ads, site building, design, video/ffmpeg, captions or social posting for himself or clients.
Score below 20: generic coding skills, framework docs, skills for tools he does not use, near-duplicates of widely known packages with nothing new, joke or empty skills.
Be harsh: these are popular packages, so popularity alone earns nothing. Expect most to score below 50; only packages that add a capability he clearly lacks (see his existing skills in the goals) reach 60+. Generic coding, cloud-vendor, framework or office-productivity packages score below 30.
Install counts are evidence of quality, not the goal; a smaller package that fits a track exactly can outrank a huge generic one.
Extra fields for kept items: "contents": one sentence naming the most useful skills in the package.`;

export interface SkillsDeps { get?: <T>(url: string) => Promise<T>; pauseMs?: number; installed?: Set<string> }

export function skillsSpec(deps: SkillsDeps = {}): FeedSpec<SkillPackage> {
  const get = deps.get ?? (<T>(url: string) => fetchJson<T>(url, { timeoutMs: 20_000 }));
  return {
    name: FEED,
    sourceKind: "skills-sh",
    instructions: INSTRUCTIONS,
    keepScore: 55,
    maxScore: 30,
    async collect(stats: FeedStats): Promise<Candidate<SkillPackage>[]> {
      const byQuery: Record<string, SkillHit[]> = {};
      let seen = 0;
      for (const q of QUERIES) {
        const url = `https://skills.sh/api/search?q=${encodeURIComponent(q)}`;
        // skills.sh answers 429 to bursts: pace requests and back off once.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await get<{ skills?: SkillHit[] }>(url);
            byQuery[q] = r.skills ?? [];
            seen += byQuery[q].length;
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt === 0 && /429/.test(msg)) { await Bun.sleep(deps.pauseMs ?? 15_000); continue; }
            stats.errors.push(`${q}: ${msg}`);
          }
        }
        await Bun.sleep(deps.pauseMs ?? 1500);
      }
      stats.seen = seen;
      const installed = deps.installed ?? installedSkills();
      const packages = groupPackages(byQuery);
      const owned = packages.filter((p) => alreadyInstalled(p, installed));
      if (owned.length) stats.notes.push(`already installed: ${owned.map((p) => p.source).join(", ")}`);
      return packages
        .filter((p) => !alreadyInstalled(p, installed))
        .filter((p) => p.installs >= MIN_INSTALLS || (p.queries.length >= 3 && p.installs >= MIN_INSTALLS_MULTI))
        .map((p) => ({
          ref: p.source.toLowerCase(),
          version: shortHash(p.skills.map((s) => s.skillId).sort().join(",")),
          prior: Math.log10(1 + p.installs) + p.queries.length * 0.3,
          brief: {
            package: p.source,
            total_installs: p.installs,
            matched_queries: p.queries,
            skills: p.skills.slice(0, 10).map((s) => `${s.skillId} (${s.installs})`),
          },
          raw: p,
        }));
    },
    toAsset(c: Candidate<SkillPackage>, j: Judgment) {
      const p = c.raw;
      const { track, tracks } = pickTrack(j, "marketing");
      const top = p.skills[0];
      return {
        asset: {
          kind: "skill",
          title: p.source,
          url: `https://github.com/${p.source}`,
          summary: textOr(j.summary, `Agent-skill package with ${p.skills.length} matching skills.`),
          track,
          tracks,
          value_score: j.score,
          value_reason: textOr(j.reason, "Popular skill package on a tracked topic."),
          next_action: textOr(j.next_action, `Install ${top?.skillId ?? "the top skill"} and try it on a real task.`),
          effort: pickEffort(j.effort) ?? "S",
          extractor: "feed:skills-sh:v1",
          details: {
            host: "skills.sh",
            repo: p.source,
            install: installCommand(p.source, p.skills.length === 1 ? top?.skillId : undefined),
            contents: j.contents || p.skills.slice(0, 6).map((s) => s.skillId).join(", "),
            skills: p.skills.slice(0, 15).map((s) => ({ id: s.skillId, installs: s.installs, install: installCommand(p.source, s.skillId) })),
            installs: p.installs,
          },
        },
        source: { source_kind: "skills-sh", source_ref: c.ref, source_url: `https://skills.sh/${p.source}`, source_title: p.source, evidence: `${p.installs} installs across ${p.skills.length} matching skills` },
      };
    },
  };
}

export const runSkillsSh = (deps?: SkillsDeps) => runFeed(skillsSpec(deps));
