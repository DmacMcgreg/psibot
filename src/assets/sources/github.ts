/**
 * GitHub repo text for the extractor. Page text of a GitHub repo is navigation
 * chrome, so this reads the repo metadata and README through the REST API,
 * authenticated with GITHUB_TOKEN the same way src/capture/github.ts is.
 */

import { getConfig } from "../../config.ts";

const README_CHARS = 16_000;

/** "owner/repo" for a github.com repo URL (root or deeper), else null. */
export function repoFromUrl(url: string | null): string | null {
  const m = (url ?? "").match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) return null;
  const owner = m[1];
  if (["orgs", "users", "settings", "notifications", "topics", "trending", "marketplace", "sponsors", "features", "apps", "login", "search", "explore", "collections"].includes(owner.toLowerCase())) return null;
  return `${owner}/${m[2].replace(/\.git$/, "")}`;
}

function headers(accept: string): Record<string, string> {
  const token = getConfig().GITHUB_TOKEN;
  return {
    Accept: accept,
    "User-Agent": "PsiBot/2.0",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

interface RepoMeta {
  full_name: string;
  description: string | null;
  homepage: string | null;
  stargazers_count: number;
  language: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null } | null;
  pushed_at?: string;
  archived?: boolean;
}

/** Strip badge rows, HTML tags and image-only lines that waste model context. */
export function cleanReadme(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*(\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)\s*)+$/gm, "")
    .replace(/^\s*(!\[[^\]]*\]\([^)]*\)\s*)+$/gm, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<\/?(p|div|picture|source|br|a|h\d|sup|sub|details|summary|table|tr|td|th)[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Repo facts plus README, or null when the API call fails. */
export async function fetchRepoText(repo: string): Promise<string | null> {
  try {
    const metaRes = await fetch(`https://api.github.com/repos/${repo}`, { headers: headers("application/vnd.github+json"), signal: AbortSignal.timeout(20_000) });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as RepoMeta;
    const readmeRes = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: headers("application/vnd.github.raw+json"), signal: AbortSignal.timeout(20_000) });
    const readme = readmeRes.ok ? cleanReadme(await readmeRes.text()).slice(0, README_CHARS) : "";
    const facts = [
      `Repo: https://github.com/${meta.full_name}`,
      meta.description ? `Description: ${meta.description}` : "",
      meta.homepage ? `Homepage: ${meta.homepage}` : "",
      `Stars: ${meta.stargazers_count}`,
      meta.language ? `Language: ${meta.language}` : "",
      meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION" ? `License: ${meta.license.spdx_id}` : "",
      meta.topics?.length ? `Topics: ${meta.topics.join(", ")}` : "",
      meta.pushed_at ? `Last push: ${meta.pushed_at.slice(0, 10)}` : "",
      meta.archived ? "Archived: yes" : "",
    ].filter(Boolean);
    return `${facts.join("\n")}\n\nREADME:\n${readme || "(no README)"}`;
  } catch {
    return null;
  }
}
