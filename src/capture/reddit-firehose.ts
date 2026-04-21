import { insertTradingSignal, getTradingSignalByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { loadTickerUniverse, extractTickers, inferDirection } from "./ticker-filter.ts";

const log = createLogger("capture:reddit-firehose");

const USER_AGENT = "PsiBot:v2.0 (by /u/FunnyRocker)";

type SubredditKey =
  | "wallstreetbets"
  | "stocks"
  | "options"
  | "investing"
  | "pennystocks"
  | "SecurityAnalysis";

interface SubSource {
  subreddit: SubredditKey;
  sourceName: string;
}

const SUB_SOURCES: SubSource[] = [
  { subreddit: "wallstreetbets", sourceName: "wsb" },
  { subreddit: "stocks", sourceName: "reddit-stocks" },
  { subreddit: "options", sourceName: "reddit-options" },
  { subreddit: "investing", sourceName: "reddit-investing" },
  { subreddit: "pennystocks", sourceName: "reddit-pennystocks" },
  { subreddit: "SecurityAnalysis", sourceName: "reddit-securityanalysis" },
];

interface RedditPost {
  title: string;
  url: string;
  permalink: string;
  subreddit: string;
  selftext: string;
  score: number;
  num_comments: number;
  created_utc: number;
  author: string;
  link_flair_text?: string | null;
}

interface RedditListing {
  kind: string;
  data: {
    after: string | null;
    children: Array<{ kind: string; data: RedditPost }>;
  };
}

async function fetchSubredditFeed(
  subreddit: string,
  endpoint: "hot" | "rising",
  limit = 50
): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${subreddit}/${endpoint}.json?limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      log.error("Reddit API error", { subreddit, endpoint, status: res.status });
      return [];
    }
    const json = (await res.json()) as RedditListing;
    return json.data.children
      .filter((c) => c.kind === "t3")
      .map((c) => c.data);
  } catch (err) {
    log.error("Reddit fetch failed", { subreddit, endpoint, error: String(err) });
    return [];
  }
}

function scorePost(post: RedditPost): number {
  const upvotes = Math.max(0, post.score);
  const comments = Math.max(1, post.num_comments);
  const raw = upvotes * Math.log(comments + 1);
  return Math.min(1, raw / 10000);
}

function buildReason(post: RedditPost, ticker: string, direction: string): string {
  const score = post.score;
  const comments = post.num_comments;
  const flair = post.link_flair_text ? `[${post.link_flair_text}] ` : "";
  const titleSnip = post.title.length > 120 ? post.title.slice(0, 117) + "..." : post.title;
  return `r/${post.subreddit} ${score}↑/${comments}c ${flair}${direction} — ${ticker}: ${titleSnip}`;
}

export async function pollRedditFirehose(): Promise<number> {
  const universe = await loadTickerUniverse();
  let totalSignals = 0;

  for (const src of SUB_SOURCES) {
    try {
      const [hot, rising] = await Promise.all([
        fetchSubredditFeed(src.subreddit, "hot", 50),
        fetchSubredditFeed(src.subreddit, "rising", 25),
      ]);
      const seen = new Set<string>();
      const posts = [...hot, ...rising].filter((p) => {
        if (seen.has(p.permalink)) return false;
        seen.add(p.permalink);
        return true;
      });

      let subCaptured = 0;
      for (const post of posts) {
        const text = `${post.title} ${post.selftext ?? ""} ${post.link_flair_text ?? ""}`;
        const tickers = extractTickers(text, universe);
        if (tickers.length === 0) continue;
        if (tickers.length > 5) continue; // Likely a list post, not a focused call

        const direction = inferDirection(text);
        const strength = scorePost(post);
        const postUrl = `https://reddit.com${post.permalink}`;

        for (const ticker of tickers) {
          const signalUrl = `${postUrl}#${ticker}`;
          if (getTradingSignalByUrl(signalUrl)) continue;
          insertTradingSignal({
            source: src.sourceName,
            ticker,
            direction,
            strength,
            reason: buildReason(post, ticker, direction),
            payload_json: JSON.stringify({
              subreddit: post.subreddit,
              title: post.title,
              score: post.score,
              num_comments: post.num_comments,
              flair: post.link_flair_text,
              author: post.author,
              created_utc: post.created_utc,
            }),
            source_url: signalUrl,
          });
          subCaptured++;
          totalSignals++;
        }
      }
      log.info("Firehose sub complete", { subreddit: src.subreddit, captured: subCaptured });
    } catch (err) {
      log.error("Firehose sub failed", { subreddit: src.subreddit, error: String(err) });
    }
  }

  log.info("Reddit firehose complete", { total: totalSignals });
  return totalSignals;
}
