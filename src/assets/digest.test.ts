import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { Bot } from "grammy";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting, getDb } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { muteTopic } from "../db/queries.ts";
import { upsertAsset, setAssetStatus, getAsset, mergeAssets } from "./store.ts";
import type { AssetInput } from "./types.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setHomesForTesting, resetHomes } from "./homes.ts";
import {
  AssetDigestRunner,
  selectDigestAssets,
  selectAlerts,
  selectReminders,
  renderDigest,
  digestKeyboard,
  handleAssetCallback,
  markRowDone,
  daysUntil,
  localDate,
} from "./digest.ts";

let db: Database;
// Bid-desk memos are read from HOMES.cloudNexusDir; point it at an empty temp
// dir so the real memos (keyed by live asset ids) never touch these tests.
const cloudNexus = mkdtempSync(join(tmpdir(), "digest-cn-"));
const bidDesk = join(cloudNexus, "bid-desk");
mkdirSync(bidDesk);
const memo = (assetId: number, verdict: string) =>
  writeFileSync(join(bidDesk, `memo-${assetId}.md`), `---\nasset_id: ${assetId}\nverdict: ${verdict}\nconfidence: high\n---\n\n# Memo\n`);
beforeAll(() => {
  setHomesForTesting({ cloudNexusDir: cloudNexus });
  loadConfig();
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
});
afterAll(() => {
  db.close();
  resetHomes();
  rmSync(cloudNexus, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM asset_events; DELETE FROM asset_sources; DELETE FROM assets; DELETE FROM ops_state; DELETE FROM muted_topics;");
  rmSync(bidDesk, { recursive: true, force: true });
  mkdirSync(bidDesk);
});

const NOW = new Date();
const inDays = (d: number) => localDate(new Date(NOW.getTime() + d * 86_400_000));
const daysAgoIso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function add(p: Partial<AssetInput> & { value_score: number }): number {
  seq++;
  const a: AssetInput = {
    kind: "tool", title: `Asset ${seq}`, url: `https://example.com/a${seq}`, summary: "What it is.",
    track: "marketing", value_reason: "Because.", next_action: `Do thing ${seq}.`, ...p,
  };
  return upsertAsset(a, { source_kind: "test", source_ref: String(seq) }).id;
}
const setSurfaced = (id: number, iso: string) => getDb().prepare("UPDATE assets SET surfaced_at = ? WHERE id = ?").run(iso, id);

function fakeBot() {
  const sent: { chatId: string | number; text: string; opts: Record<string, unknown> }[] = [];
  let mid = 0;
  const bot = { api: { sendMessage: async (chatId: string | number, text: string, opts: Record<string, unknown>) => { sent.push({ chatId, text, opts }); return { message_id: ++mid }; } } };
  return { bot: bot as unknown as Bot, sent };
}

describe("selectDigestAssets", () => {
  it("takes the top 5 new assets by rank, skipping ones surfaced in the last 7 days", () => {
    const ids = [90, 85, 80, 75, 70, 65, 60].map((s) => add({ value_score: s, kind: "dataset" }));
    setSurfaced(ids[0], daysAgoIso(3));   // recent: skipped
    setSurfaced(ids[1], daysAgoIso(10));  // stale: eligible again
    setAssetStatus(ids[2], "dismissed", "dismiss");
    const expired = add({ value_score: 99, kind: "opportunity", deadline: inDays(-2) });
    const picked = selectDigestAssets(NOW).map((a) => a.id);
    expect(picked).toEqual([ids[1], ids[3], ids[4], ids[5], ids[6]]);
    expect(picked).not.toContain(expired);
  });

  it("holds 2 slots for open opportunities and allows at most 2 skills or tools", () => {
    const packs = [95, 94, 93, 92].map((s, i) => add({ value_score: s, kind: i % 2 ? "tool" : "skill" }));
    const dataset = add({ value_score: 70, kind: "dataset", track: "data" });
    add({ value_score: 60, kind: "technique", track: "video" });
    const bid = add({ value_score: 50, kind: "opportunity", track: "bids", deadline: inDays(30) });
    const rolling = add({ value_score: 45, kind: "opportunity", track: "bids", deadline: "2099-11-22" });
    setAssetStatus(rolling, "queued", "queue");  // queued opportunities still get a slot
    add({ value_score: 40, kind: "opportunity", track: "bids" });
    const shown = add({ value_score: 90, kind: "opportunity", track: "bids", deadline: inDays(5) });
    setSurfaced(shown, daysAgoIso(1));  // closes soon, so it returns after 2 days, not 7
    add({ value_score: 99, kind: "opportunity", track: "bids", deadline: inDays(-1) });
    const queuedTool = add({ value_score: 99, kind: "tool" });
    setAssetStatus(queuedTool, "queued", "queue");

    const picked = selectDigestAssets(NOW);
    expect(picked.map((a) => a.id)).toEqual([packs[0], packs[1], dataset, bid, rolling]);
    expect(picked.filter((a) => a.kind === "skill" || a.kind === "tool")).toHaveLength(2);
    expect(picked.map((a) => a.rank)).toEqual([...picked.map((a) => a.rank)].sort((x, y) => y - x));
  });
});

describe("AssetDigestRunner.runOnce", () => {
  it("sends one message with a button row per asset, marks them surfaced, and never double-sends", async () => {
    const ids = (["tool", "dataset", "technique"] as const).map((kind, i) => add({ value_score: 88 - i * 11, kind }));
    const opp = add({ value_score: 70, kind: "opportunity", title: "City of Ottawa web RFP", deadline: inDays(5), amount: "$40,000" });
    const { bot, sent } = fakeBot();
    const deps = { getBot: () => bot, defaultChatIds: [111], digestChatId: "-100", digestTopicId: 49, now: () => NOW };

    const r1 = await new AssetDigestRunner(deps).runOnce();
    expect(r1.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("-100");
    expect(sent[0].opts.message_thread_id).toBe(49);
    expect(sent[0].text).toContain("Act on these");
    expect(sent[0].text).toContain("City of Ottawa web RFP");
    expect(sent[0].text).toContain("$40,000");
    const kb = (sent[0].opts.reply_markup as { inline_keyboard: { callback_data: string; text: string }[][] }).inline_keyboard;
    expect(kb).toHaveLength(4);
    expect(kb.flat().map((b) => b.callback_data)).toContain(`as:f:${opp}`);
    expect(kb.flat().find((b) => b.callback_data === `as:f:${opp}`)!.text).toContain("Pursue");
    for (const id of [...ids, opp]) expect(getAsset(id)!.surfaced_at).not.toBeNull();

    // Same day, and after a "restart" (new runner): no second digest.
    expect((await new AssetDigestRunner(deps).runOnce()).reason).toBe("already sent today");
    expect(sent).toHaveLength(1);

    // Next day: everything was surfaced within 7 days, so nothing to send.
    const tomorrow = new Date(NOW.getTime() + 86_400_000);
    const r3 = await new AssetDigestRunner({ ...deps, now: () => tomorrow }).runOnce();
    expect(r3.sent).toBe(false);
    expect(r3.reason).toBe("nothing to surface");
  });

  it("sends to David's DM when the News topic is muted", async () => {
    add({ value_score: 80, kind: "dataset" });
    muteTopic("-100", 49, "2099-01-01T00:00:00Z");
    const { bot, sent } = fakeBot();
    const r = await new AssetDigestRunner({ getBot: () => bot, defaultChatIds: [111], digestChatId: "-100", digestTopicId: 49, now: () => NOW }).runOnce();
    expect(r.sent).toBe(true);
    expect(sent.map((m) => m.chatId)).toEqual([111]);
    expect(sent[0].opts.message_thread_id).toBeUndefined();
  });

  it("releases the day when delivery fails so it can retry", async () => {
    add({ value_score: 80 });
    const failing = { api: { sendMessage: async () => { throw new Error("network"); } } } as unknown as Bot;
    const deps = { getBot: () => failing, defaultChatIds: [111], digestChatId: "-100", digestTopicId: 49, now: () => NOW };
    const r = await new AssetDigestRunner(deps).runOnce();
    expect(r.sent).toBe(false);
    expect(r.reason).toBe("delivery failed");
    const { bot, sent } = fakeBot();
    expect((await new AssetDigestRunner({ ...deps, getBot: () => bot }).runOnce()).sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe("deadline alerts and reminders", () => {
  it("alerts once for a high-rank opportunity due within 21 days", async () => {
    const hot = add({ value_score: 95, kind: "opportunity", title: "IRAP intake", track: "bids", deadline: inDays(10) });
    add({ value_score: 95, kind: "opportunity", title: "Far away", track: "bids", deadline: inDays(60) });
    add({ value_score: 40, kind: "opportunity", title: "Low value", track: "bids", deadline: inDays(5) });
    expect(selectAlerts(NOW).map((a) => a.id)).toEqual([hot]);

    const { bot, sent } = fakeBot();
    const runner = new AssetDigestRunner({ getBot: () => bot, defaultChatIds: [111], digestChatId: "-100", digestTopicId: 49, now: () => NOW });
    expect((await runner.checkDeadlines()).alerts).toBe(1);
    expect(sent[0].text).toContain("IRAP intake");
    expect((await runner.checkDeadlines()).alerts).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("doesn't alert within 24 hours of the digest showing the opportunity", () => {
    const hot = add({ value_score: 95, kind: "opportunity", title: "PSPC creative RFSA", track: "bids", deadline: inDays(10) });
    setSurfaced(hot, new Date(NOW.getTime() - 2 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    expect(selectAlerts(NOW)).toHaveLength(0);
    expect(selectAlerts(new Date(NOW.getTime() + 21 * 3_600_000))).toHaveLength(0); // 23 h after the digest
    expect(selectAlerts(new Date(NOW.getTime() + 23 * 3_600_000)).map((a) => a.id)).toEqual([hot]); // 25 h after
  });

  it("reminds queued assets at 7 and at 2 days, once each", async () => {
    const q = add({ value_score: 60, kind: "opportunity", title: "Ontario grant", track: "bids", deadline: inDays(6) });
    setAssetStatus(q, "queued", "queue");
    add({ value_score: 60, kind: "opportunity", title: "Not queued", track: "bids", deadline: inDays(6) });

    expect(selectReminders(NOW).map((r) => [r.asset.id, r.mark])).toEqual([[q, 7]]);
    const { bot, sent } = fakeBot();
    const deps = { getBot: () => bot, defaultChatIds: [111], digestChatId: "-100", digestTopicId: 49 };
    expect((await new AssetDigestRunner({ ...deps, now: () => NOW }).checkDeadlines()).reminders).toBe(1);
    expect((await new AssetDigestRunner({ ...deps, now: () => NOW }).checkDeadlines()).reminders).toBe(0);

    const later = new Date(NOW.getTime() + 4 * 86_400_000); // 2 days left
    expect(selectReminders(later).map((r) => r.mark)).toEqual([2]);
    expect((await new AssetDigestRunner({ ...deps, now: () => later }).checkDeadlines()).reminders).toBe(1);
    expect(sent.filter((m) => m.text.includes("Deadline reminder"))).toHaveLength(2);
  });
});

describe("buttons", () => {
  it("maps the file button to the kind's home action and marks the row done", async () => {
    const id = add({ value_score: 70, kind: "technique", title: "J-cut on beat drops", track: "video" });
    const calls: [number, string][] = [];
    const r = await handleAssetCallback(`f:${id}`, async (i, action) => { calls.push([i, action]); return { message: "Added.", home_path: "/skills/x/references/field-notes.md" }; });
    expect(calls).toEqual([[id, "add_to_skill"]]);
    expect(r.ok).toBe(true);
    expect(r.toast).toContain("field-notes.md");

    const rows = digestKeyboard([getAsset(id)! as never]).inline_keyboard as { text: string; callback_data?: string }[][];
    const done = markRowDone(rows, id, r.doneLabel!);
    expect(done[0]).toEqual([{ text: r.doneLabel!, callback_data: `as:n:${id}` }]);
  });

  it("acts on the survivor when the button's asset was merged away", async () => {
    const keep = add({ value_score: 72, kind: "opportunity", title: "RFSA advertising creative", track: "bids", deadline: inDays(5) });
    const dup = add({ value_score: 60, kind: "opportunity", title: "RFSA advertising creative (copy)", track: "bids", deadline: inDays(5) });
    mergeAssets(keep, [dup], "test");
    const calls: [number, string][] = [];
    const r = await handleAssetCallback(`f:${dup}`, async (i, action) => { calls.push([i, action]); return { message: "Pursuing." }; });
    expect(calls).toEqual([[keep, "pursue"]]);
    expect(r.ok).toBe(true);
    expect(r.assetId).toBe(dup); // the row to mark done is still the old button's
  });

  it("reports action errors as a toast instead of throwing", async () => {
    const id = add({ value_score: 70, kind: "dataset", title: "Aerial set", track: "data" });
    const r = await handleAssetCallback(`f:${id}`, async () => { throw new Error("media drive not mounted"); });
    expect(r.ok).toBe(false);
    expect(r.toast).toContain("media drive not mounted");
    expect((await handleAssetCallback("x:999999")).toast).toContain("no longer exists");
  });
});

describe("rendering", () => {
  it("renders one line per asset with icon, link, next action and deadline", () => {
    const id = add({ value_score: 70, kind: "dataset", title: "Aerial <set>", track: "data", next_action: "Download the sample.", deadline: inDays(3) });
    const text = renderDigest([{ ...getAsset(id)!, rank: 70, sources: 1 }], NOW, "America/Toronto", "Skill forge: 1 proposal");
    expect(text).toContain("📊 <a href=");
    expect(text).toContain("Aerial &lt;set&gt;");
    expect(text).toContain("Download the sample.");
    expect(text).toContain("(3d)");
    expect(text).toContain("🔨 Skill forge");
    expect(daysUntil(inDays(3), NOW)).toBe(3);
  });
});

describe("bid-desk verdicts", () => {
  it("keeps NO-GO opportunities out of the digest and alerts, and labels GO ones", () => {
    const nogo = add({ kind: "opportunity", track: "bids", value_score: 90, deadline: inDays(10) });
    const go = add({ kind: "opportunity", track: "bids", value_score: 70, deadline: inDays(40) });
    memo(nogo, "NO-GO");
    memo(go, "GO");
    const picked = selectDigestAssets(NOW);
    expect(picked.map((a) => a.id)).not.toContain(nogo);
    expect(picked.map((a) => a.id)).toContain(go);
    expect(selectAlerts(NOW).map((a) => a.id)).not.toContain(nogo);
    const line = renderDigest(picked, NOW);
    expect(line).toContain("🧾 GO");
  });

  it("resurfaces a GO/MAYBE or soon-closing opportunity after 2 days, others after 7", () => {
    const withMemo = add({ kind: "opportunity", track: "bids", value_score: 70, deadline: inDays(60) });
    const soon = add({ kind: "opportunity", track: "bids", value_score: 70, deadline: inDays(5) });
    const later = add({ kind: "opportunity", track: "bids", value_score: 70, deadline: inDays(60) });
    memo(withMemo, "MAYBE");
    for (const id of [withMemo, soon, later]) setSurfaced(id, daysAgoIso(3));
    const ids = selectDigestAssets(NOW).map((a) => a.id);
    expect(ids).toContain(withMemo);
    expect(ids).toContain(soon);
    expect(ids).not.toContain(later);
  });
});
