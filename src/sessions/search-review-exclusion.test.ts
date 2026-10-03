import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { searchSessions } from "./search.ts";
import { getMessagesBySession } from "../db/queries.ts";

/**
 * Session hygiene (fix dc6b4b7, 2026-07-05): internal review turns
 * (chat_messages.source='review') must never surface in session search or
 * session reads — they are the agent's own background-review chatter, not
 * conversation history.
 *
 * All inserts happen BEFORE the first searchSessions() call: the module's
 * one-shot FTS backfill (ensureFtsBackfilled) runs on that first call, and
 * rows inserted afterwards would never be indexed.
 */

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});
afterAll(() => db.close());

function addMessage(sessionId: string, role: "user" | "assistant", source: string, content: string): void {
  db.prepare(
    `INSERT INTO chat_messages (session_id, role, content, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(sessionId, role, content, source, "2026-07-05T12:00:00Z");
}

describe("review-source exclusion from session reads/search (dc6b4b7)", () => {
  it("review turns stay out of search hits, excerpts, counts, and session reads", () => {
    addMessage("sess-mixed", "user", "web", "needle probe alpha question");
    addMessage("sess-mixed", "assistant", "review", "needle probe bravo internal review chatter");
    addMessage("sess-review-only", "assistant", "review", "needle probe charlie review-only session");

    const hits = searchSessions("needle probe");
    expect(hits.map((h) => h.sessionId)).toEqual(["sess-mixed"]); // review-only session must not surface

    const hit = hits[0];
    expect(hit.totalMessages).toBe(1); // counts non-review rows only
    expect(hit.excerpt).toContain("alpha");
    expect(hit.excerpt).not.toContain("bravo"); // review content must not leak into the excerpt

    const messages = getMessagesBySession("sess-mixed");
    expect(messages.map((m) => m.source)).toEqual(["web"]); // session reads exclude review turns
  });
});
