import { describe, expect, it } from "bun:test";
import {
  DISCOVER_ONLY_SOURCES,
  INBOX_SURFACEABLE_SQL,
  isInboxSurfaceable,
} from "./surface-policy.ts";

describe("surface-policy", () => {
  it("keeps automated poller sources out of the inbox channel", () => {
    // Regression guard: each of these flooded the News topic before being
    // gated (youtube 2026-07-15, github/reddit 2026-07-22). Removing a source
    // from DISCOVER_ONLY_SOURCES re-introduces the flood — this test is the
    // durable record of that decision.
    for (const source of ["youtube", "github", "reddit"]) {
      expect(isInboxSurfaceable({ source })).toBe(false);
    }
  });

  it("allows deliberate capture sources", () => {
    for (const source of ["chrome-extension", "telegram", "manual"]) {
      expect(isInboxSurfaceable({ source })).toBe(true);
    }
  });

  it("treats null/unknown sources as surfaceable (fail-open for non-Discover data)", () => {
    expect(isInboxSurfaceable({})).toBe(true);
    expect(isInboxSurfaceable({ source: null })).toBe(true);
  });

  it("SQL predicate excludes every Discover-only source", () => {
    for (const source of DISCOVER_ONLY_SOURCES) {
      expect(INBOX_SURFACEABLE_SQL).toContain(`'${source}'`);
    }
    expect(INBOX_SURFACEABLE_SQL.startsWith("source NOT IN (")).toBe(true);
  });
});
