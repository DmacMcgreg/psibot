/**
 * Resolve when a URL's content first came out, politely, over the network.
 *
 * Order for one URL:
 *   1. `skipReason` (local/private/app/shopping URLs) → "skipped", no request.
 *   2. `publishedAtFromUrl` (X/Twitter Snowflake IDs) → no request.
 *   3. Known hosts with a cheap API: GitHub (repo created_at, issue/PR
 *      created_at, release published_at, gist created_at), YouTube (injected
 *      lookup — the sweep batches videos.list), Reddit (post created_utc,
 *      needs app credentials), Hacker News (item time), arXiv (first
 *      version's <published>), Hugging Face (createdAt).
 *   4. Everything else: fetch the page and run `extractPublishedAt`, unless the
 *      caller already fetched it and passes `pageDate` (capture reuses
 *      extractMetadata's fetch instead of fetching twice).
 *
 * Statuses: found | none (page declares no date) | skipped (never looked up) |
 * gone (404/410) | blocked (401/403/429 bot walls) | error (timeouts, 5xx,
 * network — the only status worth retrying).
 */
import {
  extractPublishedAtWithMethod,
  normalizePublishedDate,
  publishedAtFromUrl,
  skipReason,
} from "../shared/published-date.ts";

export type ResolveStatus = "found" | "none" | "skipped" | "gone" | "blocked" | "error";

export interface ResolveResult {
  publishedAt: string | null;
  status: ResolveStatus;
  /** Where the answer came from, e.g. "github-api:repo", "json-ld:newsarticle", "skip:private-address". */
  method: string;
  error?: string;
}

export interface ResolverDeps {
  githubToken?: string;
  /** Publish date for a YouTube video ID, or null/undefined when unknown. */
  youtubeVideoDate?: (videoId: string) => string | null | undefined;
  /** Reddit app-only OAuth bearer token; Reddit answers anonymous API calls with 403. */
  redditToken?: () => Promise<string | null>;
  throttle?: HostThrottle;
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
}

export interface ResolveOptions {
  /**
   * The caller already fetched this page: its extracted date (or null when the
   * fetch found none). Used instead of fetching again for generic pages.
   */
  pageDate?: string | null;
}

/** A current desktop Chrome UA: many sites serve bots a stripped page. */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
/** Reddit's API rules ask for a descriptive, unique User-Agent. */
const REDDIT_UA = "macos:psibot-publish-dates:2.0 (personal archive)";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Enough for JSON-LD placed late in <body> and a <time> in the article. */
const MAX_HTML_BYTES = 1_500_000;
const MAX_REDIRECTS = 5;

/**
 * Per-host spacing: each request reserves the next slot for its host, so
 * concurrent workers never hit one host faster than its gap.
 */
export class HostThrottle {
  private next = new Map<string, number>();
  constructor(
    private defaultGapMs = 1500,
    private gaps: Record<string, number> = {
      "api.github.com": 150,
      "export.arxiv.org": 3100,
      "www.reddit.com": 2500,
      "oauth.reddit.com": 700,
      "huggingface.co": 1000,
    },
  ) {}

  async wait(host: string): Promise<void> {
    const gap = this.gaps[host] ?? this.defaultGapMs;
    const now = Date.now();
    const at = Math.max(now, this.next.get(host) ?? 0);
    this.next.set(host, at + gap);
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

export async function resolvePublishedAt(
  url: string,
  deps: ResolverDeps = {},
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const skip = skipReason(url);
  if (skip) return { publishedAt: null, status: "skipped", method: `skip:${skip}` };

  const now = deps.now ?? new Date();
  const fromUrl = publishedAtFromUrl(url, { now });
  if (fromUrl) return { publishedAt: fromUrl.publishedAt, status: "found", method: fromUrl.method };

  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  try {
    const known = await resolveKnownHost(u, host, deps, now);
    if (known) return known;
    if (opts.pageDate !== undefined) {
      return opts.pageDate
        ? { publishedAt: opts.pageDate, status: "found", method: "page:capture-fetch" }
        : { publishedAt: null, status: "none", method: "page:capture-fetch" };
    }
    return await resolveFromHtml(url, deps, now);
  } catch (err) {
    return { publishedAt: null, status: "error", method: "exception", error: errText(err) };
  }
}

// ---------------------------------------------------------------------------
// Known hosts
// ---------------------------------------------------------------------------

/** First GitHub path segments that are site sections, not owners. */
const GITHUB_RESERVED = new Set([
  "about", "apps", "blog", "collections", "contact", "customer-stories", "enterprise", "events", "explore", "features",
  "join", "login", "marketplace", "orgs", "pricing", "readme", "resources", "security", "site", "sponsors", "topics",
  "trending", "users", "solutions", "team", "premium-support", "git-guides", "github-copilot",
]);
const HF_RESERVED = new Set([
  "docs", "blog", "papers", "settings", "login", "join", "pricing", "learn", "tasks", "collections", "organizations",
  "models", "datasets", "spaces", "posts", "chat", "new", "enterprise", "inference-endpoints", "search", "api",
]);

async function resolveKnownHost(u: URL, host: string, deps: ResolverDeps, now: Date): Promise<ResolveResult | null> {
  const parts = u.pathname.split("/").filter(Boolean);

  if (host === "github.com" || host === "www.github.com") {
    if (parts.length < 2 || GITHUB_RESERVED.has(parts[0].toLowerCase())) {
      return { publishedAt: null, status: "skipped", method: "skip:github-profile-or-section" };
    }
    const [owner, repo, section, id] = parts;
    const base = `https://api.github.com/repos/${owner}/${repo.replace(/\.git$/, "")}`;
    if ((section === "issues" || section === "pull") && id && /^\d+$/.test(id)) {
      return githubApi(`${base}/issues/${id}`, "created_at", "github-api:issue", deps, now);
    }
    if (section === "releases" && parts[3] === "tag" && parts[4]) {
      const rel = await githubApi(`${base}/releases/tags/${encodeURIComponent(parts.slice(4).join("/"))}`, "published_at", "github-api:release", deps, now);
      if (rel.status === "found") return rel;
    }
    return githubApi(base, "created_at", "github-api:repo", deps, now);
  }

  if (host === "gist.github.com" && parts.length >= 2) {
    return githubApi(`https://api.github.com/gists/${parts[1]}`, "created_at", "github-api:gist", deps, now);
  }

  const videoId = youtubeVideoId(u, host);
  if (videoId !== undefined) {
    if (!videoId) return { publishedAt: null, status: "skipped", method: "skip:youtube-non-video" };
    const known = deps.youtubeVideoDate?.(videoId);
    const iso = normalizePublishedDate(known, { now });
    if (iso) return { publishedAt: iso, status: "found", method: "youtube" };
    // No API answer (deleted/private video, or no lookup wired): the watch page's
    // own itemprop="datePublished" is the fallback.
    return null;
  }

  if (host === "www.reddit.com" || host === "reddit.com" || host === "old.reddit.com") {
    const i = parts.indexOf("comments");
    if (i < 0 || !parts[i + 1]) return { publishedAt: null, status: "skipped", method: "skip:reddit-non-post" };
    // Anonymous calls (JSON API and the HTML page) get a 403 bot wall, so
    // without app credentials don't spend a request: record it as blocked and
    // let `--retry blocked` pick it up once credentials are available.
    const token = await deps.redditToken?.();
    if (!token) return { publishedAt: null, status: "blocked", method: "reddit-api", error: "no Reddit app credentials" };
    const res = await politeFetch(`https://oauth.reddit.com/api/info?id=t3_${parts[i + 1]}&raw_json=1`, deps, "application/json",
      { Authorization: `Bearer ${token}`, "User-Agent": REDDIT_UA });
    if (!res.ok) return httpFailure(res.status, "reddit-api");
    const body = (await res.json()) as { data?: { children?: Array<{ data?: { created_utc?: number } }> } };
    const created = body?.data?.children?.[0]?.data?.created_utc;
    const iso = normalizePublishedDate(created != null ? String(Math.floor(created)) : null, { now });
    return iso ? { publishedAt: iso, status: "found", method: "reddit-api" } : { publishedAt: null, status: "none", method: "reddit-api" };
  }

  if (host === "news.ycombinator.com" && u.pathname === "/item" && /^\d+$/.test(u.searchParams.get("id") ?? "")) {
    const res = await politeFetch(`https://hacker-news.firebaseio.com/v0/item/${u.searchParams.get("id")}.json`, deps, "application/json");
    if (!res.ok) return httpFailure(res.status, "hn-api");
    const j = (await res.json()) as { time?: number } | null;
    const iso = normalizePublishedDate(j?.time != null ? String(j.time) : null, { now });
    return iso ? { publishedAt: iso, status: "found", method: "hn-api" } : { publishedAt: null, status: "none", method: "hn-api" };
  }

  if (host === "arxiv.org" || host === "www.arxiv.org") {
    const m = u.pathname.match(/^\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
    if (!m) return null;
    return arxivPublished(m[1], deps, now);
  }

  if (host === "huggingface.co") {
    if (parts[0] === "papers" && /^\d{4}\.\d{4,5}$/.test(parts[1] ?? "")) return arxivPublished(parts[1], deps, now);
    let kind: string | null = null;
    let repoParts = parts;
    if ((parts[0] === "datasets" || parts[0] === "spaces") && parts.length >= 3) {
      kind = parts[0];
      repoParts = parts.slice(1);
    } else if (parts.length >= 2 && !HF_RESERVED.has(parts[0])) {
      kind = "models";
    }
    // Listings, collections, docs and search pages: no single publish date.
    if (!kind) return { publishedAt: null, status: "skipped", method: "skip:hf-non-repo" };
    const res = await politeFetch(`https://huggingface.co/api/${kind}/${repoParts[0]}/${repoParts[1]}`, deps, "application/json");
    if (!res.ok) return httpFailure(res.status, `hf-api:${kind}`);
    const j = (await res.json()) as { createdAt?: string };
    const iso = normalizePublishedDate(j.createdAt, { now });
    return iso ? { publishedAt: iso, status: "found", method: `hf-api:${kind}` } : { publishedAt: null, status: "none", method: `hf-api:${kind}` };
  }

  return null;
}

/** "" for YouTube pages that are not a single video, undefined for non-YouTube URLs. */
export function youtubeVideoId(u: URL, host = u.hostname.toLowerCase()): string | undefined {
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || "";
  if (!/(^|\.)youtube\.com$/.test(host)) return undefined;
  if (u.pathname === "/watch") return u.searchParams.get("v") ?? "";
  const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{6,})/);
  return m ? m[1] : "";
}

async function githubApi(apiUrl: string, field: string, method: string, deps: ResolverDeps, now: Date): Promise<ResolveResult> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "PsiBot/2.0" };
  if (deps.githubToken) headers.Authorization = `Bearer ${deps.githubToken}`;
  const res = await politeFetch(apiUrl, deps, "application/vnd.github+json", headers);
  if (!res.ok) return httpFailure(res.status, method);
  const j = (await res.json()) as Record<string, unknown>;
  const iso = normalizePublishedDate(j[field], { now });
  return iso ? { publishedAt: iso, status: "found", method } : { publishedAt: null, status: "none", method };
}

async function arxivPublished(id: string, deps: ResolverDeps, now: Date): Promise<ResolveResult> {
  const res = await politeFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, deps, "application/atom+xml");
  if (!res.ok) return httpFailure(res.status, "arxiv-api");
  const xml = await res.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/);
  const iso = normalizePublishedDate(entry?.[1].match(/<published>([^<]+)<\/published>/)?.[1], { now });
  return iso ? { publishedAt: iso, status: "found", method: "arxiv-api" } : { publishedAt: null, status: "none", method: "arxiv-api" };
}

// ---------------------------------------------------------------------------
// Generic HTML
// ---------------------------------------------------------------------------

async function resolveFromHtml(url: string, deps: ResolverDeps, now: Date): Promise<ResolveResult> {
  const fetched = await fetchHtml(url, deps);
  if ("result" in fetched) return fetched.result;
  const hit = extractPublishedAtWithMethod(fetched.html, { now });
  return hit
    ? { publishedAt: hit.publishedAt, status: "found", method: hit.method }
    : { publishedAt: null, status: "none", method: "html" };
}

/**
 * GET a page as HTML, following redirects by hand so a redirect into a
 * private or signed-in URL is never followed. Reads at most MAX_HTML_BYTES.
 */
export async function fetchHtml(url: string, deps: ResolverDeps = {}): Promise<{ html: string; finalUrl: string } | { result: ResolveResult }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await politeFetch(current, deps, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", undefined, "manual");
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      res.body?.cancel().catch(() => {});
      const next = new URL(res.headers.get("location")!, current).toString();
      const skip = skipReason(next);
      if (skip) return { result: { publishedAt: null, status: "skipped", method: `skip:redirect-${skip}` } };
      current = next;
      continue;
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return { result: httpFailure(res.status, "html") };
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.includes("html") && !type.includes("xml")) {
      res.body?.cancel().catch(() => {});
      return { result: { publishedAt: null, status: "none", method: `non-html:${type.split(";")[0]}` } };
    }
    return { html: await readCapped(res, MAX_HTML_BYTES), finalUrl: current };
  }
  return { result: { publishedAt: null, status: "error", method: "html", error: "too many redirects" } };
}

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  while (bytes < max) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
    bytes += value.byteLength;
  }
  reader.cancel().catch(() => {});
  return html;
}

async function politeFetch(
  url: string,
  deps: ResolverDeps,
  accept: string,
  headers: Record<string, string> = { "User-Agent": BROWSER_UA, "Accept-Language": "en;q=0.9" },
  redirect: "follow" | "manual" = "follow",
): Promise<Response> {
  const host = new URL(url).hostname.toLowerCase();
  await (deps.throttle ?? defaultThrottle).wait(host);
  const controller = new AbortController();
  // The timer stays armed through the caller's body read, so a stalled stream
  // is cut off too; aborting an already-finished request is a no-op.
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();
  return (deps.fetchImpl ?? fetch)(url, {
    headers: { Accept: accept, ...headers },
    redirect,
    signal: controller.signal,
  });
}

const defaultThrottle = new HostThrottle();

function httpFailure(status: number, method: string): ResolveResult {
  const s: ResolveStatus = status === 404 || status === 410 ? "gone"
    : status === 401 || status === 403 || status === 429 || status === 451 ? "blocked"
    : "error";
  return { publishedAt: null, status: s, method, error: `http ${status}` };
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.name === "AbortError" ? "timeout" : err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * App-only Reddit OAuth (client_credentials) from REDDIT_CLIENT_ID and
 * REDDIT_CLIENT_SECRET, cached until shortly before expiry. Returns a provider
 * that yields null when the variables are unset or the token request fails.
 */
export function redditAppTokenFromEnv(env: Record<string, string | undefined> = process.env): () => Promise<string | null> {
  const id = env.REDDIT_CLIENT_ID;
  const secret = env.REDDIT_CLIENT_SECRET;
  let cached: { token: string; until: number } | null = null;
  let failed = false;
  let inflight: Promise<string | null> | null = null;
  return async () => {
    if (!id || !secret || failed) return null;
    if (cached && Date.now() < cached.until) return cached.token;
    inflight ??= (async () => {
      try {
        const res = await fetch("https://www.reddit.com/api/v1/access_token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": REDDIT_UA,
          },
          body: "grant_type=client_credentials",
        });
        const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
        if (!res.ok || !j.access_token) {
          failed = true;
          return null;
        }
        cached = { token: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000 };
        return cached.token;
      } catch {
        failed = true;
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };
}
