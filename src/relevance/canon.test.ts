import { describe, expect, test } from "bun:test";
import { canonicalUrl, canonicalHost } from "./canon";

describe("canonicalUrl", () => {
  test("drops scheme, www., m., trailing slash and fragment; lowercases the host", () => {
    expect(canonicalUrl("https://www.Example.com/Docs/Page/#intro")).toBe("example.com/Docs/Page");
    expect(canonicalUrl("http://m.example.com/Docs/Page")).toBe("example.com/Docs/Page");
    expect(canonicalUrl("https://example.com/")).toBe("example.com");
    expect(canonicalUrl("example.com/a")).toBe("example.com/a");
  });

  test("strips tracking parameters but keeps meaningful ones, sorted", () => {
    expect(canonicalUrl("https://blog.example.com/post?utm_source=x&utm_medium=y&fbclid=z&gclid=1&ref=hn")).toBe("blog.example.com/post");
    expect(canonicalUrl("https://news.ycombinator.com/item?id=123&utm_source=x")).toBe("news.ycombinator.com/item?id=123");
    expect(canonicalUrl("https://duckduckgo.com/?t=h_&q=bun+sqlite")).toBe("duckduckgo.com?q=bun+sqlite&t=h_");
    expect(canonicalUrl("https://example.com/p?b=2&a=1")).toBe(canonicalUrl("https://example.com/p?a=1&b=2"));
  });

  test("host-specific tracking: Google search noise, X share params, Amazon ref paths", () => {
    expect(canonicalUrl("https://www.google.com/search?q=vivaldi&sxsrf=abc&ved=1&ei=2&oq=viv&sourceid=chrome&ie=UTF-8"))
      .toBe("google.com/search?q=vivaldi");
    expect(canonicalUrl("https://twitter.com/user/status/1?s=20&t=abc")).toBe("x.com/user/status/1");
    expect(canonicalUrl("https://www.amazon.ca/Some-Thing/dp/B0ABCDEF12/ref=sr_1_3?crid=X&keywords=y&th=1"))
      .toBe("amazon.ca/dp/B0ABCDEF12");
    expect(canonicalUrl("https://www.amazon.ca/gp/product/b0abcdef12")).toBe("amazon.ca/dp/B0ABCDEF12");
  });

  test("YouTube: watch, youtu.be, shorts, embed and m. forms share one key", () => {
    const key = "youtube.com/watch?v=dQw4w9WgXcQ";
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&list=WL&index=3&t=42s&si=abc",
      "https://youtu.be/dQw4w9WgXcQ?si=xyz",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
    ]) expect(canonicalUrl(u)).toBe(key);
    // Channel and search pages are not videos and keep their own keys.
    expect(canonicalUrl("https://www.youtube.com/@somechannel/videos")).toBe("youtube.com/@somechannel/videos");
    expect(canonicalUrl("https://www.youtube.com/results?search_query=bun")).toBe("youtube.com/results?search_query=bun");
  });

  test("Reddit posts collapse to the post ID across hosts, slugs and path-only saves", () => {
    const key = "reddit.com/comments/1p98aqs";
    expect(canonicalUrl("https://www.reddit.com/r/LangChain/comments/1p98aqs/built_a_deep_agent/")).toBe(key);
    expect(canonicalUrl("https://old.reddit.com/r/LangChain/comments/1p98aqs/")).toBe(key);
    expect(canonicalUrl("/r/LangChain/comments/1p98aqs/built_a_deep_agent/")).toBe(key);
    expect(canonicalUrl("https://redd.it/1p98aqs")).toBe(key);
    expect(canonicalUrl("https://www.reddit.com/r/LangChain/")).toBe("reddit.com/r/LangChain");
  });

  test("arXiv abs/pdf/version and GitHub case variants merge", () => {
    expect(canonicalUrl("https://arxiv.org/pdf/2401.01234v2.pdf")).toBe("arxiv.org/abs/2401.01234");
    expect(canonicalUrl("https://arxiv.org/abs/2401.01234")).toBe("arxiv.org/abs/2401.01234");
    expect(canonicalUrl("https://github.com/Owner/Repo/")).toBe(canonicalUrl("https://github.com/owner/repo"));
  });

  test("empty, non-web and odd inputs", () => {
    expect(canonicalUrl(null)).toBeNull();
    expect(canonicalUrl("  ")).toBeNull();
    expect(canonicalUrl("chrome://extensions/#x")).toBe("chrome://extensions/");
    expect(canonicalUrl("http://localhost:4890/library?x=1")).toBe("localhost:4890/library?x=1");
  });
});

describe("canonicalHost", () => {
  test("returns the host part of web keys only", () => {
    expect(canonicalHost("github.com/a/b")).toBe("github.com");
    expect(canonicalHost("duckduckgo.com?q=x")).toBe("duckduckgo.com");
    expect(canonicalHost("localhost:4890/x")).toBe("localhost:4890");
    expect(canonicalHost("chrome://extensions/")).toBeNull();
    expect(canonicalHost(null)).toBeNull();
  });
});
