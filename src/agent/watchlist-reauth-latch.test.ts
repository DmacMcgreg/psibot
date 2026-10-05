/**
 * Watchlist reauth relay latch — t_5zaodqfwfy, map §2.3 row 3 (the named-
 * untouched leg of psibot-oauth-recovery-map). Job 12 (YouTube Watchlist
 * Processor, cron every 3 h) relays the reauth alert through the
 * youtube_process_playlist tool result; this suite pins the extended
 * one-message-per-episode semantics on the REAL tool handler: 4 consecutive
 * dead runs relay exactly one notice, a reconnect arms one recovery ping, a
 * second episode notifies exactly once more.
 *
 * Fixture constraints (same as src/discovery/reauth-latch.test.ts):
 * - db/index.ts calls Database.setCustomSQLite once at module load — do not
 *   call it again here.
 * - Config singleton gets forced fixture vault values so the real vault URL /
 *   key never surface in a diff; restored in afterAll.
 * - globalThis.fetch is routed to an in-memory vault + googleapis stub and
 *   restored in afterAll; every other URL falls through to the real fetch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { loadConfig } from "../config.ts";
import { setDbForTesting, getDb } from "../db/index.ts";
import { youtubeProcessPlaylistTool } from "./youtube-playlist-tool.ts";
import {
  WATCHLIST_REAUTH_EPISODE_STATE_KEY,
  WATCHLIST_REAUTH_RECOVERED_MESSAGE,
  watchlistReauthOutcome,
} from "./watchlist-reauth-latch.ts";
import { REAUTH_EPISODE_STATE_KEY } from "../discovery/reauth-latch.ts";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token-fixture";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "123456789";
process.env.OAUTH_VAULT_URL ??= "http://oauth-vault-fixture.test";
process.env.OAUTH_VAULT_API_KEY ??= "fixture-key";
const cfg = loadConfig();
// Force fixture values even when the singleton was already loaded from the
// real .env (single-file runs load it): assertions pin the fixture URL, and
// the real vault URL/key must never surface in a test diff.
const prevVaultUrl = cfg.OAUTH_VAULT_URL;
const prevVaultKey = cfg.OAUTH_VAULT_API_KEY;
cfg.OAUTH_VAULT_URL = "http://oauth-vault-fixture.test";
cfg.OAUTH_VAULT_API_KEY = "fixture-key";

// --- in-memory vault + googleapis stub, routed via a fetch override ---

const T0 = "2026-10-01T00:00:00Z";
const T1 = "2026-10-04T09:00:00Z";
const VAULT = "http://oauth-vault-fixture.test";
let vaultDead = true;
let vaultUpdatedAt = T0;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function stubFetch(url: string): Response | null {
  if (url.startsWith(`${VAULT}/api/tokens/google`)) {
    return vaultDead
      ? json(500, { error: "refresh failed: invalid_grant", reauth_required: true, reauth_url: "/google/authorize" })
      : json(200, { provider: "google", access_token: "tok-fixture", refreshed: false });
  }
  if (url === `${VAULT}/api/tokens`) {
    return json(200, [{ provider: "google", connected: true, expired: vaultDead, updated_at: vaultUpdatedAt, scopes: null }]);
  }
  if (url.startsWith("https://www.googleapis.com/youtube/v3/playlistItems")) {
    return json(200, { items: [] });
  }
  return null;
}

const realFetch = globalThis.fetch;
const routedFetch: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const hit = stubFetch(url);
    return hit ? Promise.resolve(hit) : realFetch(input, init);
  },
  { preconnect: realFetch.preconnect },
);

let db: Database;

beforeAll(() => {
  globalThis.fetch = routedFetch;
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
  setDbForTesting(db);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  cfg.OAUTH_VAULT_URL = prevVaultUrl;
  cfg.OAUTH_VAULT_API_KEY = prevVaultKey;
  db.close();
});

beforeEach(() => {
  db.prepare(`DELETE FROM discovery_state`).run();
  vaultDead = true;
  vaultUpdatedAt = T0;
});

// --- helpers ---

/** The slice of CallToolResult this suite reads (the SDK type is not exported). */
type ToolText = { text: string; isError: boolean };

async function runPlaylistTool(): Promise<ToolText> {
  const handler = youtubeProcessPlaylistTool().handler;
  const result = (await handler(
    { source_playlist_id: "PLfixture", destination_playlist_id: undefined, limit: undefined, retry_failed: false },
    undefined,
  )) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const block = result.content[0];
  return { text: block.type === "text" ? (block.text ?? "") : "", isError: result.isError === true };
}

const isAlert = (r: ToolText): boolean => r.text.includes("needs re-auth");

// --- the tool boundary: the agent-relayed alert path (map §2.3 row 3) ---

describe("youtube_process_playlist reauth relay latch", () => {
  it("4 consecutive dead runs relay exactly one re-auth notice, not one per run", async () => {
    const results: ToolText[] = [];
    for (let i = 0; i < 4; i++) results.push(await runPlaylistTool());

    const alerts = results.filter(isAlert);
    expect(alerts.length).toBe(1); // <- the repeated-alert anti-pattern dies here
    expect(alerts[0]).toBe(results[0]);

    // The one notice is the R1 authorize deep link — one tap to Google
    // consent, not the two-hop dashboard path, and no key param in the notice
    // (`client_id=dashboard` is the vault Connect href's own client id).
    expect(results[0].isError).toBe(true);
    expect(results[0].text).toContain("/authorize?provider=google&response_type=code");
    expect(results[0].text).not.toContain("/dashboard");
    expect(results[0].text).not.toContain("key=");

    // Runs 2-4 carry no re-auth wording at all — the agent has nothing to relay.
    for (const r of results.slice(1)) {
      expect(isAlert(r)).toBe(false);
      expect(r.text).not.toContain("/dashboard");
      expect(r.text).not.toContain("/authorize");
      expect(r.isError).toBe(false);
      expect(r.text).toContain("Playlist processing skipped");
    }
  });

  it("a reconnect arms one recovery ping, and a second episode notifies exactly once more", async () => {
    // Episode 1: dead run opens it.
    const dead1 = await runPlaylistTool();
    expect(isAlert(dead1)).toBe(true);

    // Reconnect: healthy run closes the episode with exactly one recovery ping…
    vaultDead = false;
    const healthy1 = await runPlaylistTool();
    expect(healthy1.text).toContain(WATCHLIST_REAUTH_RECOVERED_MESSAGE);
    expect(healthy1.isError).toBe(false);
    expect(healthy1.text).toContain("Playlist processing complete (0 new");
    // …and further healthy runs stay silent.
    const healthy2 = await runPlaylistTool();
    expect(healthy2.text).not.toContain(WATCHLIST_REAUTH_RECOVERED_MESSAGE);

    // Episode 2 (new vault row updated_at): notifies exactly once more.
    vaultDead = true;
    vaultUpdatedAt = T1;
    const dead2 = await runPlaylistTool();
    expect(isAlert(dead2)).toBe(true);
    const dead3 = await runPlaylistTool();
    expect(isAlert(dead3)).toBe(false);
  });

  it("never touches the discovery latch's discovery_state key", async () => {
    await runPlaylistTool(); // opens the watchlist episode
    expect(getDb().prepare(`SELECT value FROM discovery_state WHERE key = ?`).get(WATCHLIST_REAUTH_EPISODE_STATE_KEY)).toBeTruthy();
    expect(getDb().prepare(`SELECT value FROM discovery_state WHERE key = ?`).get(REAUTH_EPISODE_STATE_KEY)).toBeNull();
  });
});

// --- pure decision wiring (injected row observation, no fetch) ---

describe("watchlistReauthOutcome", () => {
  it("one notice per episode across four dead runs, one recovery, one more on the second episode", async () => {
    const obs = (t: string) => () => Promise.resolve(t);
    expect((await watchlistReauthOutcome({ reauthRequired: true, fetchGoogleUpdatedAt: obs(T0) })).reauthText).not.toBeNull();
    for (let i = 0; i < 3; i++) {
      expect((await watchlistReauthOutcome({ reauthRequired: true, fetchGoogleUpdatedAt: obs(T0) })).reauthText).toBeNull();
    }
    expect((await watchlistReauthOutcome({ reauthRequired: false })).recovered).toBe(true);
    expect((await watchlistReauthOutcome({ reauthRequired: false })).recovered).toBe(false);
    expect((await watchlistReauthOutcome({ reauthRequired: true, fetchGoogleUpdatedAt: obs(T1) })).reauthText).not.toBeNull();
    expect((await watchlistReauthOutcome({ reauthRequired: true, fetchGoogleUpdatedAt: obs(T1) })).reauthText).toBeNull();
  });

  it("unreachable vault listing: still notifies once with no episode, stays silent inside one", async () => {
    const unreachable = () => Promise.resolve(undefined);
    expect((await watchlistReauthOutcome({ reauthRequired: true, fetchGoogleUpdatedAt: unreachable })).reauthText).not.toBeNull();
    expect((await watchlistReauthOutcome({ reauthRequired: true, fetchGoogleUpdatedAt: unreachable })).reauthText).toBeNull();
  });
});
