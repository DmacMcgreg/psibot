/**
 * OAuth re-auth messaging — the SINGLE source of the link users get when a
 * Google/YouTube/Reddit token expires.
 *
 * Rule (learned the hard way, repeatedly): every user-facing OAuth expiry
 * warning must contain the DASHBOARD url (with key), never the vault root —
 * the root page has no Connect buttons. Any code path that mentions token
 * expiry to the user MUST build its message via buildReauthMessage() so the
 * link can never be forgotten or degraded back to the root URL.
 */
import { getConfig } from "../config.ts";

interface VaultConfig {
  OAUTH_VAULT_URL: string;
  OAUTH_VAULT_API_KEY: string;
}

/** Direct link to the OAuth vault dashboard (Connect buttons live here). */
export function oauthDashboardUrl(cfg: VaultConfig = getConfig()): string {
  if (!cfg.OAUTH_VAULT_URL) return "";
  return `${cfg.OAUTH_VAULT_URL}/dashboard?key=${cfg.OAUTH_VAULT_API_KEY}`;
}

/** User-facing re-auth message for a named service, always with the dashboard link. */
export function buildReauthMessage(service: string, cfg: VaultConfig = getConfig()): string {
  const url = oauthDashboardUrl(cfg);
  const base = `⚠️ ${service} needs re-auth — OAuth token expired.`;
  return url ? `${base} Reconnect here:\n\n${url}` : `${base} (OAuth vault URL not configured.)`;
}
