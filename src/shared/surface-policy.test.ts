import { describe, expect, it } from "bun:test";
import {
  DISCOVER_ONLY_SOURCES,
  INBOX_SURFACEABLE_SQL,
  isInboxSurfaceable,
} from "./surface-policy.ts";

describe("surface-policy", () => {
  it("keeps YouTube out of the inbox channel", () => {
    expect(isInboxSurfaceable({ source: "youtube" })).toBe(false);
  });

  it("allows the inbox-native capture sources", () => {
    for (const source of ["reddit", "github", "chrome-extension", "telegram", "manual"]) {
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
