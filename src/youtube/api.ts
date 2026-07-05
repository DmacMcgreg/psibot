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

// --- Discovery helpers (read-only API surface) ---
// Quota costs: search.list = 100 units + its own 100-calls/day bucket;
// videos.list / channels.list / playlistItems.list = 1 unit each. The
// discovery runner treats search.list as precious and prefers the cheap paths.

export interface SearchResult {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  publishedAt: string;
}

export interface VideoStat {
  videoId: string;
  channelId: string;
  channelTitle: string;
  title: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  durationSeconds: number;
}

interface SearchListResponse {
  items: Array<{
    id?: { videoId?: string };
    snippet?: {
      channelId?: string;
      channelTitle?: string;
      title?: string;
      publishedAt?: string;
    };
  }>;
  nextPageToken?: string;
}

interface VideoListResponse {
  items: Array<{
    id: string;
    snippet?: {
      channelId?: string;
      channelTitle?: string;
      title?: string;
      publishedAt?: string;
    };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
    };
    contentDetails?: {
      duration?: string; // ISO 8601, e.g. PT1M30S
    };
  }>;
}

interface ChannelListResponse {
  items: Array<{
    id: string;
    contentDetails?: {
      relatedPlaylists?: { uploads?: string };
    };
  }>;
}

/**
 * Search for videos. Returns up to `maxResults` (≤50) per page.
 * EXPENSIVE: 100 quota units + one of the ~100/day search calls. Use sparingly.
 */
export async function searchVideos(params: {
  query: string;
  maxResults?: number;
  order?: "date" | "viewCount" | "rating" | "relevance";
  publishedAfter?: string; // RFC 3339
  videoDuration?: "any" | "short" | "medium" | "long";
}): Promise<SearchResult[]> {
  const apiParams: Record<string, string> = {
    part: "snippet",
    type: "video",
    q: params.query,
    maxResults: String(Math.min(params.maxResults ?? 25, 50)),
    order: params.order ?? "relevance",
  };
  if (params.publishedAfter) apiParams.publishedAfter = params.publishedAfter;
  if (params.videoDuration) apiParams.videoDuration = params.videoDuration;

  const data = await youtubeApiRequest<SearchListResponse>("search", { params: apiParams });

  return (data.items ?? [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      videoId: item.id!.videoId!,
      channelId: item.snippet?.channelId ?? "",
      channelTitle: item.snippet?.channelTitle ?? "",
      title: item.snippet?.title ?? "",
      publishedAt: item.snippet?.publishedAt ?? "",
    }));
}

/**
 * Fetch lightweight stats + metadata for up to 50 videos in one call (1 unit).
 * Returns whatever it can find; missing videos are simply omitted.
 */
export async function getVideoStats(videoIds: string[]): Promise<VideoStat[]> {
  if (videoIds.length === 0) return [];
  const data = await youtubeApiRequest<VideoListResponse>("videos", {
    params: {
      part: "snippet,statistics,contentDetails",
      id: videoIds.slice(0, 50).join(","),
    },
  });

  return (data.items ?? []).map((item) => ({
    videoId: item.id,
    channelId: item.snippet?.channelId ?? "",
    channelTitle: item.snippet?.channelTitle ?? "",
    title: item.snippet?.title ?? "",
    publishedAt: item.snippet?.publishedAt ?? "",
    viewCount: Number(item.statistics?.viewCount ?? 0),
    likeCount: Number(item.statistics?.likeCount ?? 0),
    durationSeconds: parseIso8601Duration(item.contentDetails?.duration ?? "PT0S"),
  }));
}

/**
 * Resolve a channel's uploads playlist id (the "UU..." playlist).
 * Cheap: 1 unit per call.
 */
export async function getUploadsPlaylistId(channelId: string): Promise<string | null> {
  const data = await youtubeApiRequest<ChannelListResponse>("channels", {
    params: { part: "contentDetails", id: channelId },
  });
  return data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
}

/**
 * List recent uploads from a channel's uploads playlist. Cheap: 1 unit per page.
 * This is the quota-friendly alternative to search.list?channelId=.
 */
export async function listUploads(
  uploadsPlaylistId: string,
  maxResults = 15,
): Promise<SearchResult[]> {
  const items: SearchResult[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      part: "snippet",
      playlistId: uploadsPlaylistId,
      maxResults: String(Math.min(maxResults, 50)),
    };
    if (pageToken) params.pageToken = pageToken;

    const data = await youtubeApiRequest<SearchListResponse>("playlistItems", { params });

    for (const item of data.items ?? []) {
      // playlistItems snippet nests the video resource under resource.videoId
      // for contentDetails; but snippet on its own gives the fields we need.
      const snip = item.snippet;
      if (!snip) continue;
      const videoId = (snip as unknown as { resourceId?: { videoId?: string } }).resourceId?.videoId;
      if (!videoId) continue;
      items.push({
        videoId,
        channelId: snip.channelId ?? "",
        channelTitle: snip.channelTitle ?? "",
        title: snip.title ?? "",
        publishedAt: snip.publishedAt ?? "",
      });
      if (items.length >= maxResults) break;
    }
    pageToken = items.length >= maxResults ? undefined : data.nextPageToken;
  } while (pageToken);

  return items;
}

/**
 * Parse an ISO 8601 duration (PT#H#M#S) into seconds. yt-dlp returns this via
 * videos.list contentDetails.duration.
 */
function parseIso8601Duration(iso: string): number {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (Number(h ?? 0) * 3600) + (Number(m ?? 0) * 60) + Number(s ?? 0);
}
