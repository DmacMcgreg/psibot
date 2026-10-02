import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { Hono } from "hono";
import type { MiniAppEnv } from "../web/routes/mini-app/shared.ts";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting, getDb } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { markResearchNoteConsumed } from "../db/queries.ts";
import { composeWeeklyDigest, isoWeek } from "./compose.ts";
import { handleDigestCallback, markDigestRowDone, DIGEST_CALLBACK_RE } from "./buttons.ts";
import { deliverWeeklyDigest, type DigestSendDeps } from "./index.ts";
import { indexItem } from "../atlas/index.ts";
import { registerLibraryRoutes } from "../web/routes/mini-app/library.ts";

/**
 * Receipts + actions for the weekly digest (value-audit F3/F4, 2026-10-02):
 * a rendered digest carries buttons whose clicks land as attributed
 * feedback_log rows; deliver writes one sent_messages row per chunk;
 * research notes gain a first-open consumed_at marker. Everything runs
 * against an in-memory db — the owner's chat and registry are never touched.
 */

let db: Database;

beforeAll(() => {
  loadConfig();
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (e) {
      if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e;
    }
  }
  setDbForTesting(db);
});

afterAll(() => db.close());

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function addPendingItem(p: { title: string; status?: string; priority?: number; signalScore?: number; noteplanPath?: string }): number {
  seq++;
  return getDb()
    .prepare<{ id: number }, [string, string, string, string, number | null, number | null, string | null]>(
      `INSERT INTO pending_items (url, title, source, captured_at, status, priority, signal_score, noteplan_path)
       VALUES (?, ?, 'test', ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      `https://example.com/i${seq}`,
      p.title,
      nowIso(),
      p.status ?? "triaged",
      p.priority ?? null,
      p.signalScore ?? null,
      p.noteplanPath ?? null,
    )!.id;
}

function addResearchNote(itemId: number | null): number {
  return getDb()
    .prepare<{ id: number }, [number | null]>(
      `INSERT INTO research_notes (item_id, depth, title, url, summary, markdown)
       VALUES (?, 'deep', 'A note', NULL, NULL, '## Summary\nbody') RETURNING id`,
    )
    .get(itemId)!.id;
}

type SendOpts = Parameters<DigestSendDeps["send"]>[2];

interface SentCall {
  chatId: string | number;
  text: string;
  opts: SendOpts;
}

function sendDeps(opts: { failChatIds?: (string | number)[] } = {}) {
  const sent: SentCall[] = [];
  let mid = 0;
  const deps: DigestSendDeps = {
    send: async (chatId, text, o) => {
      if (opts.failChatIds?.includes(chatId)) throw new Error("send failed");
      sent.push({ chatId, text, opts: o });
      return { message_id: ++mid };
    },
    defaultChatIds: [4242],
    digestChatId: "-100200",
    digestTopicId: 49,
  };
  return { deps, sent };
}

interface SentRow {
  id: number;
  chat_id: string;
  message_id: number;
  topic_id: number | null;
  source: string;
  preview: string | null;
}

const sentRows = () =>
  getDb()
    .prepare<SentRow, []>(`SELECT id, chat_id, message_id, topic_id, source, preview FROM sent_messages ORDER BY id`)
    .all();

interface FeedbackRow {
  id: number;
  item_id: number | null;
  content_type: string | null;
  source: string | null;
  system_recommendation: string | null;
  user_action: string;
  signal_snapshot: string | null;
}

const feedbackRows = () =>
  getDb()
    .prepare<FeedbackRow, []>(
      `SELECT id, item_id, content_type, source, system_recommendation, user_action, signal_snapshot FROM feedback_log ORDER BY id`,
    )
    .all();

beforeEach(() => {
  getDb().exec("DELETE FROM feedback_log; DELETE FROM sent_messages; DELETE FROM research_notes; DELETE FROM pending_items; DELETE FROM atlas_items; DELETE FROM atlas_items_fts;");
});

describe("deliverWeeklyDigest — receipts (F4)", () => {
  it("records one sent_messages row per chunk, source 'weekly-digest', keyboard only on the last chunk", async () => {
    addPendingItem({ title: "Alpha", priority: 1 });
    addPendingItem({ title: "Beta", priority: 2 });
    const digest = composeWeeklyDigest();
    expect(digest.telegramChunks.length).toBeGreaterThanOrEqual(1);
    expect(sentRows()).toHaveLength(0); // mutation check: nothing before

    const { deps, sent } = sendDeps();
    const ok = await deliverWeeklyDigest(deps, digest);
    expect(ok).toBe(true);

    const rows = sentRows();
    expect(rows).toHaveLength(sent.length);
    expect(rows.every((r) => r.source === "weekly-digest")).toBe(true);
    expect(rows.map((r) => r.chat_id)).toEqual(sent.map((s) => String(s.chatId)));
    expect(rows.every((r) => r.topic_id === 49)).toBe(true);
    expect(rows[0].preview).toContain(`Weekly digest ${digest.week} (1/`);
    expect(rows.every((r) => /^Weekly digest \d{4}-W\d{2} \(\d+\/\d+\)$/.test(r.preview ?? ""))).toBe(true);

    // Keyboard rides the LAST chunk only; every callback fits Telegram's cap.
    const withKb = sent.filter((s) => s.opts.reply_markup);
    expect(withKb).toHaveLength(1);
    expect(withKb[0]).toBe(sent[sent.length - 1]);
    const kbRows = withKb[0].opts.reply_markup!.inline_keyboard;
    expect(kbRows.length).toBe(Math.min(2, digest.topItems.length));
    for (const row of kbRows) {
      expect(row.every((b) => "callback_data" in b)).toBe(true);
      for (const btn of row) {
        if (!("callback_data" in btn)) continue;
        expect(new TextEncoder().encode(btn.callback_data).byteLength).toBeLessThanOrEqual(64);
        expect(DIGEST_CALLBACK_RE.test(btn.callback_data.split("dg:")[1] ?? "")).toBe(true);
      }
    }
    expect(kbRows[0].map((b) => b.text)).toEqual(["1 👀 Watch", "🗄 Archive", "💤 Snooze"]);
  });

  it("falls back to DM when the topic send fails, still recording rows", async () => {
    const a = addPendingItem({ title: "Only", priority: 1 });
    const digest = composeWeeklyDigest();
    const { deps } = sendDeps({ failChatIds: ["-100200"] });
    const ok = await deliverWeeklyDigest(deps, digest);
    expect(ok).toBe(true);
    const rows = sentRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.chat_id === "4242" && r.topic_id === null && r.source === "weekly-digest")).toBe(true);
    expect(a).toBeGreaterThan(0);
  });

  it("sends no keyboard when the week has no top items", async () => {
    const digest = composeWeeklyDigest(); // db emptied in beforeEach
    expect(digest.topItems).toHaveLength(0);
    const { deps, sent } = sendDeps();
    await deliverWeeklyDigest(deps, digest);
    expect(sent.every((s) => !s.opts.reply_markup)).toBe(true);
    expect(sentRows().length).toBe(sent.length);
  });
});

describe("handleDigestCallback — attributed feedback rows (F3)", () => {
  it("each verb writes exactly one attributed feedback_log row and mutates nothing else", () => {
    const id = addPendingItem({ title: "Clickable", status: "triaged", priority: 1 });
    for (const [verb, action] of [
      ["w", "watch"],
      ["a", "archive"],
      ["s", "snooze"],
    ] as const) {
      const before = feedbackRows().length;
      const r = handleDigestCallback(`${verb}:${id}:${isoWeek()}`);
      expect(r.ok).toBe(true);
      expect(r.itemId).toBe(id);
      expect(r.doneLabel).toContain("Clickable");
      const rows = feedbackRows();
      expect(rows).toHaveLength(before + 1);
      const row = rows[rows.length - 1];
      expect(row.item_id).toBe(id);
      expect(row.content_type).toBe("weekly_digest");
      expect(row.user_action).toBe(action);
      expect(row.signal_snapshot).toContain(isoWeek());
      expect(row.signal_snapshot).toContain("Clickable");
    }
    // Scope check: the click is a receipt, not a triage action —
    // item status untouched, autonomy untouched.
    const item = getDb().prepare<{ status: string }, [number]>(`SELECT status FROM pending_items WHERE id = ?`).get(id)!;
    expect(item.status).toBe("triaged");
    const autonomy = getDb().prepare(`SELECT COUNT(*) AS n FROM autonomy_rules`).get() as { n: number };
    expect(autonomy.n).toBe(0);
  });

  it("bad payload, unknown item, and 'n' (already handled) write no rows", () => {
    const id = addPendingItem({ title: "Real" });
    handleDigestCallback("garbage");
    handleDigestCallback(`w:999999:${isoWeek()}`);
    handleDigestCallback(`n:${id}:${isoWeek()}`);
    expect(feedbackRows()).toHaveLength(0);
  });

  it("a click on an item with a research note marks the note consumed (the 'answer' receipt)", () => {
    const noteId = addResearchNote(null);
    const id = addPendingItem({ title: "Noted", noteplanPath: `db:research_notes/${noteId}` });
    const r = handleDigestCallback(`w:${id}:${isoWeek()}`);
    expect(r.ok).toBe(true);
    const note = getDb().prepare<{ consumed_at: string | null }, [number]>(`SELECT consumed_at FROM research_notes WHERE id = ?`).get(noteId)!;
    expect(note.consumed_at).not.toBeNull();
  });
});

describe("markDigestRowDone", () => {
  it("replaces only the handled item's row and leaves siblings intact", () => {
    const rows = [
      [{ text: "1 👀 Watch", callback_data: "dg:w:1:2026-W40" }, { text: "🗄 Archive", callback_data: "dg:a:1:2026-W40" }],
      [{ text: "2 👀 Watch", callback_data: "dg:w:2:2026-W40" }, { text: "💤 Snooze", callback_data: "dg:s:2:2026-W40" }],
    ];
    const next = markDigestRowDone(rows, 1, "👀 Watching: X");
    expect(next[0]).toEqual([{ text: "👀 Watching: X", callback_data: "dg:n:1" }]);
    expect(next[1]).toBe(rows[1]);
  });
});

describe("markResearchNoteConsumed — first-open marker (F4)", () => {
  it("sets consumed_at once; later calls return null and never overwrite", () => {
    const id = addResearchNote(null);
    const first = markResearchNoteConsumed(id);
    expect(first).not.toBeNull();
    const second = markResearchNoteConsumed(id);
    expect(second).toBeNull();
    const row = getDb().prepare<{ consumed_at: string | null }, [number]>(`SELECT consumed_at FROM research_notes WHERE id = ?`).get(id)!;
    expect(row.consumed_at).toBe(first);
    expect(markResearchNoteConsumed(999999)).toBeNull();
  });
});

describe("library item open marks the note consumed (first-open surface)", () => {
  it("GET /library/items/:id marks a research_notes-backed item; other kinds untouched", async () => {
    const noteId = addResearchNote(null);
    const atlasId = indexItem({ kind: "research", sourceTable: "research_notes", sourceId: String(noteId), title: "Backed by a note", body: "note body" });
    const otherNote = addResearchNote(null);
    const videoAtlasId = indexItem({ kind: "youtube", sourceTable: "youtube_videos", sourceId: "vid1", title: "A video", body: "video body" });

    const app = new Hono<MiniAppEnv>();
    registerLibraryRoutes(app);

    const res1 = await app.request(`/library/items/${atlasId}`);
    expect(res1.status).toBe(200);
    const consumed = getDb().prepare<{ consumed_at: string | null }, [number]>(`SELECT consumed_at FROM research_notes WHERE id = ?`).get(noteId)!;
    expect(consumed.consumed_at).not.toBeNull();

    const res2 = await app.request(`/library/items/${videoAtlasId}`);
    expect(res2.status).toBe(200);
    const untouched = getDb().prepare<{ consumed_at: string | null }, [number]>(`SELECT consumed_at FROM research_notes WHERE id = ?`).get(otherNote)!;
    expect(untouched.consumed_at).toBeNull();
  });
});

describe("end-to-end: rendered digest → button → feedback row (the gate scenario)", () => {
  it("composes, numbers its top items, delivers with buttons, and a tap lands as a feedback_log row", async () => {
    const first = addPendingItem({ title: "Gate item one", priority: 1, signalScore: 90 });
    addPendingItem({ title: "Gate item two", priority: 2, signalScore: 80 });
    const digest = composeWeeklyDigest();
    expect(digest.telegramChunks.join("\n")).toContain("1. ");
    expect(digest.topItems.map((t) => t.id)).toContain(first);

    const { deps, sent } = sendDeps();
    expect(await deliverWeeklyDigest(deps, digest)).toBe(true);
    const kb = sent[sent.length - 1].opts.reply_markup!.inline_keyboard;
    expect(kb.length).toBeGreaterThanOrEqual(1);

    // "David" taps the first row's Watch button.
    const watch = kb[0].find((b) => b.text.includes("Watch"))!;
    expect("callback_data" in watch).toBe(true);
    const payload = "callback_data" in watch ? watch.callback_data.slice("dg:".length) : "";
    const r = handleDigestCallback(payload);
    expect(r.ok).toBe(true);

    const rows = feedbackRows().filter((f) => f.content_type === "weekly_digest");
    expect(rows).toHaveLength(1);
    expect(rows[0].item_id).toBe(digest.topItems[0].id);
    expect(rows[0].user_action).toBe("watch");

    // Gate recompute from the registry alone: delivery + action, one query each.
    const deliveries = getDb().prepare(`SELECT COUNT(*) AS n FROM sent_messages WHERE source = 'weekly-digest'`).get() as { n: number };
    const actions = getDb().prepare(`SELECT COUNT(*) AS n FROM feedback_log WHERE content_type = 'weekly_digest'`).get() as { n: number };
    expect(deliveries.n).toBe(sent.length);
    expect(actions.n).toBe(1);
  });
});
