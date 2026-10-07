import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { getOpsState, setOpsState } from "../db/queries.ts";
import { setHomesForTesting, resetHomes } from "./homes.ts";
import {
  assetKey, upsertAsset, listAssets, getAsset, setAssetStatus, rankOf, daysUntil, designLibraryIds,
  mergeAssets, mergedInto, addAssetEvent,
} from "./store.ts";
import { parseGoals, loadGoals } from "./goals.ts";
import type { AssetInput } from "./types.ts";

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
  // No design-kit catalog here: only the fixed library hosts apply.
  setHomesForTesting({ designKitIntakeDir: join(mkdtempSync(join(tmpdir(), "dk-")), "catalog/intake") });
});
afterAll(() => {
  resetHomes();
  db.close();
});

const base: AssetInput = {
  kind: "dataset", title: "TikTok ads corpus", url: "https://huggingface.co/datasets/Acme/tiktok-ads?utm_source=x",
  summary: "2M scraped TikTok ads with captions.", track: "data", value_score: 60,
  value_reason: "Training data for ad-copy skill.", next_action: "Download the sample split.",
};

describe("assetKey", () => {
  it("keys HF datasets and GitHub repos on repo id", () => {
    expect(assetKey(base)).toBe("hf:dataset:acme/tiktok-ads");
    expect(assetKey({ kind: "tool", title: "x", url: "https://github.com/Foo/Bar/tree/main/src" })).toBe("gh:foo/bar");
    expect(assetKey({ kind: "technique", title: "J-cut on beat drops!", url: "https://youtube.com/watch?v=1" })).toBe("technique:j-cut-on-beat-drops");
  });

  it("puts the Hugging Face repo type in the key", () => {
    const hf = (url: string, kind: AssetInput["kind"] = "dataset") => assetKey({ kind, title: "x", url });
    expect(hf("https://huggingface.co/datasets/Acme/Demo")).toBe("hf:dataset:acme/demo");
    expect(hf("https://huggingface.co/Acme/Demo")).toBe("hf:model:acme/demo");
    expect(hf("https://huggingface.co/spaces/Acme/Demo")).toBe("hf:space:acme/demo");
    expect(hf("https://hf.co/Acme/Demo/tree/main", "tool")).toBe("hf:model:acme/demo");
    // Site pages are not repos.
    expect(hf("https://huggingface.co/docs/hub", "tool")).toBe("huggingface.co/docs/hub");
    // Without a repo URL, a dataset's repo_id still keys it.
    expect(assetKey({ kind: "dataset", title: "x", url: "https://example.com/post", details: { repo_id: "Acme/Demo" } })).toBe("hf:dataset:acme/demo");
  });

  it("prefers the repo in the URL and ignores free-text repo fields", () => {
    const key = (url: string, details: AssetInput["details"], kind: AssetInput["kind"] = "tool") => assetKey({ kind, title: "x", url, details });
    expect(key("https://github.com/right/repo", { repo: "wrong/repo" })).toBe("gh:right/repo");
    expect(key("https://huggingface.co/MiniMaxAI/MiniMax-H3", { repo_id: "MiniMaxAI/MiniMax-H3 (ComfyUI repackage: Comfy-Org/MiniMax-H3)" }, "dataset"))
      .toBe("hf:model:minimaxai/minimax-h3");
    expect(key("https://developers.cloudflare.com/browser-rendering/stagehand/", { repo: "@browserbasehq/stagehand (npm)" }))
      .toBe("developers.cloudflare.com/browser-rendering/stagehand");
    expect(key("https://voltagent.dev/recipes/youtube-blog-agent/", { repo: "voltagent/voltagent — examples/with-youtube-to-blog" }))
      .toBe("voltagent.dev/recipes/youtube-blog-agent");
    // A bare owner/name still keys a repo whose URL is elsewhere.
    expect(key("https://www.remotion.dev", { repo: "remotion-dev/remotion" })).toBe("gh:remotion-dev/remotion");
    // github.com site pages are not repos.
    expect(key("https://github.com/topics/seo", {})).toBe("github.com/topics/seo");
  });

  it("keys one skill inside a grab-bag repo, and whole packs on the repo", () => {
    const key = (url: string, details?: AssetInput["details"]) => assetKey({ kind: "skill", title: "x", url, details });
    expect(key("https://github.com/wshobson/agents")).toBe("gh:wshobson/agents");
    expect(key("https://github.com/wshobson/agents/tree/main/plugins/accessibility/skills/wcag-audit-patterns")).toBe("gh:wshobson/agents#wcag-audit-patterns");
    expect(key("https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md")).toBe("gh:anthropics/skills#pptx");
    expect(key("https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design", { repo: "anthropics/claude-code (plugins/frontend-design)" }))
      .toBe("gh:anthropics/claude-code#frontend-design");
    expect(key("https://skills.sh/anthropics/skills/theme-factory", { repo: "anthropics/skills" })).toBe("gh:anthropics/skills#theme-factory");
    expect(key("https://github.com/acme/tools", { skill_name: "Brand Voice" })).toBe("gh:acme/tools#brand-voice");
    // A file right under skills/ is not a skill folder.
    expect(key("https://github.com/acme/tools/blob/main/skills/README.md")).toBe("gh:acme/tools");
    // A single-skill repo's skill keeps the repo key, so both sightings merge.
    expect(key("https://skills.sh/mikehasa/golive-skill/golive")).toBe("gh:mikehasa/golive-skill");
    expect(key("https://github.com/acme/humanizer", { skill_name: "humanizer" })).toBe("gh:acme/humanizer");
  });

  it("keys design refs per page; a library site's root keys on the library, a named block on its page", () => {
    const key = (url: string) => assetKey({ kind: "design_ref", title: "x", url });
    expect(key("https://dribbble.com/shots/123-crm")).not.toBe(key("https://dribbble.com/shots/456-landing"));
    expect(key("http://www.dribbble.com/shots/123-crm/?utm_source=x&page=2#comments")).toBe("design_ref:dribbble.com/shots/123-crm");
    expect(key("https://github.com/chyrkov/pizza-project")).toBe("design_ref:github.com/chyrkov/pizza-project");
    expect(key("https://youtube.com/watch?v=abcdefghijk&t=30")).toBe("design_ref:youtube.com/watch?v=abcdefghijk");
    expect(key("https://reui.io")).toBe("design_ref:reui.io");
    expect(key("https://www.reui.io/?ref=x")).toBe("design_ref:reui.io");
    expect(key("https://reui.io/blocks/solutions/agents")).toBe("design_ref:reui.io/blocks/solutions/agents");
    expect(key("https://reui.io/preview/base/agent-activity-1")).toBe("design_ref:reui.io/preview/base/agent-activity-1");
    expect(key("https://www.shadcnblocks.com/block/hero125")).toBe("design_ref:shadcnblocks.com/block/hero125");
    expect(key("https://ui.shadcn.com/blocks")).toBe("design_ref:ui.shadcn.com/blocks");
  });

  it("reads library identities from design-kit's catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "libs-"));
    const file = join(dir, "libraries.json");
    writeFileSync(file, JSON.stringify([
      { name: "Aceternity", url: "https://ui.aceternity.com/" },
      { name: "Tailwind Plus", url: "https://tailwindcss.com/plus" },
      { name: "On GitHub", url: "https://github.com/ui-layouts/uilayouts" },
      { name: "On npm", url: "https://www.npmjs.com/package/super-hover" },
      { name: "No url" },
    ]));
    const ids = designLibraryIds(file);
    expect(ids.has("ui.aceternity.com")).toBe(true);
    expect(ids.has("tailwindcss.com/plus")).toBe(true);
    expect(ids.has("tailwindcss.com")).toBe(false);
    expect([...ids].some((i) => i.startsWith("github.com") || i.startsWith("npmjs.com"))).toBe(false);
    expect(ids.has("reui.io")).toBe(true); // the fixed list always applies
    expect(designLibraryIds(join(dir, "missing.json")).has("magicui.design")).toBe(true);
  });
});

describe("upsertAsset", () => {
  it("merges sightings, keeps the best score, never resets status", () => {
    const a = upsertAsset(base, { source_kind: "youtube", source_ref: "vid1" });
    expect(a.created).toBe(true);
    setAssetStatus(a.id, "queued", "get");
    const b = upsertAsset({ ...base, url: "https://hf.co/x", details: { repo_id: "acme/tiktok-ads", license: "cc-by-4.0" }, value_score: 80, value_reason: "Better reason", track: "marketing" },
      { source_kind: "hf", source_ref: "acme/tiktok-ads" });
    expect(b).toEqual({ id: a.id, created: false });
    const lower = upsertAsset({ ...base, value_score: 10, value_reason: "worse" }, { source_kind: "tab", source_ref: "t9" });
    expect(lower.id).toBe(a.id);
    const got = getAsset(a.id)!;
    expect(got.value_score).toBe(80);
    expect(got.value_reason).toBe("Better reason");
    expect(got.status).toBe("queued");
    expect(JSON.parse(got.tracks_json).sort()).toEqual(["data", "marketing"]);
    expect(JSON.parse(got.details_json).license).toBe("cc-by-4.0");
    expect(got.sources.length).toBe(3);
    expect(got.events[0].action).toBe("get");
  });

  it("hides expired deadlines and ranks urgent ones up", () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    upsertAsset({ ...base, kind: "opportunity", title: "Past RFP", url: "https://canadabuys.canada.ca/a", deadline: "2020-01-01", track: "bids" }, { source_kind: "canadabuys", source_ref: "a" });
    upsertAsset({ ...base, kind: "opportunity", title: "Soon RFP", url: "https://canadabuys.canada.ca/b", deadline: soon, track: "bids", value_score: 70 }, { source_kind: "canadabuys", source_ref: "b" });
    const titles = listAssets({ status: "open" }).map((r) => r.title);
    expect(titles).not.toContain("Past RFP");
    expect(titles[0]).toBe("Soon RFP");
    expect(rankOf({ kind: "opportunity", value_score: 70, track: "bids", deadline: "2020-01-01" })).toBe(0);
  });

  it("lets a feed's re-score lower an opportunity, but keeps the best score otherwise", () => {
    const tender: AssetInput = {
      ...base, kind: "opportunity", title: "Web redesign RFP", url: "https://canadabuys.canada.ca/rescore", track: "bids",
      value_score: 82, value_reason: "Winnable.", deadline: "2030-01-15", extractor: "feed:canadabuys:v1",
    };
    const { id } = upsertAsset(tender, { source_kind: "canadabuys", source_ref: "r1" });
    upsertAsset({ ...tender, value_score: 30, value_reason: "Amendment 2 requires Secret clearance." }, { source_kind: "canadabuys", source_ref: "r1" });
    expect(getAsset(id)!.value_score).toBe(30);
    expect(getAsset(id)!.value_reason).toBe("Amendment 2 requires Secret clearance.");
    // The extractor seeing it in a video doesn't override the feed downward...
    upsertAsset({ ...tender, value_score: 20, extractor: "extract:v1:glm" }, { source_kind: "youtube", source_ref: "v9" });
    expect(getAsset(id)!.value_score).toBe(30);
    // ...and other kinds keep their best score even from a feed.
    const tool = upsertAsset({ ...base, kind: "tool", title: "Tool", url: "https://github.com/acme/rescore-tool", value_score: 70, extractor: "feed:github:v1" }, { source_kind: "github-search", source_ref: "t1" });
    upsertAsset({ ...base, kind: "tool", title: "Tool", url: "https://github.com/acme/rescore-tool", value_score: 40, extractor: "feed:github:v1" }, { source_kind: "github-search", source_ref: "t1" });
    expect(getAsset(tool.id)!.value_score).toBe(70);
  });
});

describe("rankOf", () => {
  const tender = { kind: "opportunity" as const, value_score: 72, track: "bids", deadline: "2026-10-01" };

  it("keeps a deadline open through the end of its day in Toronto", () => {
    const at = (iso: string) => rankOf(tender, new Date(iso));
    expect(at("2026-09-30T23:59:00Z")).toBe(97); // 19:59 EDT Sep 30: 1 day left
    expect(at("2026-10-01T00:30:00Z")).toBe(97); // 20:30 EDT Sep 30: still 1 day left
    expect(at("2026-10-01T16:00:00Z")).toBe(98); // noon Oct 1: closes today
    expect(at("2026-10-02T04:30:00Z")).toBe(0); // 00:30 EDT Oct 2: closed
    expect(daysUntil("2026-10-01", new Date("2026-10-01T00:30:00Z"))).toBe(1);
    expect(daysUntil("2026-10-01", new Date("2026-10-02T03:59:00Z"))).toBe(0);
  });

  it("lists the tender until its local day ends", () => {
    upsertAsset({ ...base, kind: "opportunity", title: "Closes Oct 1", url: "https://canadabuys.canada.ca/oct1", track: "bids", value_score: 72, deadline: "2026-10-01" }, { source_kind: "canadabuys", source_ref: "oct1" });
    const listed = (iso: string) => listAssets({ kind: "opportunity", now: new Date(iso), limit: 100 }).find((a) => a.title === "Closes Oct 1");
    expect(listed("2026-10-02T00:30:00Z")?.rank).toBeGreaterThan(90); // 20:30 EDT Oct 1
    expect(listed("2026-10-02T04:30:00Z")).toBeUndefined(); // 00:30 EDT Oct 2
  });

  it("ranks open paid work above a generic skill or tool pack at the same score", () => {
    const today = new Date("2026-09-27T12:10:00Z");
    const skill = rankOf({ kind: "skill", value_score: 80, track: "marketing", deadline: null }, today);
    const tool = rankOf({ kind: "tool", value_score: 80, track: "bids", deadline: null }, today);
    const farTender = rankOf({ kind: "opportunity", value_score: 80, track: "bids", deadline: "2027-09-30" }, today);
    const rolling = rankOf({ kind: "opportunity", value_score: 80, track: "bids", deadline: "2099-11-22" }, today);
    const soon = rankOf({ kind: "opportunity", value_score: 80, track: "bids", deadline: "2026-10-05" }, today);
    expect(skill).toBe(72);
    expect(tool).toBe(72);
    expect(farTender).toBe(83);
    expect(rolling).toBe(83); // a placeholder deadline is rolling: small boost, no urgency
    expect(soon).toBeGreaterThan(rolling + 15);
    // A lower-weight track still outranks the pack at the same score.
    expect(rankOf({ kind: "opportunity", value_score: 80, track: "ai-services", deadline: "2099-11-22" }, today)).toBeGreaterThan(skill);
  });

  it("stays within 0–100", () => {
    const today = new Date("2026-09-27T12:10:00Z");
    expect(rankOf({ kind: "opportunity", value_score: 100, track: "bids", deadline: "2026-09-27" }, today)).toBe(100);
    expect(rankOf({ kind: "skill", value_score: 100, track: "marketing", deadline: null }, today)).toBe(90);
    expect(rankOf({ kind: "tool", value_score: -50, track: "bids", deadline: "2026-09-28" }, today)).toBe(0);
  });
});

describe("mergeAssets", () => {
  it("folds duplicates into the survivor and leaves no orphans", () => {
    const tool = (title: string, url: string, value_score: number, track: string) =>
      upsertAsset({ ...base, kind: "tool", title, url, value_score, track }, { source_kind: "tab", source_ref: url }).id;
    const keep = tool("Higgsfield MCP", "https://higgsfield.ai", 50, "video");
    const dupA = tool("Higgsfield plugin", "https://higgsfield.ai/plugins/davinci", 65, "social");
    const dupB = tool("Higgsfield pricing", "https://higgsfield.ai/pricing", 40, "marketing");
    addAssetEvent(dupA, "queue");
    setOpsState(`asset_digest:alert:${dupA}`, "2026-09-26T14:30:00Z");
    db.prepare("UPDATE assets SET surfaced_at = ? WHERE id = ?").run("2026-09-26T12:00:00Z", dupB);

    mergeAssets(keep, [dupA, dupB], "Higgsfield:");
    const got = getAsset(keep)!;
    expect(got.value_score).toBe(65);
    expect(JSON.parse(got.tracks_json).sort()).toEqual(["marketing", "social", "video"]);
    expect(got.surfaced_at).toBe("2026-09-26T12:00:00Z");
    expect(got.sources.map((s) => s.source_ref).sort()).toEqual(["https://higgsfield.ai", "https://higgsfield.ai/plugins/davinci", "https://higgsfield.ai/pricing"]);
    expect(got.events.map((e) => e.action)).toEqual(["merged", "queue"]);
    expect(got.events[0].note).toBe(`Higgsfield: merged ${dupA},${dupB}`);
    expect(getAsset(dupA)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM asset_sources WHERE asset_id IN (?, ?)").get(dupA, dupB)).toEqual({ n: 0 });
    expect(getOpsState(`asset_digest:alert:${keep}`)).toBe("2026-09-26T14:30:00Z");
    expect(mergedInto(dupA)).toBe(keep);
    expect(mergedInto(dupB)).toBe(keep);
    expect(mergedInto(keep)).toBeNull();
  });

  it("finds survivors from older merge notes too", () => {
    const keep = upsertAsset({ ...base, kind: "tool", title: "Survivor", url: "https://example.com/survivor" }, { source_kind: "tab", source_ref: "s" }).id;
    addAssetEvent(keep, "merged", "merged duplicate asset #9035");
    addAssetEvent(keep, "merged", "merged 9139,9145 (same site)");
    expect(mergedInto(9035)).toBe(keep);
    expect(mergedInto(9145)).toBe(keep);
    expect(mergedInto(987654)).toBeNull();
  });
});

describe("goals", () => {
  it("parses the real GOALS.md", () => {
    const g = loadGoals();
    expect(g.tracks.map((t) => t.id)).toEqual(["client-sites", "marketing", "social", "video", "bids", "data", "ai-services"]);
    const bids = g.tracks.find((t) => t.id === "bids")!;
    expect(bids.weight).toBe(3);
    expect(bids.wins).toContain("CanadaBuys");
    expect(bids.not).toContain("clearance");
  });
  it("parses a minimal file", () => {
    expect(parseGoals("## track: a\nweight: 2\nDo a.\n- wins: x\n- not: y\n")).toEqual([{ id: "a", weight: 2, description: "Do a.", wins: "x", not: "y" }]);
  });
});
