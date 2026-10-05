// Mirrors vivaldi-home/lib/canon.ts, which merges these duplicates in the Library view;
// keep the two in step. Used here to keep one copy of each page in the search pool.

// Tracking or session parameters dropped on every site.
const TRACKING = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "igshid", "igsh", "mc_cid", "mc_eid",
  "_hsenc", "_hsmi", "mkt_tok", "ref", "ref_src", "ref_url", "referrer", "si", "feature", "share", "sharing", "spm",
  "trk", "trkcampaign", "srsltid", "gad_source", "gad_campaignid", "cmpid", "ncid", "s_cid", "smid", "rdt", "__s",
]);
const TRACKING_PREFIX = /^(utm_|pk_|mtm_|oly_|pd_rd_|pf_rd_)/;
// Extra parameters that only mean something on these hosts' own analytics.
const HOST_TRACKING: [RegExp, Set<string>][] = [
  [/^google\./, new Set(["sxsrf", "ved", "ei", "biw", "bih", "oq", "gs_lp", "gs_lcrp", "sclient", "sca_esv", "sca_upv", "sourceid", "ie", "oe", "uact", "sa", "dpr", "rlz", "client", "aqs", "iflsig", "source"])],
  [/^(x|twitter)\.com$/, new Set(["s", "t"])],
  [/^amazon\./, new Set(["psc", "th", "crid", "sprefix", "sp_csd", "content-id", "tag", "linkcode", "qid", "sr", "keywords", "dib", "dib_tag"])],
  [/^medium\.com$|\.medium\.com$/, new Set(["source"])],
];
const SUBDOMAIN_DROP = /^(www\d?|m|mobile|amp)\./;

export function canonicalUrl(raw: string | null | undefined): string | null {
  let s = (raw ?? "").trim();
  if (!s) return null;
  if (s.startsWith("/r/")) s = "https://reddit.com" + s; // some Reddit saves keep only the path
  let u: URL;
  try { u = new URL(/^[a-z][\w+.-]*:/i.test(s) ? s : "https://" + s); } catch { return s.toLowerCase(); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return s.toLowerCase().replace(/#.*$/, "");

  let host = u.hostname.toLowerCase().replace(/\.$/, "");
  while (SUBDOMAIN_DROP.test(host) && host.split(".").length > 2) host = host.replace(SUBDOMAIN_DROP, "");
  if (host === "twitter.com") host = "x.com";
  if (host.endsWith(".reddit.com")) host = "reddit.com"; // old., new., np.
  if (u.port) host += ":" + u.port;
  let path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "";

  // YouTube: every link form of one video becomes youtube.com/watch?v=ID.
  const yt = youtubeId(host, path, u.searchParams);
  if (yt) return `youtube.com/watch?v=${yt}`;
  // Reddit post: /r/sub/comments/ID/slug and redd.it/ID become reddit.com/comments/ID.
  const rd = host === "redd.it" ? path.match(/^\/(\w+)$/)?.[1] : host === "reddit.com" ? path.match(/\/comments\/(\w+)/i)?.[1] : null;
  if (rd) return `reddit.com/comments/${rd.toLowerCase()}`;
  // arXiv: abs and pdf pages, with or without a version, are one paper.
  const ax = host === "arxiv.org" ? path.match(/^\/(?:abs|pdf|html)\/(.+?)(?:v\d+)?(?:\.pdf)?$/)?.[1] : null;
  if (ax) return `arxiv.org/abs/${ax}`;
  // Amazon product pages: /Some-Slug/dp/ASIN/ref=… and /gp/product/ASIN become /dp/ASIN.
  const asin = /^amazon\./.test(host) ? path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1] : null;
  if (asin) return `${host}/dp/${asin.toUpperCase()}`;
  // GitHub owner/repo names are case-insensitive.
  if (host === "github.com") path = path.toLowerCase();

  const extra = HOST_TRACKING.filter(([re]) => re.test(host)).map(([, set]) => set);
  const kept = [...u.searchParams].filter(([k]) => {
    const lk = k.toLowerCase();
    return !TRACKING.has(lk) && !TRACKING_PREFIX.test(lk) && !extra.some(set => set.has(lk));
  }).sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0);
  const qs = kept.length ? "?" + new URLSearchParams(kept).toString() : "";
  return host + path + qs;
}

export function youtubeId(host: string, path: string, q: URLSearchParams): string | null {
  const id = /^[\w-]{11}$/;
  if (host === "youtu.be") { const v = path.slice(1).split("/")[0]; return id.test(v) ? v : null; }
  if (host !== "youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com") return null;
  if (path === "/watch") { const v = q.get("v") ?? ""; return id.test(v) ? v : null; }
  const m = path.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})$/);
  return m ? m[1] : null;
}

// The host shown on cards and used by the Site filter: the canonical key's host part.
export const canonicalHost = (key: string | null) => key && /^[a-z0-9.-]+(:\d+)?(\/|\?|$)/.test(key) ? key.split(/[/?]/)[0] : null;
