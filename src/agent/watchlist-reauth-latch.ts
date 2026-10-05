/**
 * Watchlist re-auth episode latch — the map §2.3 row-3 leg
 * (research/psibot-oauth-recovery-map.md, task t_5zaodqfwfy): job 12
 * "YouTube Watchlist Processor" (cron every 3 h) runs the
 * `youtube_process_playlist` tool on the SAME google token as discovery, and
 * its agent-relayed alert stream repeated the re-auth notice on every run.
 *
 * Reuses the landed discovery latch's episode-key semantics BY IMPORT
 * (src/discovery/reauth-latch.ts, R1 / t_g5powq5cxd): a dead token opens an
 * episode keyed on the vault google row's updated_at; repeats with the same
 * key stay silent; the first healthy run after an episode closes it with one
 * recovery ping and re-arms the latch. src/discovery itself stays read-only —
 * its scope belongs to the R1 deep-link row.
 *
 * Transport differs from discovery: the watchlist notice is relayed IN-BAND —
 * this module decides what the tool's result text carries, the job agent
 * relays the report to the chat, so one isError notice per new episode is
 * exactly one relayed message. No direct bot send (that would double-notify
 * on top of the relay).
 */
import { getConfig } from "../config.ts";
import { getState, setState } from "../discovery/db.ts";
import {
  decideReauthEpisode,
  fetchGoogleTokenUpdatedAt,
  googleAuthorizeUrl,
  type ReauthEpisodeState,
} from "../discovery/reauth-latch.ts";

/**
 * Own discovery_state key — discovery's latch row (`google_reauth_episode`)
 * is never touched, so the two consumers of the same token latch
 * independently and neither can silence the other.
 */
export const WATCHLIST_REAUTH_EPISODE_STATE_KEY = "google_reauth_episode_watchlist";

export const WATCHLIST_REAUTH_RECOVERED_MESSAGE = "✅ Google re-authed — YouTube watchlist recovered.";

/** Latch notice text builder — same R1 authorize deep-link shape as the discovery latch notice (one tap → Google consent), NOT the dashboard link. */
function buildWatchlistReauthMessage(cfg: { OAUTH_VAULT_URL: string } = getConfig()): string {
  const url = googleAuthorizeUrl(cfg);
  const base = "⚠️ YouTube watchlist needs re-auth — OAuth token expired.";
  return url ? `${base} Reconnect (one tap → Google consent):\n\n${url}` : `${base} (OAuth vault URL not configured.)`;
}

function loadWatchlistEpisode(): ReauthEpisodeState {
  const raw = getState(WATCHLIST_REAUTH_EPISODE_STATE_KEY);
  if (!raw) return { episodeKey: null };
  try {
    const parsed = JSON.parse(raw) as Partial<ReauthEpisodeState>;
    return { episodeKey: typeof parsed.episodeKey === "string" ? parsed.episodeKey : null };
  } catch {
    return { episodeKey: null };
  }
}

/** What the tool result carries this run. */
export interface WatchlistReauthOutcome {
  /** Reauth notice text to relay — non-null exactly when a NEW episode opens. */
  reauthText: string | null;
  /** True exactly on the first healthy run after an open episode (recovery ping). */
  recovered: boolean;
}

/**
 * One decision per watchlist run. State persists when a message is armed:
 * here the decision and the carrier are the same event (the tool result), so
 * unlike discovery's send-then-save there is no later send to observe — if
 * the agent dies before relaying, the notice is lost, never duplicated.
 */
export async function watchlistReauthOutcome(opts: {
  reauthRequired: boolean;
  /** Injectable row observation for tests; default is the read-only vault listing. */
  fetchGoogleUpdatedAt?: () => Promise<string | undefined>;
}): Promise<WatchlistReauthOutcome> {
  const prev = loadWatchlistEpisode();
  const rowUpdatedAt = opts.reauthRequired
    ? await (opts.fetchGoogleUpdatedAt ?? fetchGoogleTokenUpdatedAt)()
    : undefined;
  const decision = decideReauthEpisode({ reauthRequired: opts.reauthRequired, rowUpdatedAt, prev });
  if (!decision.sendReauth && !decision.sendRecovery) return { reauthText: null, recovered: false };
  setState(WATCHLIST_REAUTH_EPISODE_STATE_KEY, JSON.stringify(decision.next));
  return decision.sendReauth
    ? { reauthText: buildWatchlistReauthMessage(), recovered: false }
    : { reauthText: null, recovered: true };
}
