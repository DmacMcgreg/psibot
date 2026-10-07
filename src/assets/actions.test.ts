import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { upsertAsset, getAsset } from "./store.ts";
import { runAssetAction, actionHooks, ActionError, insertUnderTrack, parseSize, closeStaleOpportunity } from "./actions.ts";
import { setHomesForTesting, resetHomes, resolveSkillHome, assertInsideHomes, HOMES } from "./homes.ts";
import type { AssetInput } from "./types.ts";

let db: Database;
let root: string;

function skill(dir: string, name: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
}

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);

  root = realpathSync(mkdtempSync(join(tmpdir(), "asset-homes-")));
  const h = {
    mediaDrive: join(root, "drive"),
    databasesDir: join(root, "drive/Databases"),
    hubSkillsDir: join(root, "hub/skills"),
    hubManagedManifest: join(root, "agents/.hub-managed.json"),
    designKitSkillsDir: join(root, "design-kit/.claude/skills"),
    agentsSkillsDir: join(root, "agents"),
    claudeSkillsDir: join(root, "claude-skills"),
    forgeDir: join(root, "forge"),
    designKitIntakeDir: join(root, "design-kit/intake"),
    cloudNexusDir: join(root, "cloud-nexus"),
  };
  for (const d of [h.databasesDir, h.hubSkillsDir, h.designKitSkillsDir, h.agentsSkillsDir, h.claudeSkillsDir]) mkdirSync(d, { recursive: true });
  skill(h.hubSkillsDir, "hubskill");
  skill(h.hubSkillsDir, "design");
  skill(h.agentsSkillsDir, "hubskill"); // derived copy: must never be written
  skill(h.designKitSkillsDir, "design");
  skill(h.agentsSkillsDir, "plainskill");
  skill(join(root, "elsewhere"), "linked");
  symlinkSync(join(root, "elsewhere/linked"), join(h.agentsSkillsDir, "linked"));
  writeFileSync(h.hubManagedManifest, JSON.stringify({ version: 1, skills: ["hubskill", "design"] }));
  setHomesForTesting(h);
});

afterAll(() => {
  resetHomes();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const base = (over: Partial<AssetInput>): AssetInput => ({
  kind: "technique", title: "Speed ramp on beat", url: null, summary: "Ramp clip speed into the beat drop.",
  track: "video", value_score: 70, value_reason: "Directly improves the drone teaser.", next_action: "Try it on the Whistler shot.",
  ...over,
});

function make(over: Partial<AssetInput>, src = { source_kind: "youtube", source_ref: "vid1", source_url: "https://youtu.be/abc", source_title: "Ramp tutorial", evidence: "at 4:12 he ramps to 20%" }) {
  return upsertAsset(base(over), src).id;
}

async function expectError(p: Promise<unknown>, status: number, re?: RegExp) {
  try {
    await p;
    throw new Error("expected an ActionError");
  } catch (e) {
    expect(e).toBeInstanceOf(ActionError);
    expect((e as ActionError).status).toBe(status as never);
    if (re) expect((e as Error).message).toMatch(re);
  }
}

describe("skill ownership", () => {
  it("resolves design-kit first, then hub-managed, then ~/.agents/skills through symlinks", () => {
    expect(resolveSkillHome("design")).toMatchObject({ owner: "design-kit", dir: join(HOMES.designKitSkillsDir, "design") });
    expect(resolveSkillHome("hubskill")).toMatchObject({ owner: "hub", dir: join(HOMES.hubSkillsDir, "hubskill") });
    expect(resolveSkillHome("plainskill")).toMatchObject({ owner: "agents" });
    expect(resolveSkillHome("linked")?.dir).toBe(join(root, "elsewhere/linked"));
    expect(resolveSkillHome("nope")).toBeNull();
    expect(resolveSkillHome("../etc")).toBeNull();
  });

  it("refuses paths outside the homes", () => {
    expect(() => assertInsideHomes("/tmp/evil.md")).toThrow(/outside the asset homes/);
    expect(assertInsideHomes(join(HOMES.forgeDir, "x.md"))).toBe(join(HOMES.forgeDir, "x.md"));
  });
});

describe("add_to_skill", () => {
  it("appends a dated entry to the hub source of truth, never the derived copy or SKILL.md", async () => {
    const id = make({ title: "Hub technique", details: { target_skill: "hubskill", steps: ["Open the timeline", "Ramp to 20%"], timestamp: "4:12" } });
    const r = await runAssetAction(id, "add_to_skill");
    const notes = join(HOMES.hubSkillsDir, "hubskill/references/field-notes.md");
    expect(r.home_path).toBe(notes);
    const body = readFileSync(notes, "utf-8");
    expect(body).toMatch(/^# Field notes: hubskill/);
    expect(body).toMatch(/^## \d{4}-\d{2}-\d{2} · Hub technique <!-- asset:\d+ -->/m);
    expect(body).toContain("1. Open the timeline\n2. Ramp to 20%");
    expect(body).toContain("[Ramp tutorial](https://youtu.be/abc) at 4:12");
    expect(body).toContain('Evidence: "at 4:12 he ramps to 20%"');
    expect(existsSync(join(HOMES.agentsSkillsDir, "hubskill/references"))).toBe(false);
    expect(readFileSync(join(HOMES.hubSkillsDir, "hubskill/SKILL.md"), "utf-8")).toBe("---\nname: hubskill\n---\n# hubskill\n");
    expect(getAsset(id)!.home_path).toBe(notes);
    expect(getAsset(id)!.status).toBe("done");

    const again = await runAssetAction(id, "add_to_skill");
    expect(again.message).toMatch(/Already/);
    expect(readFileSync(notes, "utf-8").match(/<!-- asset:/g)!.length).toBe(1);
  });

  it("sends design-kit skills to design-kit and symlinked skills to their real dir", async () => {
    await runAssetAction(make({ title: "Design technique", details: { target_skill: "design" } }), "add_to_skill");
    expect(existsSync(join(HOMES.designKitSkillsDir, "design/references/field-notes.md"))).toBe(true);
    expect(existsSync(join(HOMES.hubSkillsDir, "design/references/field-notes.md"))).toBe(false);
    const r = await runAssetAction(make({ title: "Linked technique", kind: "prompt", details: { target_skill: "linked" } }), "add_to_skill");
    expect(r.home_path).toBe(join(root, "elsewhere/linked/references/field-notes.md"));
  });

  it("files unknown or missing target skills into new-skills.md grouped by track", async () => {
    await runAssetAction(make({ title: "Hook formula A", track: "social" }), "add_to_skill");
    await runAssetAction(make({ title: "Ad grid B", track: "marketing", details: { target_skill: "ghost-skill" } }), "add_to_skill");
    const r = await runAssetAction(make({ title: "Hook formula C", track: "social" }), "add_to_skill");
    expect(r.message).toMatch(/new-skills\.md under track social/);
    const doc = readFileSync(join(HOMES.forgeDir, "new-skills.md"), "utf-8");
    const social = doc.split("## track: social")[1].split("## track:")[0];
    expect(social).toContain("Hook formula A");
    expect(social).toContain("Hook formula C");
    expect(doc.split("## track: marketing")[1]).toContain("Ad grid B");
  });

  it("rejects the wrong kind", async () => {
    await expectError(runAssetAction(make({ kind: "tool", title: "Some tool", url: "https://example.com/t" }), "add_to_skill"), 400, /technique or prompt/);
  });
});

describe("insertUnderTrack", () => {
  it("appends inside the right section", () => {
    const doc = "# x\n\n## track: a\n\n### one\n\n## track: b\n\n### two\n";
    const out = insertUnderTrack(doc, "a", "### new\n");
    expect(out.indexOf("### new")).toBeLessThan(out.indexOf("## track: b"));
    expect(out.indexOf("### new")).toBeGreaterThan(out.indexOf("### one"));
    expect(insertUnderTrack(doc, "c", "### c\n")).toMatch(/## track: c\n\n### c\n$/);
  });
});

describe("dataset get / download", () => {
  const ds = { kind: "dataset" as const, title: "Short-form ad captions", url: "https://huggingface.co/datasets/Acme/ad-captions",
    track: "data", details: { license: "cc-by-4.0", size: "2 GB", contents: "40k TikTok ad captions with CTR" } };

  it("writes CARD.md and one catalog row, idempotently", async () => {
    const id = make(ds, { source_kind: "hf", source_ref: "acme/ad-captions", source_url: "https://huggingface.co/datasets/Acme/ad-captions", source_title: "HF", evidence: null as never });
    const r = await runAssetAction(id, "get");
    const card = join(HOMES.databasesDir, "huggingface/Acme__ad-captions/CARD.md");
    expect(r.home_path).toBe(card);
    const body = readFileSync(card, "utf-8");
    for (const s of ["cc-by-4.0", "2 GB", "40k TikTok ad captions", "Directly improves", "Try it on", "https://huggingface.co/datasets/Acme/ad-captions"]) expect(body).toContain(s);
    await runAssetAction(id, "get");
    const rows = readFileSync(join(HOMES.databasesDir, "CATALOG.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows.filter((x) => x.asset_id === id)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo_id: "Acme/ad-captions", license: "cc-by-4.0", card });
    expect(getAsset(id)!.status).toBe("in_use");
  });

  it("errors clearly when the drive isn't mounted", async () => {
    const id = make({ ...ds, title: "Other", url: "https://huggingface.co/datasets/Acme/other" });
    const saved = HOMES.mediaDrive;
    setHomesForTesting({ mediaDrive: join(root, "not-mounted") });
    try {
      await expectError(runAssetAction(id, "get"), 503, /isn't mounted/);
    } finally {
      setHomesForTesting({ mediaDrive: saved });
    }
  });

  it("size-checks downloads and starts hf in the background", async () => {
    const id = make({ ...ds, title: "Big", url: "https://huggingface.co/datasets/Acme/big" });
    const calls: { cmd: string[]; log: string }[] = [];
    const orig = { ...actionHooks };
    actionHooks.hfCommand = () => ["/usr/bin/hf"];
    actionHooks.spawn = (cmd, log) => { calls.push({ cmd, log }); return { pid: 42, exited: Promise.resolve(0) }; };
    try {
      actionHooks.datasetBytes = async () => 60 * 1024 ** 3;
      await expectError(runAssetAction(id, "download"), 409, /60 GB, over the 50 GB limit/);
      actionHooks.datasetBytes = async () => null;
      const unknownSize = make({ ...ds, title: "Unknown", url: "https://huggingface.co/datasets/Acme/unknown", details: { license: "mit" } });
      await expectError(runAssetAction(unknownSize, "download"), 409, /Couldn't find the size/);
      expect(calls).toHaveLength(0);

      actionHooks.datasetBytes = async () => 60 * 1024 ** 3;
      const r = await runAssetAction(id, "download", { note: "force it" });
      const dir = join(HOMES.databasesDir, "huggingface/Acme__big");
      expect(calls[0].cmd).toEqual(["/usr/bin/hf", "download", "--repo-type", "dataset", "Acme/big", "--local-dir", join(dir, "data")]);
      expect(calls[0].log).toBe(join(dir, "download.log"));
      expect(r.home_path).toBe(join(dir, "data"));
      expect(existsSync(join(dir, "CARD.md"))).toBe(true);
      await Bun.sleep(5);
      const events = getAsset(id)!.events.map((e) => e.action);
      expect(events).toContain("download_started");
      expect(events).toContain("download_done");
    } finally {
      Object.assign(actionHooks, orig);
    }
  });

  it("refuses non-HF downloads", async () => {
    const id = make({ kind: "dataset", title: "Kaggle thing", url: "https://www.kaggle.com/datasets/x/y", track: "data" });
    await expectError(runAssetAction(id, "download"), 400, /Hugging Face/);
  });

  it("downloads a bare (no /datasets/ prefix) HF URL as a model, with --repo-type model and the models size API", async () => {
    // Filed as kind "dataset" (the extractor's catch-all for anything on HF), but the URL has no
    // /datasets/ or /spaces/ segment, so it's a model repo (bug 6: this used to force --repo-type dataset).
    const id = make({ kind: "dataset", title: "MiniMax-H3-GGUF", url: "https://huggingface.co/unsloth/MiniMax-H3-GGUF", track: "data" });
    const calls: { cmd: string[] }[] = [];
    const sizeCalls: unknown[] = [];
    const orig = { ...actionHooks };
    actionHooks.hfCommand = () => ["/usr/bin/hf"];
    actionHooks.spawn = (cmd) => { calls.push({ cmd }); return { pid: 1, exited: Promise.resolve(0) }; };
    actionHooks.datasetBytes = async (repoId, repoType) => { sizeCalls.push({ repoId, repoType }); return 5 * 1024 ** 3; };
    try {
      const r = await runAssetAction(id, "download");
      expect(sizeCalls).toEqual([{ repoId: "unsloth/MiniMax-H3-GGUF", repoType: "model" }]);
      expect(calls[0].cmd).toEqual(["/usr/bin/hf", "download", "--repo-type", "model", "unsloth/MiniMax-H3-GGUF", "--local-dir", join(HOMES.databasesDir, "huggingface/unsloth__MiniMax-H3-GGUF/data")]);
      expect(r.home_path).toContain("MiniMax-H3-GGUF");
      const card = readFileSync(join(HOMES.databasesDir, "huggingface/unsloth__MiniMax-H3-GGUF/CARD.md"), "utf-8");
      expect(card).toContain("hf download --repo-type model unsloth/MiniMax-H3-GGUF");
    } finally {
      Object.assign(actionHooks, orig);
    }
  });

  it("refuses to download a Hugging Face Space, and doesn't mis-key it as owner spaces/o", async () => {
    const id = make({ kind: "dataset", title: "A demo space", url: "https://huggingface.co/spaces/acme/demo", track: "data" });
    await expectError(runAssetAction(id, "download"), 400, /Space/);
    // "get" still works and records the real repo id (not "spaces/acme").
    const r = await runAssetAction(id, "get");
    const catalog = readFileSync(join(HOMES.databasesDir, "CATALOG.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(catalog.find((x) => x.asset_id === id)).toMatchObject({ repo_id: "acme/demo" });
  });

  it("parses sizes", () => {
    expect(parseSize("12 GB")).toBe(12 * 1024 ** 3);
    expect(parseSize("1.5TB")).toBe(1.5 * 1024 ** 4);
    expect(parseSize("1.2M rows")).toBeNull();
  });
});

describe("send_to_design_kit and pursue", () => {
  it("appends a JSONL line and writes the intake README once", async () => {
    const id = make({ kind: "design_ref", title: "Linear pricing page", url: "https://linear.app/pricing", track: "client-sites", details: { license: "n/a" } });
    const r = await runAssetAction(id, "send_to_design_kit");
    const inbox = join(HOMES.designKitIntakeDir, "inbox.jsonl");
    expect(r.home_path).toBe(inbox);
    expect(readFileSync(join(HOMES.designKitIntakeDir, "README.md"), "utf-8")).toContain("# Intake inbox");
    await runAssetAction(id, "send_to_design_kit");
    const lines = readFileSync(inbox, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ asset_id: id, title: "Linear pricing page", url: "https://linear.app/pricing" });
  });

  it("creates an opportunity file with frontmatter and a bid/no-bid checklist", async () => {
    const id = make({
      kind: "opportunity", title: "Website redesign for Ottawa agency", url: "https://canadabuys.canada.ca/en/tender/123",
      track: "bids", deadline: "2099-11-15", amount: "$40,000",
      details: { org: "Ottawa Agency", reference: "WS123", categories: ["D302A"], opportunity_type: "rfp", eligibility: "Canadian suppliers" },
    }, { source_kind: "canadabuys", source_ref: "WS123", source_url: "https://canadabuys.canada.ca/en/tender/123", source_title: "CanadaBuys", evidence: null as never });
    const r = await runAssetAction(id, "pursue");
    // 2099 is a placeholder deadline (year ≥ 2090, e.g. a supply-arrangement refresh notice): rolling-<slug>, not dated.
    expect(r.home_path).toBe(join(HOMES.cloudNexusDir, "opportunities/rolling-website-redesign-for-ottawa-agency.md"));
    const body = readFileSync(r.home_path!, "utf-8");
    expect(body).toMatch(/^---\ntitle: "Website redesign/);
    for (const s of ['source: "canadabuys"', 'org: "Ottawa Agency"', 'reference: "WS123"', 'deadline: "2099-11-15"', 'amount: "$40,000"', 'categories: ["D302A"]', "status: pursuing", `asset_id: ${id}`, "## Bid / no-bid (1–3 person shop)", "## Requirements to confirm", "## Next steps", "## Links", "Canadian suppliers"]) {
      expect(body).toContain(s);
    }
    expect(existsSync(join(HOMES.cloudNexusDir, "README.md"))).toBe(true);
    writeFileSync(r.home_path!, "edited by David");
    await runAssetAction(id, "pursue");
    expect(readFileSync(r.home_path!, "utf-8")).toBe("edited by David");
  });

  it("stays idempotent by asset id even when the title or deadline changes, and gives a real deadline its own dated file", async () => {
    const id = make({
      kind: "opportunity", title: "Accessibility audit RFSA", url: "https://canadabuys.canada.ca/en/tender/999",
      track: "bids", deadline: "2026-11-30",
    }, { source_kind: "canadabuys", source_ref: "WS999", source_url: "https://canadabuys.canada.ca/en/tender/999", source_title: "CanadaBuys", evidence: null as never });
    const r1 = await runAssetAction(id, "pursue");
    expect(r1.home_path).toBe(join(HOMES.cloudNexusDir, "opportunities/2026-11-30-accessibility-audit-rfsa.md"));
    expect(r1.message).toContain("Created");

    // An amendment moves the tender's deadline, re-scored under the same URL/key so it merges into the same row
    // (bug 10: naming the file after the deadline meant this used to create a second file).
    upsertAsset(
      base({ kind: "opportunity", title: "Accessibility audit RFSA", url: "https://canadabuys.canada.ca/en/tender/999", deadline: "2026-12-15" }),
      { source_kind: "canadabuys", source_ref: "WS999", evidence: null as never },
    );
    const r2 = await runAssetAction(id, "pursue");
    expect(r2.home_path).toBe(r1.home_path);
    expect(r2.message).toBe(`Already pursuing: ${r1.home_path}.`);

    // A different asset with its own placeholder deadline gets its own rolling file, not a collision.
    const rolling = make({ kind: "opportunity", title: "ProServices supply arrangement", deadline: "2099-01-01" });
    const r3 = await runAssetAction(rolling, "pursue");
    expect(r3.home_path).toBe(join(HOMES.cloudNexusDir, "opportunities/rolling-proservices-supply-arrangement.md"));
  });
});

describe("closeStaleOpportunity", () => {
  it("marks an open opportunity done with a closed_or_cancelled outcome, but never moves a done or dismissed asset backwards", async () => {
    const open = make({ kind: "opportunity", title: "Tender that disappeared", track: "bids" });
    closeStaleOpportunity(open, "canadabuys: notice no longer in the open file");
    const a = getAsset(open)!;
    expect(a.status).toBe("done");
    expect(a.outcome).toBe("closed_or_cancelled");
    expect(a.events[0]).toMatchObject({ action: "feed_closed", note: "canadabuys: notice no longer in the open file" });

    const dismissed = make({ kind: "opportunity", title: "Already dismissed by David" });
    await runAssetAction(dismissed, "dismiss", { note: "irrelevant" });
    closeStaleOpportunity(dismissed, "canadabuys: notice no longer in the open file");
    expect(getAsset(dismissed)!.status).toBe("dismissed"); // untouched, not resurrected as "done"
  });
});

describe("status actions", () => {
  it("queue / adopt / dismiss / outcome", async () => {
    const id = make({ kind: "tool", title: "Cool CLI", url: "https://github.com/a/cool", details: { install: "npx cool" } });
    expect((await runAssetAction(id, "queue")).asset.status).toBe("queued");
    const adopt = await runAssetAction(id, "adopt");
    expect(adopt.asset.status).toBe("in_use");
    expect(adopt.message).toContain("npx cool");
    expect(adopt.home_path).toBeUndefined();
    const out = await runAssetAction(id, "outcome", { outcome: "installed", note: "works" });
    expect(out.asset).toMatchObject({ status: "in_use", outcome: "installed" });
    await expectError(runAssetAction(id, "outcome", { outcome: "meh" }), 400, /outcome must be/);
    const d = await runAssetAction(id, "dismiss", { note: "already_have it via brew" });
    expect(d.asset).toMatchObject({ status: "dismissed", outcome: "dismissed:already_have" });
    expect(d.asset.events[0]).toMatchObject({ action: "dismiss", note: "already_have it via brew" });
    const won = make({ kind: "opportunity", title: "Grant", track: "bids" });
    expect((await runAssetAction(won, "outcome", { note: "won $25k" })).asset).toMatchObject({ status: "done", outcome: "won" });
  });

  it("404s unknown assets and rejects unknown actions", async () => {
    await expectError(runAssetAction(999_999, "queue"), 404);
    await expectError(runAssetAction(1, "explode"), 400, /Unknown action/);
  });
});
