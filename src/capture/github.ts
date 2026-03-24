import { getConfig } from "../config.ts";
import { insertPendingItem, getPendingItemByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("capture:github");

interface GitHubStarredRepo {
  starred_at: string;
  repo: {
    html_url: string;
    full_name: string;
    description: string | null;
    language: string | null;
    stargazers_count: number;
  };
}

export async function pollGithubStars(): Promise<number> {
  const config = getConfig();
  const { GITHUB_TOKEN } = config;

  if (!GITHUB_TOKEN) {
    log.warn("GITHUB_TOKEN not set, skipping GitHub poll");
    return 0;
  }

  let captured = 0;
  const maxPages = 3;

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/user/starred?per_page=100&page=${page}&sort=created&direction=desc`;

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3.star+json",
          "User-Agent": "PsiBot/2.0",
        },
      });

      if (!res.ok) {
        log.error("GitHub API error", { status: res.status, page });
        break;
      }

      const stars = (await res.json()) as GitHubStarredRepo[];

      if (stars.length === 0) break;

      for (const star of stars) {
        const { repo } = star;

        const existing = getPendingItemByUrl(repo.html_url);
        if (existing) continue;

        const titleParts = [repo.full_name];
        if (repo.description) titleParts.push(repo.description);
        const title = titleParts.join(": ");

        const descParts: string[] = [];
        if (repo.description) descParts.push(repo.description);
        if (repo.language) descParts.push(`Language: ${repo.language}`);
        descParts.push(`Stars: ${repo.stargazers_count}`);
        const description = descParts.join(" | ");

        insertPendingItem({
          url: repo.html_url,
          title,
          description,
          source: "github",
          platform: "github",
          captured_at: new Date(star.starred_at).toISOString(),
        });
        captured++;
      }
    } catch (err) {
      log.error("GitHub poll failed", { error: String(err), page });
      break;
    }
  }

  log.info("GitHub poll complete", { captured, pages: maxPages });
  return captured;
}
