import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
// Importing index.ts calls Database.setCustomSQLite once (module load), so we
// must not call it again here.
import { setDbForTesting } from "../db/index.ts";
import {
  CANARY_CHANNEL_ID,
  CHANNEL_FAILURE_WARN_STREAK,
  pollRssFeeds,
} from "./channels.ts";
import {
  upsertChannel,
  getChannel,
  getChannelFailureStreak,
  getPollWindowBlockedAt,
} from "./db-channels.ts";

// Ledger behavior pinned from research/psibot-channel-rot-census-2026-10.md:
// the catch arm of pollRssFeeds must persist a per-channel consecutive-failure
// streak (reset on success), a pinned canary channel outside the list must be
// probed before each round, a canary 404 must stamp the run window-blocked and
// suppress streak WARNs, and no failure count may ever delete a channel — a
// naive N-strikes prune would have deleted all 292 live channels during the
// 2026-10-05 04:00Z block window.
//
// No mock.module here: rss.test.ts owns the real ./rss.ts module and
// mock.module is process-wide first-wins. We stub globalThis.fetch instead
// (restored in afterAll), so rss.ts runs for real against a router.

let db: Database;

const CHAN_A = "UCchanA0000000000000000"; // failing channel in these tests
const CHAN_B = "UCchanB0000000000000000"; // healthy channel in these tests

// --- fetch router (installed once; state reset per test) ---

const FEED_URL = "https://www.youtube.com/feeds/videos.xml";

function feedXml(channelId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <yt:videoId>vid_${channelId}</yt:videoId>
    <title>T ${channelId}</title>
    <yt:channelId>${channelId}</yt:channelId>
    <author><name>Chan ${channelId}</name></author>
    <published>2026-10-05T00:00:00Z</published>
  </entry>
</feed>`;
}

let fetchLog: string[] = [];
let canaryStatus: 200 | 404 = 200;
const failChannels = new Set<string>();
const realFetch = globalThis.fetch;

// --- console.warn spy (the logger writes WARNs to console.warn) ---

let warns: string[] = [];
const realWarn = console.warn;

function streakWarns(): string[] {
  return warns.filter((w) => w.includes("consecutive-failure streak"));
}

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  setDbForTesting(db);

  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const channelId = url.searchParams.get("channel_id") ?? "";
    fetchLog.push(url.toString());
    const status =
      channelId === CANARY_CHANNEL_ID
        ? canaryStatus
        : failChannels.has(channelId)
          ? 404
          : 200;
    return new Response(status === 200 ? feedXml(channelId) : "Error 404 (Not Found)!!1", {
      status,
    });
  }) as typeof fetch;

  console.warn = ((message?: unknown) => {
    warns.push(String(message));
  }) as typeof console.warn;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  db.close();
});

beforeEach(() => {
  db.exec(`DELETE FROM discovery_channels`);
  db.exec(`DELETE FROM discovery_candidates`);
  db.exec(`DELETE FROM discovery_state`);
  upsertChannel({ channelId: CHAN_A, channelTitle: "Chan A" });
  upsertChannel({ channelId: CHAN_B, channelTitle: "Chan B" });
  fetchLog = [];
  canaryStatus = 200;
  failChannels.clear();
  warns = [];
});

describe("channel failure ledger", () => {
  it("increments the streak in the catch arm and resets it on a successful poll", async () => {
    failChannels.add(CHAN_A);

    const round1 = await pollRssFeeds();
    expect(round1.errors).toBe(1);
    expect(round1.channelsPolled).toBe(1); // only CHAN_B fetched
    expect(getChannelFailureStreak(CHAN_A)).toBe(1);
    expect(getChannelFailureStreak(CHAN_B)).toBe(0);
    // A failed poll must not refresh last_polled_at.
    expect(getChannel(CHAN_A)?.last_polled_at).toBeNull();

    failChannels.clear();
    const round2 = await pollRssFeeds();
    expect(round2.errors).toBe(0);
    expect(round2.channelsPolled).toBe(2);
    expect(getChannelFailureStreak(CHAN_A)).toBe(0);
    expect(getChannel(CHAN_A)?.last_polled_at).not.toBeNull();
  });

  it("probes the pinned canary before the round and never lists it as a channel", async () => {
    const round = await pollRssFeeds();
    expect(round.windowBlocked).toBe(false);
    // First fetch of the round is the canary probe.
    expect(fetchLog[0]).toBe(`${FEED_URL}?channel_id=${CANARY_CHANNEL_ID}`);
    // The canary is outside the list: not polled as a channel, not inserted.
    expect(fetchLog.filter((u) => u.includes(CANARY_CHANNEL_ID)).length).toBe(1);
    expect(round.channelsPolled).toBe(2);
    expect(getChannel(CANARY_CHANNEL_ID)).toBeNull();
    // A healthy canary leaves no window-blocked stamp.
    expect(getPollWindowBlockedAt()).toBeNull();
  });

  it("canary 404 stamps the run window-blocked and suppresses streak WARNs", async () => {
    canaryStatus = 404;
    failChannels.add(CHAN_A);

    for (let i = 0; i < CHANNEL_FAILURE_WARN_STREAK; i++) {
      const round = await pollRssFeeds();
      expect(round.windowBlocked).toBe(true);
    }

    // The stamp is persisted as an ISO timestamp any prune-class decision can read.
    expect(getPollWindowBlockedAt()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // The ledger still records honestly through a block window...
    expect(getChannelFailureStreak(CHAN_A)).toBe(CHANNEL_FAILURE_WARN_STREAK);
    // ...but no streak WARN fired (the window is blocked, not the channel dead)...
    expect(streakWarns().length).toBe(0);
    // ...and the channel survives — no deletion path may exist.
    expect(getChannel(CHAN_A)).not.toBeNull();
  });

  it("canary 200 + streak at threshold WARNs without deleting the channel", async () => {
    failChannels.add(CHAN_A);

    for (let i = 0; i < CHANNEL_FAILURE_WARN_STREAK; i++) {
      await pollRssFeeds();
    }

    expect(streakWarns().length).toBe(1);
    // Pin the payload, not just WARN-presence: the channel and the streak
    // value must both ride the message for the alert to be actionable.
    expect(streakWarns()[0]).toContain(CHAN_A);
    expect(streakWarns()[0]).toContain(`"streak":${CHANNEL_FAILURE_WARN_STREAK}`);
    expect(getChannelFailureStreak(CHAN_A)).toBe(CHANNEL_FAILURE_WARN_STREAK);
    expect(getChannel(CHAN_A)).not.toBeNull();
  });
});
