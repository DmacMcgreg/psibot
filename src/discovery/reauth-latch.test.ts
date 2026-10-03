import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
// Importing db/index.ts calls Database.setCustomSQLite once at module load —
// same constraint as db.test.ts; do not call it again here.
import { loadConfig } from "../config.ts";
import { setDbForTesting } from "../db/index.ts";
import {
  decideReauthEpisode,
  notifyReauthEpisode,
  REAUTH_EPISODE_STATE_KEY,
  type ReauthEpisodeState,
  type ReauthNotifierBot,
} from "./reauth-latch.ts";
import { oauthExpiredLine, probeGoogleRefresh } from "../agent/youtube-tools.ts";

// --- shared fixture ---

const T0 = "2026-10-01T00:00:00Z";
const T1 = "2026-10-03T08:30:00Z";

// buildReauthMessage reads config at message-build time; load it once.
loadConfig();

let db: Database;

beforeAll(() => {
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
  db.close();
});

beforeEach(() => {
  db.prepare(`DELETE FROM discovery_state`).run();
});

function fakeBot() {
  const sent: Array<{ chatId: number | string; text: string }> = [];
  const bot: ReauthNotifierBot = {
    api: {
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return { message_id: sent.length };
      },
    },
  };
  return { bot, sent };
}

const CHATS = [111, 222];

/** One discovery run as seen by the notifier: reauthRequired + the vault row's updated_at. */
async function run(
  bot: ReauthNotifierBot | null,
  opts: { reauthRequired: boolean; updatedAt?: string },
): Promise<void> {
  await notifyReauthEpisode({
    reauthRequired: opts.reauthRequired,
    getBot: () => bot,
    defaultChatIds: CHATS,
    fetchGoogleUpdatedAt: () => Promise.resolve(opts.updatedAt),
  });
}

// --- pure decision ---

describe("decideReauthEpisode", () => {
  it("first dead run opens an episode and sends the reauth notice", () => {
    const d = decideReauthEpisode({ reauthRequired: true, rowUpdatedAt: T0, prev: { episodeKey: null } });
    expect(d).toEqual({ sendReauth: true, sendRecovery: false, next: { episodeKey: T0 } });
  });

  it("repeat dead runs with the same updated_at stay silent", () => {
    const prev: ReauthEpisodeState = { episodeKey: T0 };
    const d = decideReauthEpisode({ reauthRequired: true, rowUpdatedAt: T0, prev });
    expect(d).toEqual({ sendReauth: false, sendRecovery: false, next: prev });
  });

  it("a new updated_at after a reconnect-free window is a NEW episode", () => {
    const d = decideReauthEpisode({ reauthRequired: true, rowUpdatedAt: T1, prev: { episodeKey: T0 } });
    expect(d.sendReauth).toBe(true);
    expect(d.next.episodeKey).toBe(T1);
  });

  it("first healthy run after an open episode sends exactly one recovery ping and re-arms", () => {
    const d = decideReauthEpisode({ reauthRequired: false, rowUpdatedAt: undefined, prev: { episodeKey: T0 } });
    expect(d).toEqual({ sendReauth: false, sendRecovery: true, next: { episodeKey: null } });
  });

  it("healthy runs with no open episode send nothing", () => {
    const d = decideReauthEpisode({ reauthRequired: false, rowUpdatedAt: undefined, prev: { episodeKey: null } });
    expect(d).toEqual({ sendReauth: false, sendRecovery: false, next: { episodeKey: null } });
  });

  it("vault listing unreachable during an open episode does not duplicate the notice", () => {
    const prev: ReauthEpisodeState = { episodeKey: T0 };
    const d = decideReauthEpisode({ reauthRequired: true, rowUpdatedAt: undefined, prev });
    expect(d.sendReauth).toBe(false);
  });

  it("dead run with unreachable listing and no episode still notifies once", () => {
    const d = decideReauthEpisode({ reauthRequired: true, rowUpdatedAt: undefined, prev: { episodeKey: null } });
    expect(d.sendReauth).toBe(true);
    expect(d.next.episodeKey).toBe("vault-unreachable");
  });
});

// --- notify path (episode behavior the map's done-line asserts) ---

describe("notifyReauthEpisode", () => {
  it("exactly one reauth message across >=3 consecutive dead runs, carrying the dashboard deep link", async () => {
    const { bot, sent } = fakeBot();
    for (let i = 0; i < 4; i++) {
      await run(bot, { reauthRequired: true, updatedAt: T0 });
    }
    expect(sent).toHaveLength(CHATS.length); // one per default chat, NOT one per run
    for (const m of sent) {
      expect(m.text).toContain("/dashboard?key=");
      expect(m.text).toContain("needs re-auth");
    }
    // latch state persisted: the episode key is recorded for the next run
    const raw = db
      .prepare<{ value: string }, [string]>(`SELECT value FROM discovery_state WHERE key = ?`)
      .get(REAUTH_EPISODE_STATE_KEY);
    expect(raw?.value).toContain(T0);
  });

  it("reconnect (updated_at advances) fires exactly one recovery message, then silence", async () => {
    const { bot, sent } = fakeBot();
    await run(bot, { reauthRequired: true, updatedAt: T0 });
    await run(bot, { reauthRequired: true, updatedAt: T0 });
    await run(bot, { reauthRequired: false, updatedAt: T1 }); // healthy run after reconnect
    const recovery = sent.filter((m) => m.text.toLowerCase().includes("re-authed"));
    expect(recovery).toHaveLength(CHATS.length);
    await run(bot, { reauthRequired: false, updatedAt: T1 });
    await run(bot, { reauthRequired: false, updatedAt: T1 });
    expect(sent).toHaveLength(CHATS.length * 2); // no further recovery pings
  });

  it("a second expiry episode after recovery notifies again — exactly once", async () => {
    const { bot, sent } = fakeBot();
    await run(bot, { reauthRequired: true, updatedAt: T0 }); // episode 1 opens
    await run(bot, { reauthRequired: false, updatedAt: T1 }); // recovery
    for (let i = 0; i < 3; i++) {
      await run(bot, { reauthRequired: true, updatedAt: T1 }); // episode 2: same row, token dead again
    }
    const reauth = sent.filter((m) => m.text.includes("needs re-auth"));
    expect(reauth).toHaveLength(CHATS.length * 2); // episode 1 + episode 2, once each
  });

  it("no bot means no message AND no latch — the notice fires once a bot exists", async () => {
    const { bot, sent } = fakeBot();
    await run(null, { reauthRequired: true, updatedAt: T0 });
    expect(sent).toHaveLength(0);
    await run(bot, { reauthRequired: true, updatedAt: T0 });
    expect(sent).toHaveLength(CHATS.length);
  });
});

// --- youtube_oauth_setup honesty line ---

describe("oauthExpiredLine", () => {
  it("never claims auto-refresh when the refresh token is dead (invalid_grant)", () => {
    const line = oauthExpiredLine("reauth-required");
    expect(line).toContain("invalid_grant");
    expect(line).not.toContain("will auto-refresh");
  });

  it("soft expiry the probe revived keeps the auto-refresh wording", () => {
    expect(oauthExpiredLine("refresh-ok")).toBe("yes (will auto-refresh)");
  });

  it("unreachable vault stays honest instead of promising a refresh", () => {
    expect(oauthExpiredLine("unknown")).not.toContain("will auto-refresh");
  });
});

/** fetch stand-in without casts: a responder plus the real preconnect is structurally a typeof fetch. */
function fetchStub(responder: () => Promise<Response>): typeof fetch {
  return Object.assign(responder, { preconnect: globalThis.fetch.preconnect });
}

describe("probeGoogleRefresh", () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("classifies a 500 reauth_required body as reauth-required", async () => {
    globalThis.fetch = fetchStub(async () =>
      new Response(JSON.stringify({ error: "Refresh failed: invalid_grant", reauth_required: true }), { status: 500 }));
    expect(await probeGoogleRefresh({ OAUTH_VAULT_URL: "http://vault", OAUTH_VAULT_API_KEY: "k" })).toBe("reauth-required");
  });

  it("classifies a 200 as refresh-ok", async () => {
    globalThis.fetch = fetchStub(async () => new Response(JSON.stringify({ provider: "google", access_token: "x" }), { status: 200 }));
    expect(await probeGoogleRefresh({ OAUTH_VAULT_URL: "http://vault", OAUTH_VAULT_API_KEY: "k" })).toBe("refresh-ok");
  });

  it("a plain 500 without reauth_required and a network throw are unknown", async () => {
    globalThis.fetch = fetchStub(async () => new Response("boom", { status: 500 }));
    expect(await probeGoogleRefresh({ OAUTH_VAULT_URL: "http://vault", OAUTH_VAULT_API_KEY: "k" })).toBe("unknown");
    globalThis.fetch = fetchStub(async () => {
      throw new Error("network down");
    });
    expect(await probeGoogleRefresh({ OAUTH_VAULT_URL: "http://vault", OAUTH_VAULT_API_KEY: "k" })).toBe("unknown");
  });
});
