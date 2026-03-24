import { getConfig } from "../config.ts";
import { insertPendingItem, getPendingItemByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("capture:reddit");

const USER_AGENT = "PsiBot:v2.0 (by /u/FunnyRocker)";

interface RedditListingData {
  after: string | null;
  children: RedditChild[];
}

interface RedditChild {
  kind: string; // t3 = post, t1 = comment
  data: {
    title?: string;
    link_title?: string;
    url?: string;
    permalink: string;
    subreddit: string;
    author: string;
    selftext?: string;
    body?: string;
    created_utc: number;
    score: number;
    num_comments?: number;
  };
}

function extractItem(child: RedditChild): {
  url: string;
  title: string;
  description: string;
  platform: string;
  profile: string;
} {
  const d = child.data;
  const isComment = child.kind === "t1";

  const url = isComment
    ? `https://reddit.com${d.permalink}`
    : d.url ?? `https://reddit.com${d.permalink}`;

  const title = isComment
    ? (d.link_title ?? "Reddit comment")
    : (d.title ?? "Reddit post");

  const text = isComment ? (d.body ?? "") : (d.selftext ?? "");
  const description = text.length > 300 ? text.slice(0, 300) + "..." : text;

  return {
    url,
    title: `[r/${d.subreddit}] ${title}`,
    description: description || `Score: ${d.score}, by u/${d.author}`,
    platform: "reddit",
    profile: d.subreddit,
  };
}

export async function pollRedditSaved(): Promise<number> {
  const config = getConfig();
  const { REDDIT_FEED_TOKEN, REDDIT_USERNAME } = config;

  if (!REDDIT_FEED_TOKEN) {
    log.warn("REDDIT_FEED_TOKEN not set, skipping Reddit poll");
    return 0;
  }

  let captured = 0;
  let after: string | null = null;
  let page = 0;
  const maxPages = 3; // Cap at ~75 items per poll to avoid hammering

  while (page < maxPages) {
    const params = new URLSearchParams({
      feed: REDDIT_FEED_TOKEN,
      user: REDDIT_USERNAME,
      limit: "25",
    });
    if (after) params.set("after", after);

    const url = `https://www.reddit.com/saved.json?${params}`;

    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
      });

      if (!res.ok) {
        log.error("Reddit API error", { status: res.status, page });
        break;
      }

      const json = (await res.json()) as { kind: string; data: RedditListingData };
      const { children } = json.data;

      if (children.length === 0) break;

      for (const child of children) {
        const item = extractItem(child);

        // Skip if already captured
        const existing = getPendingItemByUrl(item.url);
        if (existing) continue;

        insertPendingItem({
          url: item.url,
          title: item.title,
          description: item.description,
          source: "reddit",
          platform: item.platform,
          profile: item.profile,
          captured_at: new Date(child.data.created_utc * 1000).toISOString(),
        });
        captured++;
      }

      after = json.data.after;
      if (!after) break; // No more pages

      page++;
    } catch (err) {
      log.error("Reddit poll failed", { error: String(err), page });
      break;
    }
  }

  log.info("Reddit poll complete", { captured, pages: page + 1 });
  return captured;
}
