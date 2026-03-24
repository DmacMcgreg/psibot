import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("youtube:api");

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

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

interface VaultTokenResponse {
  provider: string;
  access_token: string;
  expires_at: string | null;
  refreshed?: boolean;
  error?: string;
  reauth_required?: boolean;
  reauth_url?: string;
}

async function fetchAccessToken(forceRefresh = false): Promise<string> {
  const config = getConfig();

  if (!config.OAUTH_VAULT_URL || !config.OAUTH_VAULT_API_KEY) {
    throw new Error(
      "OAUTH_VAULT_URL and OAUTH_VAULT_API_KEY must be set. " +
      "Connect Google at your vault dashboard first."
    );
  }

  const url = forceRefresh
    ? `${config.OAUTH_VAULT_URL}/api/tokens/google?force_refresh=true`
    : `${config.OAUTH_VAULT_URL}/api/tokens/google`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${config.OAUTH_VAULT_API_KEY}` },
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as VaultTokenResponse | null;
    if (data?.reauth_required) {
      throw new ReauthRequiredError(
        `Google OAuth token expired. Re-authenticate at: ${config.OAUTH_VAULT_URL}${data.reauth_url ?? "/google/authorize"}`
      );
    }
    const text = data?.error ?? `HTTP ${response.status}`;
    throw new Error(`OAuth vault error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as VaultTokenResponse;
  log.info("Fetched access token from vault", {
    provider: data.provider,
    refreshed: data.refreshed ?? false,
    forceRefresh,
  });
  return data.access_token;
}

export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

export async function checkVaultStatus(): Promise<{
  connected: boolean;
  expired: boolean;
  scopes: string | null;
}> {
  const config = getConfig();

  if (!config.OAUTH_VAULT_URL || !config.OAUTH_VAULT_API_KEY) {
    return { connected: false, expired: false, scopes: null };
  }

  const response = await fetch(`${config.OAUTH_VAULT_URL}/api/tokens`, {
    headers: { Authorization: `Bearer ${config.OAUTH_VAULT_API_KEY}` },
  });

  if (!response.ok) {
    return { connected: false, expired: false, scopes: null };
  }

  const providers = (await response.json()) as Array<{
    provider: string;
    connected: boolean;
    expired: boolean;
    scopes: string | null;
  }>;

  const google = providers.find((p) => p.provider === "google");
  if (!google) {
    return { connected: false, expired: false, scopes: null };
  }

  return {
    connected: google.connected,
    expired: google.expired,
    scopes: google.scopes,
  };
}

async function youtubeApiRequest<T>(
  path: string,
  options: {
    method?: string;
    params?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const method = options.method ?? "GET";

  const makeRequest = async (forceRefresh: boolean) => {
    const accessToken = await fetchAccessToken(forceRefresh);

    const url = new URL(`${YOUTUBE_API_BASE}/${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    let bodyStr: string | undefined;
    if (options.body) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(options.body);
    }

    return fetch(url.toString(), { method, headers, body: bodyStr });
  };

  // First attempt with cached token
  let response = await makeRequest(false);

  // On 401, retry once with a force-refreshed token
  if (response.status === 401) {
    log.info("Got 401, retrying with force-refreshed token", { path, method });
    response = await makeRequest(true);
  }

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
