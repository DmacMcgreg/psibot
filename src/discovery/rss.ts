import { createLogger } from "../shared/logger.ts";

const log = createLogger("discovery:rss");

export interface FeedEntry {
  videoId: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string; // ISO 8601
}

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";

// Minimal, dependency-free YouTube Atom feed parser. YouTube's feed structure is
// stable: each <entry> contains <yt:videoId>, <title>, <yt:channelId>, an
// <author><name>, and <published>. We extract with regex over the entry block
// rather than a full XML parser to avoid any runtime dependency.

/**
 * Parse a YouTube channel/playlist Atom feed into feed entries.
 * Returns entries in feed order (newest first, as YouTube publishes them).
 * Throws if the input does not look like an Atom feed.
 */
export function parseFeed(xml: string): FeedEntry[] {
  if (!xml.includes("<entry")) {
    // Either genuinely empty, or not an Atom feed. Distinguish so callers can
    // backoff real failures vs. no-op empty polls.
    if (xml.includes("<feed")) return [];
    throw new Error("Not a YouTube Atom feed (no <entry> or <feed> element)");
  }

  const out: FeedEntry[] = [];
  // Match each <entry>...</entry> block (DOTALL via [^]* to be safe cross-engine).
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRegex.exec(xml)) !== null) {
    const block = m[1];
    const videoId = pickTag(block, "videoId");
    if (!videoId) continue; // skip malformed entries

    out.push({
      videoId,
      title: (pickTag(block, "title") ?? "").trim(),
      channelId: pickTag(block, "channelId") ?? "",
      // <author><name>...</name></author>
      channelTitle: pickTag(block, "name") ?? "",
      publishedAt: pickTag(block, "published") ?? "",
    });
  }
  return out;
}

/**
 * Extract the text content of the first <localName> or <prefix:localName> tag
 * inside `block`. Returns null if not found.
 */
function pickTag(block: string, localName: string): string | null {
  // <name> or <yt:name> or <media:name> — match by local name, ignore prefix.
  const re = new RegExp(`<\\w*:?${localName}[^>]*>([^<]*)<\\/\\w*:?${localName}>`, "i");
  const m = re.exec(block);
  return m ? m[1].trim() : null;
}

/**
 * Fetch and parse a channel's RSS feed. Zero quota, no API key.
 * Returns entries newest-first (as YouTube publishes them).
 */
export async function fetchChannelFeed(channelId: string): Promise<FeedEntry[]> {
  const url = `${FEED_BASE}?channel_id=${channelId}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "psibot-discovery/1.0 (+youtube feed reader)" },
  });
  if (!response.ok) {
    throw new Error(`RSS fetch failed (${response.status}) for channel ${channelId}`);
  }
  const xml = await response.text();
  return parseFeed(xml);
}

