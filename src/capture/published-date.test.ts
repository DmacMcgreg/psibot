import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostThrottle, resolvePublishedAt, youtubeVideoId, type ResolverDeps } from "./published-date-resolver.ts";
import { coverage, recordPageDate, rejectAfterSave, sweepPublishedDates } from "./published-date-sweep.ts";

const now = new Date("2026-09-25T12:00:00Z");
const noWait = new HostThrottle(0, {});

/** Fake fetch: maps URL → response; records every request. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const html = (body: string) => () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const json = (obj: unknown) => () => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } });

describe("resolvePublishedAt", () => {
  const base = (f: ReturnType<typeof fakeFetch>): ResolverDeps => ({ fetchImpl: f.impl, throttle: noWait, now });

  test("skips private and app URLs without any request", async () => {
    const f = fakeFetch({});
    for (const u of ["http://100.76.116.103:8081/", "https://mail.google.com/mail/u/0", "chrome://newtab", "https://github.com/notifications"]) {
      const r = await resolvePublishedAt(u, base(f));
      expect(r.status).toBe("skipped");
    }
    expect(f.calls).toEqual([]);
  });

  test("X status: Snowflake, no request", async () => {
    const f = fakeFetch({});
    const r = await resolvePublishedAt("https://x.com/a/status/2036837084628127781", base(f));
    expect(r).toMatchObject({ status: "found", method: "x-snowflake" });
    expect(f.calls).toEqual([]);
  });

  test("generic page: JSON-LD from fetched HTML", async () => {
    const f = fakeFetch({
      "https://blog.example.com/post": html(`<html><head><script type="application/ld+json">{"@type":"BlogPosting","datePublished":"2025-02-03T04:05:06Z","dateModified":"2026-01-01"}</script></head></html>`),
    });
    const r = await resolvePublishedAt("https://blog.example.com/post", base(f));
    expect(r).toEqual({ publishedAt: "2025-02-03T04:05:06.000Z", status: "found", method: "json-ld:blogposting" });
  });

  test("page without a date → none (never the saved date)", async () => {
    const f = fakeFetch({ "https://example.com/": html("<html><head><title>x</title></head></html>") });
    expect(await resolvePublishedAt("https://example.com/", base(f))).toMatchObject({ publishedAt: null, status: "none" });
  });

  test("HTTP failures are classified", async () => {
    const f = fakeFetch({
      "https://a.example/403": () => new Response("", { status: 403 }),
      "https://a.example/503": () => new Response("", { status: 503 }),
    });
    expect((await resolvePublishedAt("https://a.example/404", base(f))).status).toBe("gone");
    expect((await resolvePublishedAt("https://a.example/403", base(f))).status).toBe("blocked");
    expect((await resolvePublishedAt("https://a.example/503", base(f))).status).toBe("error");
  });

  test("network exception → error", async () => {
    const deps: ResolverDeps = { throttle: noWait, now, fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch };
    expect(await resolvePublishedAt("https://a.example/x", deps)).toMatchObject({ status: "error", error: "ECONNRESET" });
  });

  test("redirect into a private address is not followed", async () => {
    const f = fakeFetch({
      "https://short.example/x": () => new Response(null, { status: 302, headers: { location: "http://192.168.1.5/admin" } }),
    });
    const r = await resolvePublishedAt("https://short.example/x", base(f));
    expect(r).toMatchObject({ status: "skipped", method: "skip:redirect-private-address" });
    expect(f.calls).toEqual(["https://short.example/x"]);
  });

  test("redirects are followed to the article", async () => {
    const f = fakeFetch({
      "https://short.example/y": () => new Response(null, { status: 301, headers: { location: "/final" } }),
      "https://short.example/final": html(`<meta property="article:published_time" content="2024-01-01T00:00:00Z">`),
    });
    expect((await resolvePublishedAt("https://short.example/y", base(f))).publishedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  test("non-HTML responses are not parsed", async () => {
    const f = fakeFetch({ "https://a.example/file.pdf": () => new Response("%PDF", { headers: { "content-type": "application/pdf" } }) });
    expect(await resolvePublishedAt("https://a.example/file.pdf", base(f))).toMatchObject({ status: "none", method: "non-html:application/pdf" });
  });

  test("GitHub: repo, issue and PR use the API with the token", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === "https://api.github.com/repos/o/r") return json({ created_at: "2020-01-02T03:04:05Z" })();
      if (url === "https://api.github.com/repos/o/r/issues/7") return json({ created_at: "2023-05-06T07:08:09Z" })();
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const deps: ResolverDeps = { fetchImpl: impl, throttle: noWait, now, githubToken: "t0ken" };
    expect(await resolvePublishedAt("https://github.com/o/r", deps)).toMatchObject({ publishedAt: "2020-01-02T03:04:05.000Z", method: "github-api:repo" });
    expect(await resolvePublishedAt("https://github.com/o/r/blob/main/README.md", deps)).toMatchObject({ method: "github-api:repo" });
    expect(await resolvePublishedAt("https://github.com/o/r/pull/7", deps)).toMatchObject({ publishedAt: "2023-05-06T07:08:09.000Z", method: "github-api:issue" });
    expect(await resolvePublishedAt("https://github.com/o/gone", deps)).toMatchObject({ status: "gone" });
    expect(await resolvePublishedAt("https://github.com/someuser", deps)).toMatchObject({ status: "skipped" });
    expect(seen.every((s) => s.auth === "Bearer t0ken")).toBe(true);
  });

  test("arXiv uses the export API's <published>", async () => {
    const f = fakeFetch({
      "https://export.arxiv.org/api/query?id_list=2401.12345": () => new Response(
        `<feed><updated>2026-01-01</updated><entry><updated>2024-02-01T00:00:00Z</updated><published>2024-01-22T18:00:00Z</published></entry></feed>`,
      ),
    });
    expect(await resolvePublishedAt("https://arxiv.org/abs/2401.12345v3", base(f))).toMatchObject({ publishedAt: "2024-01-22T18:00:00.000Z", method: "arxiv-api" });
  });

  test("Hacker News item uses the Firebase API time", async () => {
    const f = fakeFetch({ "https://hacker-news.firebaseio.com/v0/item/44553752.json": json({ id: 44553752, time: 1709633700 }) });
    expect(await resolvePublishedAt("https://news.ycombinator.com/item?id=44553752", base(f))).toMatchObject({ publishedAt: "2024-03-05T10:15:00.000Z", method: "hn-api" });
  });

  test("Hugging Face model uses createdAt", async () => {
    const f = fakeFetch({ "https://huggingface.co/api/models/Qwen/Qwen3-8B": json({ createdAt: "2025-04-28T00:00:00.000Z" }) });
    expect(await resolvePublishedAt("https://huggingface.co/Qwen/Qwen3-8B", base(f))).toMatchObject({ status: "found", method: "hf-api:models" });
  });

  test("Reddit post uses created_utc", async () => {
    const f = fakeFetch({ "https://oauth.reddit.com/api/info?id=t3_abc123&raw_json=1": json({ data: { children: [{ data: { created_utc: 1709633700 } }] } }) });
    const post = "https://www.reddit.com/r/x/comments/abc123/title/";
    expect(await resolvePublishedAt(post, base(f))).toMatchObject({ status: "blocked", error: "no Reddit app credentials" });
    expect(f.calls).toEqual([]);
    const withToken = { ...base(f), redditToken: async () => "tok" };
    expect(await resolvePublishedAt(post, withToken)).toMatchObject({ publishedAt: "2024-03-05T10:15:00.000Z", method: "reddit-api" });
    expect((await resolvePublishedAt("https://www.reddit.com/r/x/", withToken)).status).toBe("skipped");
  });

  test("YouTube: injected lookup, non-video pages skipped", async () => {
    const f = fakeFetch({});
    const deps = { ...base(f), youtubeVideoDate: (id: string) => (id === "dQw4w9WgXcQ" ? "2009-10-25T06:57:33Z" : null) };
    expect(await resolvePublishedAt("https://www.youtube.com/watch?v=dQw4w9WgXcQ", deps)).toMatchObject({ publishedAt: "2009-10-25T06:57:33.000Z", method: "youtube" });
    expect((await resolvePublishedAt("https://www.youtube.com/@channel", deps)).status).toBe("skipped");
    expect(f.calls).toEqual([]);
    expect(youtubeVideoId(new URL("https://youtu.be/abcdefghijk"))).toBe("abcdefghijk");
    expect(youtubeVideoId(new URL("https://www.youtube.com/shorts/abcdefghijk"))).toBe("abcdefghijk");
    expect(youtubeVideoId(new URL("https://example.com/watch?v=x"))).toBeUndefined();
  });

  test("capture reuse: pageDate replaces the fetch for generic pages", async () => {
    const f = fakeFetch({});
    expect(await resolvePublishedAt("https://news.example/a", base(f), { pageDate: "2024-01-01T00:00:00.000Z" })).toMatchObject({ status: "found", method: "page:capture-fetch" });
    expect(await resolvePublishedAt("https://news.example/b", base(f), { pageDate: null })).toMatchObject({ status: "none" });
    expect(f.calls).toEqual([]);
  });
});

describe("HostThrottle", () => {
  test("spaces requests to one host but not across hosts", async () => {
    const t = new HostThrottle(60, {});
    const t0 = Date.now();
    await Promise.all([t.wait("a"), t.wait("a"), t.wait("b")]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("sweepPublishedDates", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "pubdate-"));
    const tabPath = join(dir, "tabs.db");
    const tabs = new Database(tabPath);
    tabs.exec(`CREATE TABLE tab_archive_tabs (id TEXT, url TEXT, excluded INTEGER, status TEXT, archived_at TEXT)`);
    const addTab = tabs.prepare(`INSERT INTO tab_archive_tabs VALUES (?, ?, ?, ?, ?)`);
    addTab.run("t1", "https://blog.example.com/a", 0, "indexed", "2026-09-01");
    addTab.run("t2", "https://blog.example.com/a", 0, "indexed", "2026-09-02"); // same URL twice
    addTab.run("t3", "https://nodate.example/", 0, "indexed", "2026-09-03");
    addTab.run("t4", "https://excluded.example/", 1, "indexed", "2026-09-04");
    addTab.run("t5", "https://dead.example/", 0, "dead", "2026-09-05");
    addTab.run("t6", "http://localhost:3000/", 0, "indexed", "2026-09-06");
    addTab.run("t7", "https://flaky.example/", 0, "indexed", "2026-09-07");
    tabs.close();

    const db = new Database(":memory:");
    db.exec(`CREATE TABLE pending_items (id INTEGER PRIMARY KEY, url TEXT UNIQUE, source TEXT, captured_at TEXT, created_at TEXT, published_at TEXT)`);
    const addItem = db.prepare(`INSERT INTO pending_items (url, source, captured_at, created_at, published_at) VALUES (?, ?, ?, ?, ?)`);
    addItem.run("https://blog.example.com/a", "chrome-extension", "2026-09-10", "2026-09-10", null); // also a tab
    addItem.run("https://x.com/a/status/2036837084628127781", "chrome-extension", "2026-03-25", "2026-03-25", null);
    addItem.run("https://github.com/o/r", "github", "2026-01-01", "2026-01-01", null); // not our source
    return { db, dir, tabPath };
  }

  const fakeResolve = (calls: string[]) => async (url: string) => {
    calls.push(url);
    if (url.includes("blog.example.com")) return { publishedAt: "2024-01-01T00:00:00.000Z", status: "found" as const, method: "json-ld:article" };
    if (url.includes("flaky")) return { publishedAt: null, status: "error" as const, method: "html", error: "timeout" };
    if (url.includes("localhost")) return { publishedAt: null, status: "skipped" as const, method: "skip:local-host" };
    if (url.includes("x.com")) return { publishedAt: "2026-03-25T00:00:00.000Z", status: "found" as const, method: "x-snowflake" };
    return { publishedAt: null, status: "none" as const, method: "html" };
  };

  test("fills items and tabs once, skips excluded/dead, reruns are no-ops", async () => {
    const { db, dir, tabPath } = setup();
    try {
      const calls: string[] = [];
      const r1 = await sweepPublishedDates({ db, tabArchiveDbPath: tabPath, resolve: fakeResolve(calls), now });
      expect(r1.candidates).toEqual({ items: 2, tabs: 4, unique: 5, selected: 5 });
      expect(calls.sort()).toEqual([
        "http://localhost:3000/", "https://blog.example.com/a", "https://flaky.example/", "https://nodate.example/",
        "https://x.com/a/status/2036837084628127781",
      ]);
      expect(r1.itemsUpdated).toBe(2);
      expect(r1.byStatus).toEqual({ found: 2, none: 1, skipped: 1, error: 1 });
      expect(r1.failuresByHost).toEqual({ "flaky.example": 1 });
      expect((db.query(`SELECT published_at FROM pending_items WHERE source = 'github'`).get() as any).published_at).toBeNull();

      const calls2: string[] = [];
      const r2 = await sweepPublishedDates({ db, tabArchiveDbPath: tabPath, resolve: fakeResolve(calls2), now });
      expect(r2.candidates.selected).toBe(0);
      expect(calls2).toEqual([]);

      const calls3: string[] = [];
      await sweepPublishedDates({ db, tabArchiveDbPath: tabPath, resolve: fakeResolve(calls3), now, retryStatuses: ["error"] });
      expect(calls3).toEqual(["https://flaky.example/"]);
      expect((db.query(`SELECT attempts FROM page_published_dates WHERE url = 'https://flaky.example/'`).get() as any).attempts).toBe(2);

      const cov = coverage(db, tabPath);
      expect(cov["tabs:unique-urls"]).toEqual({ total: 4, dated: 1 });
      expect(cov["items:chrome-extension"]).toEqual({ total: 2, dated: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("limit takes the newest first; dry run writes nothing", async () => {
    const { db, dir, tabPath } = setup();
    try {
      const dry = await sweepPublishedDates({ db, tabArchiveDbPath: tabPath, dryRun: true, resolve: fakeResolve([]) });
      expect(dry.candidates.selected).toBe(5);
      expect(db.query(`SELECT 1 FROM sqlite_master WHERE name = 'page_published_dates'`).get()).toBeNull();

      const calls: string[] = [];
      await sweepPublishedDates({ db, tabArchiveDbPath: tabPath, limit: 2, resolve: fakeResolve(calls), now });
      expect(calls.sort()).toEqual(["https://blog.example.com/a", "https://flaky.example/"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a date after the first save is rejected, not stored", () => {
    const found = { publishedAt: "2026-09-23T00:00:00.000Z", status: "found" as const, method: "article-time" };
    expect(rejectAfterSave(found, "2026-01-05T10:00:00.000Z")).toMatchObject({ publishedAt: null, status: "none", method: "article-time:after-saved" });
    expect(rejectAfterSave(found, "2026-09-22T12:00:00.000Z")).toBe(found); // within a day: clock slop
    expect(rejectAfterSave(found, "2026-09-23 10:00:00Z")).toBe(found);
    expect(rejectAfterSave(found, "")).toBe(found);
  });

  test("a stored date is never overwritten by a later result", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE page_published_dates (url TEXT PRIMARY KEY, published_at TEXT, status TEXT NOT NULL, method TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 1, checked_at TEXT NOT NULL)`);
    recordPageDate(db, "https://a/", { publishedAt: "2020-01-01T00:00:00.000Z", status: "found", method: "meta:date" });
    recordPageDate(db, "https://a/", { publishedAt: null, status: "error", method: "html", error: "timeout" });
    expect(db.query(`SELECT published_at, status, method FROM page_published_dates`).get()).toEqual({ published_at: "2020-01-01T00:00:00.000Z", status: "found", method: "meta:date" });
  });
});
