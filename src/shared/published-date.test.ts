import { describe, expect, test } from "bun:test";
import {
  extractPublishedAt,
  extractPublishedAtWithMethod,
  isPrivateAddress,
  normalizePublishedDate,
  publishedAtFromUrl,
  skipReason,
} from "./published-date.ts";

const now = new Date("2026-09-25T12:00:00Z");
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe("normalizePublishedDate", () => {
  test("ISO with zone keeps the instant", () => {
    expect(normalizePublishedDate("2024-03-05T10:15:00-05:00", { now })).toBe("2024-03-05T15:15:00.000Z");
    expect(normalizePublishedDate("2024-03-05T10:15:00+0100", { now })).toBe("2024-03-05T09:15:00.000Z");
  });
  test("datetime without zone is UTC; space separator accepted", () => {
    expect(normalizePublishedDate("2024-03-05 10:15:00", { now })).toBe("2024-03-05T10:15:00.000Z");
    expect(normalizePublishedDate("2024-03-05T9:05", { now })).toBe("2024-03-05T09:05:00.000Z");
  });
  test("date-only values land at 12:00 UTC", () => {
    expect(normalizePublishedDate("2024-03-05", { now })).toBe("2024-03-05T12:00:00.000Z");
    expect(normalizePublishedDate("2021/06/30", { now })).toBe("2021-06-30T12:00:00.000Z");
    expect(normalizePublishedDate("20210630", { now })).toBe("2021-06-30T12:00:00.000Z");
    expect(normalizePublishedDate("2021/06", { now })).toBe("2021-06-01T12:00:00.000Z");
  });
  test("month names and RFC 2822", () => {
    expect(normalizePublishedDate("March 5, 2024", { now })).toBe("2024-03-05T12:00:00.000Z");
    expect(normalizePublishedDate("Sept 5 2024", { now })).toBe("2024-09-05T12:00:00.000Z");
    expect(normalizePublishedDate("5 June 2024", { now })).toBe("2024-06-05T12:00:00.000Z");
    expect(normalizePublishedDate("Tue, 05 Mar 2024 10:00:00 GMT", { now })).toBe("2024-03-05T10:00:00.000Z");
  });
  test("epoch seconds and milliseconds", () => {
    expect(normalizePublishedDate("1709633700", { now })).toBe("2024-03-05T10:15:00.000Z");
    expect(normalizePublishedDate("1709633700000", { now })).toBe("2024-03-05T10:15:00.000Z");
  });
  test("rejects future, implausibly old, impossible and junk values", () => {
    expect(normalizePublishedDate("2027-01-01", { now })).toBeNull();
    expect(normalizePublishedDate("1970-01-01T00:00:00Z", { now })).toBeNull();
    expect(normalizePublishedDate("1989-12-31", { now })).toBeNull();
    expect(normalizePublishedDate("2024-02-31", { now })).toBeNull();
    expect(normalizePublishedDate("yesterday", { now })).toBeNull();
    expect(normalizePublishedDate("03/05/2024", { now })).toBeNull(); // ambiguous US/EU order
    expect(normalizePublishedDate("", { now })).toBeNull();
    expect(normalizePublishedDate(null, { now })).toBeNull();
  });
  test("tomorrow is allowed as clock slop", () => {
    expect(normalizePublishedDate("2026-09-26T06:00:00Z", { now })).toBe("2026-09-26T06:00:00.000Z");
  });
});

describe("extractPublishedAt: JSON-LD", () => {
  test("plain NewsArticle", () => {
    const html = ld({ "@context": "https://schema.org", "@type": "NewsArticle", datePublished: "2024-03-05T10:00:00Z", dateModified: "2025-01-01T00:00:00Z" });
    expect(extractPublishedAtWithMethod(html, { now })).toEqual({ publishedAt: "2024-03-05T10:00:00.000Z", method: "json-ld:newsarticle" });
  });
  test("@graph: prefers the article over the WebPage node", () => {
    const html = ld({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", datePublished: "2020-01-01T00:00:00Z" },
        { "@type": "BlogPosting", datePublished: "2023-07-04T08:30:00Z" },
      ],
    });
    expect(extractPublishedAt(html, { now })).toBe("2023-07-04T08:30:00.000Z");
  });
  test("falls back to a WebPage node when there is no article", () => {
    const html = ld({ "@graph": [{ "@type": "WebSite", datePublished: "2019-01-01" }, { "@type": "WebPage", datePublished: "2022-02-02" }] });
    expect(extractPublishedAt(html, { now })).toBe("2022-02-02T12:00:00.000Z");
  });
  test("top-level array and @type arrays", () => {
    const html = ld([{ "@type": "Organization", name: "x" }, { "@type": ["Article", "TechArticle"], datePublished: "2021-05-06" }]);
    expect(extractPublishedAt(html, { now })).toBe("2021-05-06T12:00:00.000Z");
  });
  test("VideoObject uses uploadDate when datePublished is missing", () => {
    const html = ld({ "@type": "VideoObject", uploadDate: "2022-10-11T00:00:00-07:00" });
    expect(extractPublishedAt(html, { now })).toBe("2022-10-11T07:00:00.000Z");
  });
  test("ignores dateModified-only pages and comment dates", () => {
    expect(extractPublishedAt(ld({ "@type": "Article", dateModified: "2024-01-01" }), { now })).toBeNull();
    const html = ld({ "@type": "Comment", datePublished: "2024-01-01" });
    expect(extractPublishedAt(html, { now })).toBeNull();
  });
  test("nested comments inside the article do not win", () => {
    const html = ld({ "@type": "Article", datePublished: "2020-05-05", comment: [{ "@type": "Comment", datePublished: "2024-01-01" }] });
    expect(extractPublishedAt(html, { now })).toBe("2020-05-05T12:00:00.000Z");
  });
  test("tolerates trailing commas, CDATA and a later valid block", () => {
    const bad = `<script type="application/ld+json">{ "@type": "Article", "datePublished": "2020-05-05", }</script>`;
    expect(extractPublishedAt(bad, { now })).toBe("2020-05-05T12:00:00.000Z");
    const cdata = `<script type='application/ld+json'>//<![CDATA[\n{"@type":"Article","datePublished":"2020-05-05"}\n//]]></script>`;
    // The "//" before CDATA is not JSON; we skip it and find nothing rather than crash.
    expect(() => extractPublishedAt(cdata, { now })).not.toThrow();
    const two = `<script type="application/ld+json">not json</script>${ld({ "@type": "Article", datePublished: "2018-08-08" })}`;
    expect(extractPublishedAt(two, { now })).toBe("2018-08-08T12:00:00.000Z");
  });
  test("mainEntity article inside a QAPage-less WebPage", () => {
    const html = ld({ "@type": "WebPage", mainEntity: { "@type": "Article", datePublished: "2017-03-03" } });
    expect(extractPublishedAt(html, { now })).toBe("2017-03-03T12:00:00.000Z");
  });
  test("future JSON-LD date falls through to meta", () => {
    const html = ld({ "@type": "Article", datePublished: "2099-01-01" }) + `<meta property="article:published_time" content="2024-01-02T03:04:05Z">`;
    expect(extractPublishedAtWithMethod(html, { now })?.method).toBe("meta:article:published_time");
  });
});

describe("extractPublishedAt: meta tags", () => {
  test("article:published_time with attributes in either order", () => {
    expect(extractPublishedAt(`<meta content="2024-03-05T10:00:00Z" property="article:published_time" />`, { now })).toBe("2024-03-05T10:00:00.000Z");
    expect(extractPublishedAt(`<META PROPERTY='article:published_time' CONTENT='2024-03-05'>`, { now })).toBe("2024-03-05T12:00:00.000Z");
  });
  test("og variants", () => {
    expect(extractPublishedAtWithMethod(`<meta property="og:article:published_time" content="2023-01-01">`, { now })?.method).toBe("meta:og:article:published_time");
    expect(extractPublishedAtWithMethod(`<meta property="og:published_time" content="2023-01-01">`, { now })?.method).toBe("meta:og:published_time");
  });
  test("name= family: date, pubdate, dc.date, citation, sailthru, parsely", () => {
    for (const [name, value, want] of [
      ["date", "2022-04-04", "2022-04-04T12:00:00.000Z"],
      ["pubdate", "20220404", "2022-04-04T12:00:00.000Z"],
      ["DC.date", "2022-04-04", "2022-04-04T12:00:00.000Z"],
      ["citation_publication_date", "2022/04/04", "2022-04-04T12:00:00.000Z"],
      ["sailthru.date", "2022-04-04 10:00:00", "2022-04-04T10:00:00.000Z"],
      ["parsely-pub-date", "2022-04-04T10:00:00Z", "2022-04-04T10:00:00.000Z"],
    ]) {
      expect(extractPublishedAt(`<meta name="${name}" content="${value}">`, { now })).toBe(want);
    }
  });
  test("prefers article:published_time over the generic date meta", () => {
    const html = `<meta name="date" content="2021-01-01"><meta property="article:published_time" content="2020-06-06T00:00:00Z">`;
    expect(extractPublishedAt(html, { now })).toBe("2020-06-06T00:00:00.000Z");
  });
  test("never uses modified/lastmod", () => {
    const html = `<meta property="article:modified_time" content="2024-01-01"><meta name="lastmod" content="2024-01-01"><meta property="og:updated_time" content="2024-01-01">`;
    expect(extractPublishedAt(html, { now })).toBeNull();
  });
  test("decodes entities in content", () => {
    expect(extractPublishedAt(`<meta name="date" content="2022-04-04T10:00:00&#43;00:00">`, { now })).toBe("2022-04-04T10:00:00.000Z");
  });
});

describe("extractPublishedAt: microdata and <time>", () => {
  test("itemprop datePublished on meta and time", () => {
    expect(extractPublishedAt(`<meta itemprop="datePublished" content="2016-02-02">`, { now })).toBe("2016-02-02T12:00:00.000Z");
    expect(extractPublishedAt(`<time itemprop="datePublished" datetime="2016-02-02T01:02:03Z">Feb 2</time>`, { now })).toBe("2016-02-02T01:02:03.000Z");
    expect(extractPublishedAt(`<span itemprop="datePublished">March 5, 2024</span>`, { now })).toBe("2024-03-05T12:00:00.000Z");
  });
  test("itemprop dateModified is ignored", () => {
    expect(extractPublishedAt(`<meta itemprop="dateModified" content="2016-02-02">`, { now })).toBeNull();
  });
  test("<time datetime> inside <article> is the last resort", () => {
    const html = `<header><time datetime="2025-01-01">nav date</time></header><article><h1>x</h1><time datetime="2019-09-09T09:09:09Z">Sep 9</time></article>`;
    expect(extractPublishedAtWithMethod(html, { now })).toEqual({ publishedAt: "2019-09-09T09:09:09.000Z", method: "article-time" });
  });
  test("<time pubdate> wins inside the article", () => {
    const html = `<article><time datetime="2024-01-01">updated</time><time pubdate datetime="2019-09-09">posted</time></article>`;
    expect(extractPublishedAt(html, { now })).toBe("2019-09-09T12:00:00.000Z");
  });
  test("pages with several <article> cards are listings: no article-time", () => {
    const html = `<article><time datetime="2026-09-01">card 1</time></article><article><time datetime="2026-08-01">card 2</time></article>`;
    expect(extractPublishedAt(html, { now })).toBeNull();
  });
  test("a <time> labelled as an update is skipped", () => {
    const html = `<article><span>Last validated: <time datetime="2026-01-09">Jan 9</time></span></article>`;
    expect(extractPublishedAt(html, { now })).toBeNull();
    const both = `<article><div><span>Model created</span> <time datetime="2025-12-10T17:09:24Z">x</time></div><div><span>Model updated</span> <time datetime="2026-06-25T00:00:00Z">y</time></div></article>`;
    expect(extractPublishedAt(both, { now })).toBe("2025-12-10T17:09:24.000Z");
    const updatedFirst = `<article><p>Updated <time datetime="2026-06-25">y</time></p><p>Posted <time datetime="2024-01-02">x</time></p></article>`;
    expect(extractPublishedAt(updatedFirst, { now })).toBe("2024-01-02T12:00:00.000Z");
  });
  test("a <time> outside any <article> is not used", () => {
    expect(extractPublishedAt(`<div><time datetime="2019-09-09">x</time></div>`, { now })).toBeNull();
  });
  test("no markup → null", () => {
    expect(extractPublishedAt(`<html><head><title>Hi</title></head><body>2024-01-01</body></html>`, { now })).toBeNull();
    expect(extractPublishedAt("", { now })).toBeNull();
  });
});

describe("publishedAtFromUrl", () => {
  test("X/Twitter status Snowflake IDs", () => {
    // Known tweet: 2036837084628127781 was saved 2026-03-25 and posted the same day.
    const r = publishedAtFromUrl("https://x.com/aidenybai/status/2036837084628127781", { now });
    expect(r?.method).toBe("x-snowflake");
    expect(r?.publishedAt.startsWith("2026-03-25")).toBe(true);
    // Jack's first Snowflake-era examples: 20 is pre-Snowflake and has no timestamp.
    expect(publishedAtFromUrl("https://twitter.com/jack/status/20", { now })).toBeNull();
    expect(publishedAtFromUrl("https://twitter.com/i/web/status/1350000000000000000", { now })?.publishedAt.startsWith("2021-01-15")).toBe(true);
  });
  test("non-status X pages and other hosts → null", () => {
    expect(publishedAtFromUrl("https://x.com/i/history", { now })).toBeNull();
    expect(publishedAtFromUrl("https://example.com/status/2036837084628127781", { now })).toBeNull();
    expect(publishedAtFromUrl("not a url", { now })).toBeNull();
  });
});

describe("skipReason", () => {
  test("local, private and non-web URLs", () => {
    expect(skipReason("http://localhost:4890/")).toBe("local-host");
    expect(skipReason("http://myapp.localhost/")).toBe("local-host");
    expect(skipReason("http://100.76.116.103:8081/x")).toBe("private-address");
    expect(skipReason("http://192.168.1.10/")).toBe("private-address");
    expect(skipReason("http://[::1]:3000/")).toBe("private-address");
    expect(skipReason("chrome://extensions")).toBe("non-web-scheme");
    expect(skipReason("vivaldi://settings")).toBe("non-web-scheme");
    expect(skipReason("file:///Users/x/a.html")).toBe("non-web-scheme");
    expect(skipReason("garbage")).toBe("invalid-url");
  });
  test("signed-in apps, search and shopping", () => {
    for (const u of [
      "https://mail.google.com/mail/u/0/#inbox",
      "https://docs.google.com/document/d/abc/edit",
      "https://www.google.com/search?q=x",
      "https://www.notion.so/page-123",
      "https://claude.ai/chat/abc",
      "https://github.com/notifications",
      "https://github.com/",
      "https://www.amazon.ca/dp/B000",
      "https://app.scan-ai.ca/dashboard",
      "https://x.com/i/history",
    ]) expect(skipReason(u)).toBe("app-or-shopping");
  });
  test("content pages are resolved", () => {
    for (const u of [
      "https://github.com/anthropics/claude-code",
      "https://github.com/anthropics/claude-code/issues/1",
      "https://x.com/aidenybai/status/2036837084628127781",
      "https://en.wikipedia.org/wiki/Gnosticism",
      "https://www.reddit.com/r/ClaudeAI/comments/abc/x/",
    ]) expect(skipReason(u)).toBeNull();
  });
  test("isPrivateAddress boundaries", () => {
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("100.63.0.1")).toBe(false);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("example.com")).toBe(false);
  });
});
