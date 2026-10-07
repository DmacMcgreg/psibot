import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../../db/schema.ts";
import { setDbForTesting } from "../../db/index.ts";
import { researchSource } from "./research.ts";

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
  const item = db.prepare(`INSERT INTO pending_items (url, title, source) VALUES (?, ?, 'youtube') RETURNING id`);
  const asked = (item.get("https://youtu.be/asked", "Asked") as { id: number }).id;
  const auto = (item.get("https://youtu.be/auto", "Auto") as { id: number }).id;
  const archived = (item.get("https://youtu.be/archived", "Archived") as { id: number }).id;
  // The Research button (applyItemAction) logs this row; auto-research logs nothing.
  db.prepare(`INSERT INTO feedback_log (item_id, user_action, system_recommendation) VALUES (?, 'research', 'triage')`).run(asked);
  db.prepare(`INSERT INTO feedback_log (item_id, user_action, system_recommendation) VALUES (?, 'archive', 'triage')`).run(archived);
  const note = db.prepare(`INSERT INTO research_notes (item_id, depth, title, url, summary, markdown, created_at) VALUES (?, 'quick', ?, ?, 's', ?, ?)`);
  note.run(asked, "Asked note", "https://youtu.be/asked", "body", "2026-09-26T10:00:00Z");
  note.run(auto, "Auto note", "https://youtu.be/auto", "body", "2026-09-26T11:00:00Z");
  note.run(archived, "Archived note", "https://youtu.be/archived", "body", "2026-09-26T12:00:00Z");
  note.run(null, "Orphan note", null, "body", "2026-09-26T13:00:00Z");
  note.run(asked, "Broken note", null, "Z.ai Built-in Tool output", "2026-09-26T14:00:00Z");
});
afterAll(() => db.close());

describe("researchSource", () => {
  it("is explicit only when David pressed Research on the item", () => {
    const items = researchSource.list({ after: "2026-09-26T00:00:00Z", limit: 10 });
    const by = Object.fromEntries(items.map((i) => [i.title, i]));
    expect(Object.keys(by).sort()).toEqual(["Archived note", "Asked note", "Auto note", "Orphan note"]);
    expect(by["Asked note"].explicit).toBe(true);
    expect(by["Asked note"].context).toContain("pressed Research");
    expect(by["Auto note"].explicit).toBe(false);
    expect(by["Auto note"].context).toContain("did not ask");
    expect(by["Archived note"].explicit).toBe(false);
    expect(by["Orphan note"].explicit).toBe(false);
  });

  it("keeps listing newest first after the watermark", () => {
    const items = researchSource.list({ after: "2026-09-26T11:30:00Z", limit: 10 });
    expect(items.map((i) => i.title)).toEqual(["Orphan note", "Archived note"]);
  });
});
