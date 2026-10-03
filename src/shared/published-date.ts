/**
 * When a web page first came out, read from what the page itself declares.
 *
 * Pure functions only (no network, no DB) so capture, the backfill script and
 * the sweep runner share one set of rules:
 *
 * - `extractPublishedAt(html)` reads the page's own publish-date markup, most
 *   trustworthy first: JSON-LD `datePublished`, `article:published_time`-style
 *   meta tags, `itemprop="datePublished"`, the `date`/`dc.date`/`citation_*`
 *   meta family, and finally a `<time datetime>` inside `<article>`.
 *   Modified dates (`dateModified`, `article:modified_time`, `lastmod`) are
 *   never used: they say when the page last changed, not when it came out.
 * - `publishedAtFromUrl(url)` covers hosts whose URL alone encodes the time
 *   (X/Twitter status IDs are Snowflake IDs with a millisecond timestamp).
 * - `skipReason(url)` names URLs that have no publish date to find: local and
 *   private addresses, non-web schemes, and signed-in app pages.
 *
 * Every result is an ISO-8601 UTC string, or null. Callers store null when
 * nothing is found and never substitute the saved date.
 */

/** Earliest plausible publish date. Older values are almost always parse junk. */
const MIN_PLAUSIBLE_MS = Date.UTC(1990, 0, 1);
/** Allow a day of clock skew / timezone slop before calling a date "future". */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

export interface DateCheckOptions {
  /** Reference "now" for the future-date check (tests pass a fixed value). */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Date normalisation
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a declared date into ISO-8601 UTC, or null when it is unparseable,
 * in the future, or before 1990.
 *
 * Date-only values ("2024-03-05") become 12:00 UTC so they show the same
 * calendar day in every timezone from UTC-11 to UTC+11. Datetimes without a
 * zone are read as UTC.
 */
export function normalizePublishedDate(raw: unknown, opts: DateCheckOptions = {}): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let ms = NaN;

  // Unix epoch seconds or milliseconds.
  if (/^\d{10}(\.\d+)?$/.test(s)) ms = Number(s) * 1000;
  else if (/^\d{13}$/.test(s)) ms = Number(s);

  // Compact YYYYMMDD (citation_date, some CMSes).
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (Number.isNaN(ms) && m) ms = dateOnly(+m[1], +m[2], +m[3]);

  // Date only, with - / or . separators: 2024-03-05, 2024/03/05, 2024.03.05.
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (Number.isNaN(ms) && m) ms = dateOnly(+m[1], +m[2], +m[3]);

  // Year-month only (citation_publication_date "2021/06") → the 1st of the month.
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (Number.isNaN(ms) && m) ms = dateOnly(+m[1], +m[2], 1);

  // ISO-like datetime. "2024-03-05 10:00:00" → T; no zone → UTC.
  m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?$/i);
  if (Number.isNaN(ms) && m) {
    let zone = (m[3] ?? "Z").toUpperCase();
    if (zone === "UTC" || zone === "GMT") zone = "Z";
    if (/^[+-]\d{4}$/.test(zone)) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const time = m[2].replace(",", ".").replace(/^(\d):/, "0$1:");
    ms = Date.parse(`${m[1]}T${time}${zone}`);
  }

  // "March 5, 2024" / "5 March 2024" (date only).
  if (Number.isNaN(ms)) {
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
    const mon = m ? monthIndex(m[1]) : undefined;
    if (m && mon !== undefined) ms = dateOnly(+m[3], mon + 1, +m[2]);
  }
  if (Number.isNaN(ms)) {
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    const mon = m ? monthIndex(m[2]) : undefined;
    if (m && mon !== undefined) ms = dateOnly(+m[3], mon + 1, +m[1]);
  }

  // Anything else with an explicit zone or weekday (RFC 2822: "Tue, 05 Mar 2024 10:00:00 GMT").
  if (Number.isNaN(ms) && /[A-Za-z]{3},?\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{1,2}:\d{2}/.test(s)) {
    ms = Date.parse(s);
  }

  if (!Number.isFinite(ms)) return null;
  return plausible(ms, opts) ? new Date(ms).toISOString() : null;
}

function monthIndex(name: string): number | undefined {
  const n = name.toLowerCase();
  return MONTHS[n.slice(0, 4)] ?? MONTHS[n.slice(0, 3)];
}

function dateOnly(y: number, mo: number, d: number): number {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  const ms = Date.UTC(y, mo - 1, d, 12);
  // Reject roll-overs such as 2024-02-31.
  return new Date(ms).getUTCDate() === d ? ms : NaN;
}

function plausible(ms: number, opts: DateCheckOptions): boolean {
  const now = (opts.now ?? new Date()).getTime();
  return ms >= MIN_PLAUSIBLE_MS && ms <= now + FUTURE_SLACK_MS;
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

export interface ExtractedPublishDate {
  publishedAt: string;
  /** Which markup supplied it, e.g. "json-ld:NewsArticle" or "meta:article:published_time". */
  method: string;
}

/** Page publish date from HTML, or null. See the module comment for the order. */
export function extractPublishedAt(html: string, opts: DateCheckOptions = {}): string | null {
  return extractPublishedAtWithMethod(html, opts)?.publishedAt ?? null;
}

export function extractPublishedAtWithMethod(html: string, opts: DateCheckOptions = {}): ExtractedPublishDate | null {
  if (!html) return null;
  return fromJsonLd(html, opts) ?? fromMetaTags(html, opts) ?? fromItemprop(html, opts) ?? fromArticleTime(html, opts);
}

// --- JSON-LD ---

/** Types whose datePublished is the page's own publish date. */
const ARTICLE_TYPES = new Set([
  "article", "newsarticle", "blogposting", "techarticle", "scholarlyarticle", "report", "reportagenewsarticle",
  "analysisnewsarticle", "opinionnewsarticle", "backgroundnewsarticle", "videoobject", "socialmediaposting",
  "discussionforumposting", "liveblogposting", "podcastepisode", "audioobject", "howto", "recipe", "qapage",
]);
/** Types whose datePublished describes something else (a comment, a reviewer, an offer). */
const IGNORED_TYPES = new Set([
  "comment", "review", "answer", "question", "rating", "aggregaterating", "offer", "person", "organization",
  "breadcrumblist", "listitem", "imageobject", "searchaction", "website",
]);

type JsonNode = Record<string, unknown>;

function fromJsonLd(html: string, opts: DateCheckOptions): ExtractedPublishDate | null {
  const nodes: JsonNode[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const parsed = parseJsonLoose(m[1]);
    if (parsed !== undefined) collectNodes(parsed, nodes, 0);
  }
  // Rank: article-like types first, then other creative works (WebPage, …).
  let best: { rank: number; out: ExtractedPublishDate } | null = null;
  for (const node of nodes) {
    const types = typesOf(node);
    if (types.some((t) => IGNORED_TYPES.has(t))) continue;
    const isArticle = types.some((t) => ARTICLE_TYPES.has(t));
    const isVideo = types.includes("videoobject");
    const raw = firstString(node.datePublished) ?? (isVideo ? firstString(node.uploadDate) : undefined);
    const iso = normalizePublishedDate(raw, opts);
    if (!iso) continue;
    const rank = isArticle ? 0 : 1;
    if (!best || rank < best.rank) best = { rank, out: { publishedAt: iso, method: `json-ld:${types[0] ?? "untyped"}` } };
    if (rank === 0) break;
  }
  return best?.out ?? null;
}

/** Top-level nodes, arrays and @graph members, plus a node's mainEntity — but not
 * nested comments, reviews or authors, whose dates are not the page's. */
function collectNodes(value: unknown, out: JsonNode[], depth: number): void {
  if (depth > 4 || value == null) return;
  if (Array.isArray(value)) {
    for (const v of value) collectNodes(v, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const node = value as JsonNode;
  out.push(node);
  if (node["@graph"]) collectNodes(node["@graph"], out, depth + 1);
  for (const key of ["mainEntity", "mainEntityOfPage"]) {
    const child = node[key];
    if (child && typeof child === "object") collectNodes(child, out, depth + 1);
  }
}

function typesOf(node: JsonNode): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : t == null ? [] : [t];
  return list.map((x) => String(x).replace(/^.*[/#]/, "").toLowerCase());
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(firstString).find(Boolean);
  if (v && typeof v === "object" && "@value" in (v as JsonNode)) return firstString((v as JsonNode)["@value"]);
  return undefined;
}

function parseJsonLoose(text: string): unknown {
  const cleaned = decodeEntities(text.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").replace(/^\s*<!--|-->\s*$/g, "").trim());
  if (!cleaned) return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    // Some CMSes emit trailing commas or raw newlines inside strings.
    try {
      return JSON.parse(cleaned.replace(/,\s*([}\]])/g, "$1").replace(/[\r\n\t]+/g, " "));
    } catch {
      return undefined;
    }
  }
}

// --- meta tags ---

/** Meta keys (property= or name=, lower-cased) in trust order. */
const META_KEYS = [
  "article:published_time",
  "og:article:published_time",
  "og:published_time",
  "article:published",
  "article.published",
  "datepublished",
  "published_time",
  "publish-date",
  "publish_date",
  "publishdate",
  "pubdate",
  "parsely-pub-date",
  "sailthru.date",
  "citation_publication_date",
  "citation_online_date",
  "citation_date",
  "dc.date.issued",
  "dcterms.issued",
  "dc.date",
  "dcterms.date",
  "date",
  "original-publish-date",
];

interface Tag { attrs: Record<string, string> }

function fromMetaTags(html: string, opts: DateCheckOptions): ExtractedPublishDate | null {
  const found = new Map<string, string>();
  for (const tag of tagsNamed(html, "meta")) {
    const key = (tag.attrs.property ?? tag.attrs.name ?? tag.attrs["http-equiv"] ?? "").toLowerCase().trim();
    const content = tag.attrs.content;
    if (!key || content == null || found.has(key)) continue;
    found.set(key, content);
  }
  for (const key of META_KEYS) {
    const iso = normalizePublishedDate(found.get(key), opts);
    if (iso) return { publishedAt: iso, method: `meta:${key}` };
  }
  return null;
}

// --- itemprop="datePublished" (microdata) ---

function fromItemprop(html: string, opts: DateCheckOptions): ExtractedPublishDate | null {
  const re = /<([a-z][a-z0-9]*)\b([^>]*\bitemprop\s*=\s*["']?[^"'>]*\bdatePublished\b[^>]*)>([^<]{0,80})/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = parseAttrs(m[2]);
    const iso = normalizePublishedDate(attrs.content ?? attrs.datetime ?? decodeEntities(m[3]), opts);
    if (iso) return { publishedAt: iso, method: "itemprop:datePublished" };
  }
  return null;
}

// --- <time datetime> inside <article> (last resort) ---

function fromArticleTime(html: string, opts: DateCheckOptions): ExtractedPublishDate | null {
  // Only a page that is one article: listing pages (home pages, model hubs,
  // collections) hold many <article> cards whose dates belong to the cards.
  const articles = html.match(/<article\b/gi);
  if (!articles || articles.length !== 1) return null;
  const article = html.match(/<article\b[^>]*>([\s\S]*?)(?:<\/article>|$)/i);
  if (!article) return null;
  const body = article[1];
  const re = /<time\b([^>]*)>/gi;
  const times: Array<{ attrs: Record<string, string>; label: string }> = [];
  for (let m = re.exec(body); m; m = re.exec(body)) {
    // The visible label just before the <time>: "Updated", "Last validated", …
    // (only text after the previous </time>, so one date's text never labels the next)
    const before = body.slice(Math.max(0, m.index - 300), m.index);
    const prevEnd = before.toLowerCase().lastIndexOf("</time>");
    const label = before.slice(prevEnd < 0 ? 0 : prevEnd + 7).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(-40);
    times.push({ attrs: parseAttrs(m[1]), label });
  }
  // A <time pubdate> is an explicit publish marker; otherwise the first <time>
  // in the article that is not labelled as an update.
  const ordered = [...times.filter((t) => "pubdate" in t.attrs), ...times];
  for (const t of ordered) {
    if (MODIFIED_LABEL.test(t.label)) continue;
    const iso = normalizePublishedDate(t.attrs.datetime, opts);
    if (iso) return { publishedAt: iso, method: "article-time" };
  }
  return null;
}

const MODIFIED_LABEL = /(updated|modified|validated|edited|revised|reviewed|last)\W*(on|at)?\W*$/i;

// --- tiny HTML helpers ---

function tagsNamed(html: string, name: string): Tag[] {
  const out: Tag[] = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  for (let m = re.exec(html); m; m = re.exec(html)) out.push({ attrs: parseAttrs(m[1]) });
  return out;
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const key = m[1].toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// URL rules
// ---------------------------------------------------------------------------

/** Milliseconds since the Unix epoch at Twitter's Snowflake epoch (2010-11-04). */
const TWITTER_EPOCH_MS = 1288834974657n;
/** Status IDs below this predate Snowflake (sequential, no timestamp inside). */
const MIN_SNOWFLAKE_ID = 1n << 42n;

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "www.x.com", "www.twitter.com"]);

/**
 * Publish date from the URL alone, with no network: an X/Twitter status ID
 * encodes its post time. Returns null for every other URL.
 */
export function publishedAtFromUrl(url: string, opts: DateCheckOptions = {}): ExtractedPublishDate | null {
  const u = safeUrl(url);
  if (!u) return null;
  if (X_HOSTS.has(u.hostname.toLowerCase())) {
    const m = u.pathname.match(/\/status(?:es)?\/(\d{15,20})(?:\/|$)/);
    if (!m) return null;
    const id = BigInt(m[1]);
    if (id < MIN_SNOWFLAKE_ID) return null;
    const ms = Number((id >> 22n) + TWITTER_EPOCH_MS);
    return plausible(ms, opts) ? { publishedAt: new Date(ms).toISOString(), method: "x-snowflake" } : null;
  }
  return null;
}

/** Hosts that only serve signed-in app pages or shopping pages: no publish date to find. */
const NO_DATE_HOSTS = [
  "mail.google.com", "docs.google.com", "drive.google.com", "calendar.google.com", "meet.google.com",
  "gemini.google.com", "aistudio.google.com", "photos.google.com", "keep.google.com", "console.cloud.google.com",
  "myaccount.google.com", "notebooklm.google.com", "accounts.google.com",
  "claude.ai", "platform.claude.com", "console.anthropic.com", "chatgpt.com", "chat.openai.com", "platform.openai.com",
  "notion.so", "www.notion.so", "app.slack.com", "outlook.live.com", "outlook.office.com",
  "www.linkedin.com", "linkedin.com", "www.facebook.com", "facebook.com", "www.instagram.com", "instagram.com",
  "web.whatsapp.com", "web.telegram.org", "discord.com",
];
/** Suffix matches: any subdomain counts. */
const NO_DATE_SUFFIXES = [".localhost", ".local", ".internal", ".ts.net", ".lan", ".home.arpa"];
/** Shopping and search hosts: product and result pages carry no publish date. */
const NO_DATE_HOST_PATTERNS = [
  /^(www\.)?google\.[a-z.]+$/, /^(www\.)?amazon\.[a-z.]+$/, /^(www\.)?costco\.[a-z.]+$/, /^(www\.)?walmart\.[a-z.]+$/,
  /^(www\.)?bing\.com$/, /^(www\.)?duckduckgo\.com$/, /^(www\.)?ebay\.[a-z.]+$/,
];
/** GitHub paths that are signed-in app screens rather than content. */
const GITHUB_APP_PATHS = /^\/(notifications|settings|pulls|issues|search|new|codespaces|dashboard|login|logout|sessions|marketplace|sponsors|account|organizations|orgs\/[^/]+\/(settings|people)|copilot)(\/|$)/;

/**
 * Why a URL has no publish date worth looking up, or null when it should be
 * resolved. Private and local addresses, non-web schemes, signed-in app pages,
 * shopping and search pages.
 */
export function skipReason(url: string): string | null {
  const u = safeUrl(url);
  if (!u) return "invalid-url";
  if (u.protocol !== "http:" && u.protocol !== "https:") return "non-web-scheme";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || NO_DATE_SUFFIXES.some((s) => host.endsWith(s))) return "local-host";
  if (isPrivateAddress(host)) return "private-address";
  if (NO_DATE_HOSTS.includes(host) || NO_DATE_HOST_PATTERNS.some((re) => re.test(host))) return "app-or-shopping";
  if (host.startsWith("app.") || host.startsWith("dashboard.") || host.startsWith("console.") || host.startsWith("admin.")) return "app-or-shopping";
  if (X_HOSTS.has(host) && !/\/status(?:es)?\/\d/.test(u.pathname)) return "app-or-shopping";
  if (host === "github.com" && (u.pathname === "/" || GITHUB_APP_PATHS.test(u.pathname))) return "app-or-shopping";
  return null;
}

/** Loopback, RFC 1918, link-local, CGNAT/Tailscale (100.64/10) and IPv6 local addresses. */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80");
  return false;
}

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}
