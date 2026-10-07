import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { Hono } from "hono";
import { mkdtempSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../../db/schema.ts";
import { setDbForTesting } from "../../db/index.ts";
import { upsertAsset } from "../../assets/store.ts";
import { parseGoals, loadGoals } from "../../assets/goals.ts";
import { setHomesForTesting, resetHomes } from "../../assets/homes.ts";
import { createAssetRoutes, goalsProblems, type GoalsStore } from "./assets.ts";

/**
 * Asset API contract (vivaldi-home/research/revamp-design.md): list, summary,
 * detail, actions and the goals editor. Uses an in-memory DB, temp homes and
 * an in-memory goals store, so it never touches the real GOALS.md.
 */

let db: Database;
let root: string;
let goalsRaw = "## track: bids\nweight: 3\nWin work.\n- wins: tenders\n- not: construction\n";
const goals: GoalsStore = {
  load: () => ({ raw: goalsRaw, tracks: parseGoals(goalsRaw) }),
  save: (raw) => { goalsRaw = raw; return goals.load(); },
};
const app = new Hono();

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
  root = realpathSync(mkdtempSync(join(tmpdir(), "asset-routes-")));
  setHomesForTesting({ cloudNexusDir: join(root, "cloud-nexus"), designKitIntakeDir: join(root, "intake"), forgeDir: join(root, "forge") });
  app.route("/", createAssetRoutes({ goals }));

  const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  upsertAsset({ kind: "opportunity", title: "City RFP", summary: "Web redesign.", track: "bids", value_score: 60, value_reason: "Fits.", next_action: "Read it.", deadline: soon, amount: "$30,000", details: { org: "City" } },
    { source_kind: "canadabuys", source_ref: "r1", source_url: "https://canadabuys.canada.ca/r1" });
  upsertAsset({ kind: "tool", title: "Site generator", url: "https://github.com/a/gen", summary: "Generates sites.", track: "client-sites", tracks: ["marketing"], value_score: 90, value_reason: "Core.", next_action: "Try it.", details: { install: "npx gen" } },
    { source_kind: "github", source_ref: "a/gen" });
  upsertAsset({ kind: "technique", title: "Hook formula", summary: "Three-beat hook.", track: "social", value_score: 20, value_reason: "Meh.", next_action: "Test.", details: { steps: ["a"] } },
    { source_kind: "youtube", source_ref: "v1" });
});

afterAll(() => {
  resetHomes();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string) => { const r = await app.request(path); return { status: r.status, body: (await r.json()) as any }; };
const post = async (path: string, body: unknown, form = false) => {
  const r = await app.request(path, form
    ? { method: "POST", body: new URLSearchParams(body as Record<string, string>) }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

describe("GET /api/assets", () => {
  it("lists ranked assets with parsed fields and a total", async () => {
    const { status, body } = await get("/api/assets?status=open");
    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.items[0].title).toBe("Site generator");
    expect(body.items[0].details).toEqual({ install: "npx gen" });
    expect(body.items[0].tracks).toEqual(["client-sites", "marketing"]);
    expect(typeof body.items[0].rank).toBe("number");
    expect(body.items[0].sources).toBe(1);
  });

  it("filters by kind, track, q and paginates", async () => {
    expect((await get("/api/assets?kind=technique")).body.items.map((a: any) => a.title)).toEqual(["Hook formula"]);
    expect((await get("/api/assets?track=marketing")).body.total).toBe(1);
    expect((await get("/api/assets?q=redesign")).body.items[0].title).toBe("City RFP");
    const page = (await get("/api/assets?limit=1&offset=1")).body;
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
    expect((await get("/api/assets?status=bogus")).status).toBe(400);
    expect((await get("/api/assets?kind=bogus")).status).toBe(400);
  });
});

describe("GET /api/assets/summary and /:id", () => {
  it("returns counts, top 5, deadlines ≤ 21 days and tracks", async () => {
    const { body } = await get("/api/assets/summary");
    expect(body.counts.reduce((s: number, c: any) => s + c.n, 0)).toBe(3);
    expect(body.top.length).toBe(3);
    expect(body.deadlines.map((a: any) => a.title)).toEqual(["City RFP"]);
    expect(body.tracks.map((t: any) => t.id)).toEqual(["bids"]);
  });

  it("returns one asset with sources and events", async () => {
    const { body } = await get("/api/assets/1");
    expect(body.title).toBe("City RFP");
    expect(body.sources[0]).toMatchObject({ source_kind: "canadabuys", source_url: "https://canadabuys.canada.ca/r1" });
    expect(body.events).toEqual([]);
    expect(body.details).toEqual({ org: "City" });
    expect((await get("/api/assets/999")).status).toBe(404);
  });
});

describe("POST /api/assets/:id/action", () => {
  it("runs a filing action and returns home_path + message", async () => {
    const { status, body } = await post("/api/assets/1/action", { action: "pursue" });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.home_path).toMatch(/cloud-nexus\/opportunities\/\d{4}-\d{2}-\d{2}-city-rfp\.md$/);
    expect(existsSync(body.home_path)).toBe(true);
    expect(body.asset.status).toBe("in_use");
    expect(body.asset.home_path).toBe(body.home_path);
    expect(body.message).toContain("bid/no-bid");
  });

  it("accepts form bodies and status actions", async () => {
    const { body } = await post("/api/assets/3/action", { action: "dismiss", note: "low_quality" }, true);
    expect(body.asset).toMatchObject({ status: "dismissed", outcome: "dismissed:low_quality" });
    expect((await get("/api/assets?status=dismissed")).body.total).toBe(1);
  });

  it("returns errors as { ok: false, message } with the right status", async () => {
    expect((await post("/api/assets/2/action", {})).status).toBe(400);
    const wrong = await post("/api/assets/2/action", { action: "pursue" });
    expect(wrong.status).toBe(400);
    expect(wrong.body).toMatchObject({ ok: false });
    expect(wrong.body.message).toMatch(/opportunity/);
    expect((await post("/api/assets/999/action", { action: "queue" })).status).toBe(404);
  });
});

describe("/api/goals", () => {
  it("reads and saves goals, rejecting invalid files", async () => {
    expect((await get("/api/goals")).body.tracks[0].id).toBe("bids");
    const put = (raw: unknown) => app.request("/api/goals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw }) });
    const bad = await put("# no tracks here\n");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toMatch(/at least one/);
    expect((await put("## track: a\nweight: lots\n")).status).toBe(400);
    expect((await put("## track: a\nweight: 1\n\n## track: a\nweight: 2\n")).status).toBe(400);
    expect((await put(42)).status).toBe(400);
    expect(goalsRaw).toContain("## track: bids");

    const ok = await put("## track: video\nweight: 2\nEdit faster.\n- wins: ffmpeg\n- not: gear\n");
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).tracks.map((t: any) => t.id)).toEqual(["video"]);
    expect(goalsRaw).toContain("## track: video");
  });

  it("accepts the real GOALS.md", () => {
    expect(goalsProblems(loadGoals().raw)).toEqual([]);
  });
});
