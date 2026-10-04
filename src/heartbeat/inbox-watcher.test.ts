import { describe, it, expect, beforeEach } from "bun:test";
import { scanInbox, resetEpermSummaryForTests } from "./inbox-watcher.ts";
import type { PendingItem, PendingItemStatus } from "../shared/types.ts";

/**
 * Census 2026-10-03 (research/psibot-postrestart-census-2026-10.md): the only
 * recurring post-restart failure is `[ERROR] [heartbeat] Inbox watcher failed`
 * — a per-file macOS TCC EPERM opening one NotePlan inbox file, once every
 * 30 min. These pins hold the hardening in both directions:
 *
 * 1. An EPERM file is skipped (no throw → no ERROR tick in index.ts), the
 *    healthy siblings in the same tick still dispatch, and the watcher says so
 *    in ONE summary line per 24h naming the skipped path(s).
 * 2. Every other open failure (EACCES, ENOENT) still throws on every tick, so
 *    the heartbeat catch at src/heartbeat/index.ts keeps its full ERROR.
 */

function item(partial: Partial<PendingItem> & { id: number; noteplan_path: string }): PendingItem {
  return {
    url: `https://example.com/${partial.id}`,
    title: null,
    description: null,
    source: "manual",
    platform: null,
    profile: null,
    captured_at: null,
    status: "triaged",
    priority: null,
    category: null,
    triage_summary: null,
    quick_scan_summary: null,
    theme_id: null,
    relevance_window: null,
    watch_status: null,
    auto_decision: null,
    signal_score: null,
    value_type: null,
    extracted_value: null,
    surfaced_at: null,
    published_at: null,
    created_at: "2026-10-01T00:00:00.000Z",
    ...partial,
  };
}

function errno(code: string, path: string): Error & { code: string } {
  const err = new Error(`${code}: operation not permitted, open '${path}'`) as Error & { code: string };
  err.code = code;
  return err;
}

// A trailing frontmatter key after `tags:` — the tag-line regex needs each
// tag line newline-terminated, and the `\n---` terminator eats the last one.
const NOTE = (tags: string[]): string =>
  `---\ntitle: fixture\ntags:\n${tags.map((t) => `  - ${t}`).join("\n")}\ntrailing: key\n---\n\nbody\n`;

interface Harness {
  lines: string[];
  updates: Array<{ id: number; params: Record<string, unknown> }>;
  items: PendingItem[];
  files: Map<string, string | Error>;
  nowMs: number;
}

function harness(items: PendingItem[]): Harness {
  const h: Harness = {
    lines: [],
    updates: [],
    items,
    files: new Map(),
    nowMs: Date.parse("2026-10-03T12:00:00Z"),
  };
  for (const i of items) h.files.set(i.noteplan_path, "---\n---\n");
  return h;
}

function depsFor(h: Harness) {
  return {
    exists: () => true,
    readFile: (path: string): string => {
      const f = h.files.get(path);
      if (f instanceof Error) throw f;
      return f;
    },
    getPendingItems: (status?: PendingItemStatus, _limit?: number): PendingItem[] =>
      status ? h.items.filter((i) => i.status === status) : h.items,
    updatePendingItem: (id: number, params: Record<string, unknown>): void => {
      h.updates.push({ id, params });
      const target = h.items.find((i) => i.id === id);
      if (target) Object.assign(target, params);
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, data?: Record<string, unknown>) =>
        h.lines.push(`${message} ${JSON.stringify(data ?? {})}`),
      error: (message: string) => h.lines.push(`[ERROR] ${message}`),
    },
    now: () => h.nowMs,
  };
}

beforeEach(() => resetEpermSummaryForTests());

describe("scanInbox EPERM hardening", () => {
  it("skips an EPERM file, dispatches its healthy sibling, and logs one summary per 24h — never an ERROR", () => {
    const epermItem = item({ id: 1, noteplan_path: "/notes/00 - Inbox/tcc.md" });
    const healthyItem = item({ id: 2, noteplan_path: "/notes/00 - Inbox/watch.md" });
    const h = harness([epermItem, healthyItem]);
    h.files.set(epermItem.noteplan_path, errno("EPERM", epermItem.noteplan_path));
    h.files.set(healthyItem.noteplan_path, NOTE(["watch"]));
    const deps = depsFor(h);

    // Tick 1: the scan completes (no throw → no ERROR tick in index.ts), the
    // healthy sibling still dispatches, and exactly one summary names the path.
    expect(scanInbox(deps)).toEqual([
      { itemId: 2, action: "watch", noteplanPath: healthyItem.noteplan_path },
    ]);

    // Ticks 2-3 inside the 24h window: silent — no repeat, no state mutation.
    h.nowMs += 10 * 60_000;
    expect(scanInbox(deps)).toEqual([]);
    h.nowMs += 23 * 60 * 60_000;
    expect(scanInbox(deps)).toEqual([]);

    const summaries = h.lines.filter((l) => l.includes("EPERM"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toContain("/notes/00 - Inbox/tcc.md");
    expect(h.lines.some((l) => l.startsWith("[ERROR]"))).toBe(false);
    expect(h.updates.map((u) => u.id)).toEqual([2]);

    // Next daily window: exactly one more summary, not one per tick.
    h.nowMs += 24 * 60 * 60_000 + 1;
    scanInbox(deps);
    expect(h.lines.filter((l) => l.includes("EPERM"))).toHaveLength(2);
  });

  it("resumes normal processing once the file is readable again", () => {
    const blocked = item({ id: 1, noteplan_path: "/notes/tcc.md" });
    const h = harness([blocked]);
    h.files.set(blocked.noteplan_path, errno("EPERM", blocked.noteplan_path));
    const deps = depsFor(h);

    scanInbox(deps);
    expect(h.updates).toEqual([]);

    // Owner-side fix lands (macl stripped): the very next tick processes it.
    h.files.set(blocked.noteplan_path, NOTE(["archive"]));
    expect(scanInbox(deps)).toEqual([
      { itemId: 1, action: "archive", noteplanPath: blocked.noteplan_path },
    ]);
  });

  it("still throws every tick for non-EPERM open failures (EACCES, ENOENT)", () => {
    for (const code of ["EACCES", "ENOENT"] as const) {
      const blocked = item({ id: 1, noteplan_path: `/notes/${code.toLowerCase()}.md` });
      const h = harness([blocked]);
      h.files.set(blocked.noteplan_path, errno(code, blocked.noteplan_path));
      const deps = depsFor(h);

      for (let tick = 0; tick < 3; tick++) {
        expect(() => scanInbox(deps)).toThrow(code);
      }
      // The classifier must not absorb real errors: no summary, no mutation.
      expect(h.lines.filter((l) => l.includes("EPERM"))).toHaveLength(0);
      expect(h.updates).toEqual([]);
    }
  });
});
