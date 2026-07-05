import { describe, it, expect } from "bun:test";
import { parseFeed } from "./rss.ts";

// Minimal realistic YouTube channel Atom feed (namespaces trimmed to what we use).
const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCtest"/>
  <id>yt:channel:UCtest</id>
  <yt:channelId>UCtest</yt:channelId>
  <title>Test Channel</title>
  <entry>
    <id>yt:video:vidAAAAAAA</id>
    <yt:videoId>vidAAAAAAA</yt:videoId>
    <yt:channelId>UCtest</yt:channelId>
    <title>Newest Video Title</title>
    <link rel="alternate" href="http://www.youtube.com/watch?v=vidAAAAAAA"/>
    <author>
      <name>Test Channel</name>
      <uri>http://www.youtube.com/channel/UCtest</uri>
    </author>
    <published>2026-06-28T12:00:00+00:00</published>
    <updated>2026-06-28T12:00:00+00:00</updated>
  </entry>
  <entry>
    <id>yt:video:vidBBBBBBB</id>
    <yt:videoId>vidBBBBBBB</yt:videoId>
    <yt:channelId>UCtest</yt:channelId>
    <title>Older Video</title>
    <link rel="alternate" href="http://www.youtube.com/watch?v=vidBBBBBBB"/>
    <author>
      <name>Test Channel</name>
      <uri>http://www.youtube.com/channel/UCtest</uri>
    </author>
    <published>2026-06-20T09:30:00+00:00</published>
    <updated>2026-06-20T09:30:00+00:00</updated>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("extracts entries in feed order (newest first)", () => {
    const entries = parseFeed(SAMPLE_FEED);
    expect(entries.length).toBe(2);
    expect(entries[0].videoId).toBe("vidAAAAAAA");
    expect(entries[1].videoId).toBe("vidBBBBBBB");
  });

  it("extracts title, channel, and published date", () => {
    const entries = parseFeed(SAMPLE_FEED);
    expect(entries[0].title).toBe("Newest Video Title");
    expect(entries[0].channelId).toBe("UCtest");
    expect(entries[0].channelTitle).toBe("Test Channel");
    expect(entries[0].publishedAt).toContain("2026-06-28");
  });

  it("returns empty array for a feed with no entries", () => {
    const empty = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`;
    expect(parseFeed(empty)).toEqual([]);
  });

  it("throws on malformed XML", () => {
    expect(() => parseFeed("not xml <<")).toThrow();
  });

  it("skips entries missing a videoId", () => {
    const partial = `<?xml version="1.0"?>
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
      <entry><title>No video id here</title></entry>
      <entry><yt:videoId>vidCCCCCCC</yt:videoId><title>Real one</title><published>2026-07-01T00:00:00Z</published></entry>
    </feed>`;
    const entries = parseFeed(partial);
    expect(entries.length).toBe(1);
    expect(entries[0].videoId).toBe("vidCCCCCCC");
  });
});
