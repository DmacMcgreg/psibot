/**
 * Google re-auth episode latch — R1 of research/psibot-oauth-recovery-map.md §5.
 *
 * Before this, discovery notified every default chat on EVERY run while the
 * google token was dead ("notify once" was once per 6 h run). The latch keys an
 * expiry episode on the vault token row's `updated_at`: the first dead run
 * sends the one reauth message (with the Google-consent authorize deep link —
 * R1 variant, row t_g5powq5cxd), repeats with the same key stay silent, and
 * the first healthy run after a reconnect sends exactly one recovery ping and
 * re-arms the latch.
 */
import { getConfig } from "../config.ts";
import { getState, setState } from "./db.ts";

/** Latch state persisted in discovery_state; episodeKey = the vault google row's updated_at this episode keyed on. */
export interface ReauthEpisodeState {
  episodeKey: string | null;
}

/** Minimal bot surface the notifier needs; the real grammy Bot satisfies this structurally. */
export interface ReauthNotifierBot {
  api: { sendMessage: (chatId: number | string, text: string) => Promise<{ message_id: number }> };
}

export const REAUTH_EPISODE_STATE_KEY = "google_reauth_episode";

export const REAUTH_RECOVERED_MESSAGE = "✅ Google re-authed — YouTube discovery recovered.";

/** Just the vault coordinates the deep link needs; the real config satisfies this structurally. */
interface VaultConfig {
  OAUTH_VAULT_URL: string;
}

/**
 * The vault's own Google-consent start URL — the exact href shape the
 * dashboard's Connect button builds (oauth-vault dashboard route:
 * `?provider=google&response_type=code&client_id=dashboard&redirect_uri=<base>/connected`),
 * addressed at the configured public base. No `key` param: `/authorize` is a
 * public route and the OAuth dance itself is the credential, so the notice
 * carries no secret. This is the fully-parameterized consent start — not the
 * bare `/<provider>/authorize` path the vault's error body names, which has no
 * redirect_uri and would dead-end.
 */
export function googleAuthorizeUrl(cfg: VaultConfig = getConfig()): string {
  if (!cfg.OAUTH_VAULT_URL) return "";
  const redirectUri = `${cfg.OAUTH_VAULT_URL}/connected`;
  return `${cfg.OAUTH_VAULT_URL}/authorize?provider=google&response_type=code&client_id=dashboard&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/**
 * Latch reauth notice — R1 authorize deep-link variant (map §5, row
 * t_g5powq5cxd). Deliberately NOT shared buildReauthMessage: the expiry
 * notice David taps must land on Google consent in one hop, not the
 * dashboard's provider table (dashboard → Connect → consent). Every other
 * consumer keeps the dashboard link; the vault's OAuth success handler stays
 * the token's only writer either way.
 */
function buildLatchReauthMessage(service: string, cfg: VaultConfig = getConfig()): string {
  const url = googleAuthorizeUrl(cfg);
  const base = `⚠️ ${service} needs re-auth — OAuth token expired.`;
  return url ? `${base} Reconnect (one tap → Google consent):\n\n${url}` : `${base} (OAuth vault URL not configured.)`;
}

/**
 * One decision per run. A dead token opens an episode keyed on the vault row's
 * updated_at (first dead run notifies, repeats with the same key stay silent);
 * the first healthy run after that closes the episode with one recovery ping
 * and re-arms the latch. `rowUpdatedAt === undefined` means the vault listing
 * was unreachable — an open episode keeps its key (no duplicate notice), a
 * closed one latches on "vault-unreachable" so the notice still fires once.
 */
export function decideReauthEpisode(input: {
  reauthRequired: boolean;
  rowUpdatedAt: string | undefined;
  prev: ReauthEpisodeState;
}): { sendReauth: boolean; sendRecovery: boolean; next: ReauthEpisodeState } {
  if (!input.reauthRequired) {
    return input.prev.episodeKey === null
      ? { sendReauth: false, sendRecovery: false, next: input.prev }
      : { sendReauth: false, sendRecovery: true, next: { episodeKey: null } };
  }
  const key = input.rowUpdatedAt ?? input.prev.episodeKey ?? "vault-unreachable";
  return input.prev.episodeKey === key
    ? { sendReauth: false, sendRecovery: false, next: input.prev }
    : { sendReauth: true, sendRecovery: false, next: { episodeKey: key } };
}

function loadReauthEpisode(): ReauthEpisodeState {
  const raw = getState(REAUTH_EPISODE_STATE_KEY);
  if (!raw) return { episodeKey: null };
  try {
    const parsed = JSON.parse(raw) as Partial<ReauthEpisodeState>;
    return { episodeKey: typeof parsed.episodeKey === "string" ? parsed.episodeKey : null };
  } catch {
    return { episodeKey: null };
  }
}

/**
 * updated_at of the vault's google token row, via the GET /api/tokens listing
 * (read-only — unlike /api/tokens/google it never triggers a refresh attempt).
 * undefined when the vault is unreachable or unconfigured.
 */
export async function fetchGoogleTokenUpdatedAt(): Promise<string | undefined> {
  const cfg = getConfig();
  if (!cfg.OAUTH_VAULT_URL || !cfg.OAUTH_VAULT_API_KEY) return undefined;
  try {
    const response = await fetch(`${cfg.OAUTH_VAULT_URL}/api/tokens`, {
      headers: { Authorization: `Bearer ${cfg.OAUTH_VAULT_API_KEY}` },
    });
    if (!response.ok) return undefined;
    const rows = (await response.json()) as Array<{ provider: string; updated_at?: string }>;
    return rows.find((r) => r.provider === "google")?.updated_at;
  } catch {
    return undefined;
  }
}

/**
 * Called once per discovery run with the run's reauth outcome. Sends the
 * reauth notice (with the Google-consent authorize deep link) only when a new
 * episode opens, and the recovery ping only on the first healthy run after an
 * episode.
 */
export async function notifyReauthEpisode(opts: {
  reauthRequired: boolean;
  getBot: () => ReauthNotifierBot | null;
  defaultChatIds: number[];
  /** Injectable row observation for tests; default is the read-only vault listing. */
  fetchGoogleUpdatedAt?: () => Promise<string | undefined>;
}): Promise<void> {
  const bot = opts.getBot();
  if (!bot) return; // no bot yet — leave the latch untouched so the notice fires next run
  const prev = loadReauthEpisode();
  const rowUpdatedAt = opts.reauthRequired
    ? await (opts.fetchGoogleUpdatedAt ?? fetchGoogleTokenUpdatedAt)()
    : undefined;
  const decision = decideReauthEpisode({ reauthRequired: opts.reauthRequired, rowUpdatedAt, prev });
  if (!decision.sendReauth && !decision.sendRecovery) return;
  const text = decision.sendReauth ? buildLatchReauthMessage("YouTube discovery") : REAUTH_RECOVERED_MESSAGE;
  for (const chatId of opts.defaultChatIds) {
    try {
      await bot.api.sendMessage(chatId, text);
    } catch { /* best-effort */ }
  }
  // Persist after sending: a crash between send and save risks one duplicate
  // next run; saving before sending risks losing the only notice.
  setState(REAUTH_EPISODE_STATE_KEY, JSON.stringify(decision.next));
}
