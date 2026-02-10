import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("youtube:api");

const OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
}

interface PlaylistItem {
  id: string;
  snippet: {
    title: string;
    channelTitle: string;
    resourceId: {
      videoId: string;
    };
  };
}

function getTokenPath(): string {
  const config = getConfig();
  return join(config.PSIBOT_DIR, "youtube-oauth.json");
}

export function loadTokens(): OAuthTokens | null {
  const tokenPath = getTokenPath();
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = readFileSync(tokenPath, "utf-8");
    return JSON.parse(raw) as OAuthTokens;
  } catch {
    log.error("Failed to read token file", { path: tokenPath });
    return null;
  }
}

export function saveTokens(tokens: OAuthTokens): void {
  const tokenPath = getTokenPath();
  const dir = dirname(tokenPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  log.info("Tokens saved", { path: tokenPath });
}

function getRedirectUri(): string {
  const config = getConfig();
  if (config.TELEGRAM_WEBHOOK_HOST) {
    return `https://${config.TELEGRAM_WEBHOOK_HOST}/auth/youtube/callback`;
  }
  return `http://127.0.0.1:${config.PORT}/auth/youtube/callback`;
}

export function getAuthUrl(): string {
  const config = getConfig();
  const params = new URLSearchParams({
    client_id: config.YOUTUBE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<OAuthTokens> {
  const config = getConfig();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.YOUTUBE_CLIENT_ID,
      client_secret: config.YOUTUBE_CLIENT_SECRET,
      redirect_uri: getRedirectUri(),
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
  };

  const tokens: OAuthTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    token_type: data.token_type,
  };

  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken(tokens: OAuthTokens): Promise<OAuthTokens> {
  const config = getConfig();

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.YOUTUBE_CLIENT_ID,
      client_secret: config.YOUTUBE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  const updated: OAuthTokens = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
    token_type: data.token_type,
  };

  saveTokens(updated);
  log.info("Access token refreshed");
  return updated;
}

async function ensureValidToken(): Promise<OAuthTokens> {
  const tokens = loadTokens();
  if (!tokens) {
    throw new Error("No YouTube OAuth tokens found. Run youtube_oauth_setup first.");
  }

  // Refresh if expiring within 5 minutes
  const FIVE_MINUTES = 5 * 60 * 1000;
  if (tokens.expires_at - Date.now() < FIVE_MINUTES) {
    log.info("Token expiring soon, refreshing");
    return refreshAccessToken(tokens);
  }

  return tokens;
}

async function youtubeApiRequest<T>(
  path: string,
  options: {
    method?: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const tokens = await ensureValidToken();
  const method = options.method ?? "GET";

  const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${tokens.access_token}`,
  };

  let bodyStr: string | undefined;
  if (options.body) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(options.body);
  }

  const response = await fetch(url.toString(), { method, headers, body: bodyStr });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`YouTube API error ${response.status} (${path}): ${errorText.slice(0, 500)}`);
  }

  if (method === "DELETE") {
    return {} as T;
  }

  return (await response.json()) as T;
}

export async function listPlaylistItems(playlistId: string): Promise<PlaylistItem[]> {
  const items: PlaylistItem[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      part: "snippet",
      playlistId,
      maxResults: "50",
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await youtubeApiRequest<{
      items: PlaylistItem[];
      nextPageToken?: string;
    }>("playlistItems", { params });

    items.push(...data.items);
    pageToken = data.nextPageToken;
  } while (pageToken);

  log.info("Listed playlist items", { playlistId, count: items.length });
  return items;
}

export async function removeFromPlaylist(playlistItemId: string): Promise<void> {
  await youtubeApiRequest("playlistItems", {
    method: "DELETE",
    params: { id: playlistItemId },
  });
  log.info("Removed from playlist", { playlistItemId });
}

export async function addToPlaylist(playlistId: string, videoId: string): Promise<string> {
  const data = await youtubeApiRequest<{ id: string }>("playlistItems", {
    method: "POST",
    params: { part: "snippet" },
    body: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
  });
  log.info("Added to playlist", { playlistId, videoId, playlistItemId: data.id });
  return data.id;
}
