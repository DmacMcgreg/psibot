import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { buildOwnedIndex, ownedMatch, markOwned, dismissIfOwned, assetIds, normRepo, type OwnedIndex } from "./owned.ts";
import { upsertAsset, getAsset, setAssetStatus } from "./store.ts";
import type { AssetInput } from "./types.ts";

let root: string;
let index: OwnedIndex;

function write(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "owned-test-"));
  // Installed skills: two local folders plus the skills CLI lock file.
  for (const s of ["design", "impeccable", "tdd", "qa", "hyperframes"]) write(join(root, "agents/skills", s, "SKILL.md"), "---\nname: x\n---\n");
  write(join(root, "agents/.skill-lock.json"), JSON.stringify({
    version: 3,
    skills: {
      impeccable: { source: "pbakaus/impeccable", sourceType: "github" },
      tdd: { source: "mattpocock/skills", sourceType: "github" },
      qa: { source: "mattpocock/skills", sourceType: "github" },
      hyperframes: { source: "heygen-com/hyperframes", sourceType: "github" },
    },
  }));
  // Plugins: frontend-design from Anthropic's claude-code marketplace, diagram-design from its own repo.
  const plugins = join(root, "plugins");
  write(join(plugins, "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: {
      "frontend-design@claude-code-plugins": [{ installPath: join(plugins, "cache/claude-code-plugins/frontend-design/1.0.0") }],
      "diagram-design@diagram-design": [{ installPath: join(plugins, "cache/diagram-design/diagram-design/2.4.0") }],
    },
  }));
  write(join(plugins, "known_marketplaces.json"), JSON.stringify({
    "claude-code-plugins": { source: { source: "github", repo: "anthropics/claude-code" } },
    "diagram-design": { source: { source: "github", repo: "cathrynlavery/diagram-design" } },
    "superpowers-marketplace": { source: { source: "github", repo: "obra/superpowers-marketplace" } },
  }));
  write(join(plugins, "cache/diagram-design/diagram-design/2.4.0/skills/diagram-design/SKILL.md"), "x");
  mkdirSync(join(plugins, "cache/claude-code-plugins/frontend-design/1.0.0"), { recursive: true });
  // design-kit catalog.
  write(join(root, "libraries.json"), JSON.stringify([
    { name: "REUI", url: "https://reui.io", repo: "keenthemes/reui" },
    { name: "MapCN Blocks", url: "https://www.mapcn.dev/blocks", repo: "AnmolSaini16/mapcn" },
    { name: "Myna UI", url: "https://tailkits.com/components/myna-ui/", repo: null },
    { name: "Indie UI", url: "https://github.com/birobirobiro/awesome-shadcn-ui", repo: "birobirobiro/awesome-shadcn-ui" },
    { name: "super-hover", url: "https://www.npmjs.com/package/super-hover", repo: "danielpetho/super-hover" },
  ]));
  // Cloned repos.
  write(join(root, "code/VoiceInk/.git/config"), '[remote "origin"]\n\turl = https://github.com/Beingpax/VoiceInk.git\n');
  write(join(root, "code/notes/README.md"), "not a repo");

  index = buildOwnedIndex({
    skillDirs: [join(root, "agents/skills"), join(root, "claude/skills")],
    skillLock: join(root, "agents/.skill-lock.json"),
    pluginsDir: plugins,
    catalog: join(root, "libraries.json"),
    cloneRoots: [join(root, "code")],
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const is = (a: Parameters<typeof ownedMatch>[0]) => ownedMatch(a, index);

describe("assetIds", () => {
  it("reads repos, named skills and packages from the URL and install command", () => {
    const ids = assetIds({
      kind: "skill", url: "https://github.com/Mikehasa/golive-skill/tree/main/skills/golive",
      details: { install: "npx skills add https://github.com/mikehasa/golive-skill --skill golive --global\nnpx --yes @agent-native/core@latest create x", repo: "junk (not a repo)" },
    });
    expect(ids.repos).toEqual(["mikehasa/golive-skill"]);
    expect(assetIds({ kind: "skill", url: null, details: { install: "npx skills add a/b --skill one two\nnpx other" } }).names).toEqual(["one", "two"]);
    expect(ids.names).toEqual(["golive"]);
    expect(ids.packages).toContain("@agent-native/core");
    expect(ids.host).toBe("github.com");
  });
  it("normalises repo ids and rejects free text", () => {
    expect(normRepo("https://github.com/Foo/Bar.git")).toBe("foo/bar");
    expect(normRepo("anthropics/claude-code (plugins/frontend-design)")).toBeNull();
  });
});

describe("ownedMatch", () => {
  it("matches installed plugins by marketplace repo and named plugin", () => {
    expect(is({ kind: "skill", url: "https://github.com/cathrynlavery/diagram-design", details: { install: "/plugin install diagram-design@diagram-design" } }).owned).toBe(true);
    const fd = is({ kind: "skill", url: "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design" });
    expect(fd).toMatchObject({ owned: true });
    expect(fd.reason).toContain("frontend-design");
    // Another plugin from the same marketplace repo is new.
    expect(is({ kind: "skill", url: "https://github.com/anthropics/claude-code/tree/main/plugins/code-simplifier" }).owned).toBe(false);
    // A marketplace that is only known, with nothing installed from it, doesn't count.
    expect(is({ kind: "skill", url: "https://github.com/obra/superpowers-marketplace" }).owned).toBe(false);
  });

  it("treats a multi-skill repo as owned unless the asset names a skill that isn't installed", () => {
    expect(is({ kind: "skill", url: "https://github.com/mattpocock/skills" }).owned).toBe(true);
    expect(is({ kind: "skill", url: "https://github.com/mattpocock/skills", details: { install: "npx skills add mattpocock/skills --skill tdd qa" } }).owned).toBe(true);
    expect(is({ kind: "skill", url: "https://github.com/mattpocock/skills", details: { install: "npx skills add mattpocock/skills --skill brand-new" } }).owned).toBe(false);
  });

  it("matches the same skill published in another repo of the same owner", () => {
    expect(is({ kind: "skill", url: "https://github.com/anthropics/skills/tree/main/skills/frontend-design" }).owned).toBe(true);
    expect(is({ kind: "skill", url: "https://github.com/anthropics/skills/tree/main/skills/pdf" }).owned).toBe(false);
  });

  it("never matches on a fuzzy name: a skill named like a repo is not ownership", () => {
    // "design" and "impeccable" are installed, but these are other people's repos.
    expect(is({ kind: "skill", url: "https://github.com/acme/design" }).owned).toBe(false);
    expect(is({ kind: "skill", url: "https://github.com/acme/seo-skills", details: { install: "npx skills add acme/seo-skills --skill design" } }).owned).toBe(false);
    expect(is({ kind: "tool", url: "https://github.com/Monet-AI-Editor/Monet", title: "Monet — agent-native macOS video editor" }).owned).toBe(false);
    expect(is({ kind: "tool", url: "https://github.com/browser-use/jev-ultrafast" }).owned).toBe(false);
  });

  it("covers David's own stack, his GitHub account and cloned repos", () => {
    expect(is({ kind: "tool", url: "https://github.com/BuilderIO/agent-native" }).reason).toContain("agent-native");
    expect(is({ kind: "tool", url: "https://www.agent-native.com/apps" }).owned).toBe(true);
    expect(is({ kind: "tool", url: "https://example.com/x", details: { install: "npm i @agent-native/core" } }).owned).toBe(true);
    expect(is({ kind: "tool", url: "https://github.com/heygen-com/hyperframes" }).owned).toBe(true);
    expect(is({ kind: "tool", url: "https://openrouter.ai/typesafe/jev-latest" }).owned).toBe(true);
    expect(is({ kind: "tool", url: "https://openrouter.ai/moonshotai/kimi-k3" }).owned).toBe(false);
    expect(is({ kind: "tool", url: "https://github.com/DmacMcgreg/vaultd" }).owned).toBe(true);
    expect(is({ kind: "tool", url: "https://github.com/Beingpax/VoiceInk" }).reason).toContain("cloned at");
  });

  it("owns a design-kit library's site and repo but not a page naming a specific block", () => {
    expect(is({ kind: "design_ref", url: "https://reui.io" }).owned).toBe(true);
    expect(is({ kind: "design_ref", url: "https://www.reui.io/blocks" }).owned).toBe(true);
    expect(is({ kind: "design_ref", url: "https://reui.io/blocks/solutions/agents" }).owned).toBe(false);
    expect(is({ kind: "tool", url: "https://github.com/keenthemes/reui" }).owned).toBe(true);
    // Listed at /blocks: the whole site counts. Listed deep in a directory site: only that path.
    expect(is({ kind: "design_ref", url: "https://mapcn.dev" }).owned).toBe(true);
    expect(is({ kind: "design_ref", url: "https://tailkits.com/components/myna-ui" }).owned).toBe(true);
    expect(is({ kind: "design_ref", url: "https://tailkits.com/components/other-kit" }).owned).toBe(false);
    // Shared hosts never match by host alone; npm packages from the catalog do.
    expect(is({ kind: "tool", url: "https://github.com/someone/else" }).owned).toBe(false);
    expect(is({ kind: "tool", url: "https://www.npmjs.com/package/super-hover" }).owned).toBe(true);
  });

  it("leaves techniques about owned tools, and all opportunities, alone", () => {
    expect(is({ kind: "technique", url: "https://github.com/heygen-com/hyperframes/blob/main/README.md" }).owned).toBe(false);
    expect(is({ kind: "technique", url: "https://github.com/DmacMcgreg/psibot/blob/main/x.md" }).owned).toBe(true);
    expect(is({ kind: "opportunity", url: "https://github.com/DmacMcgreg/psibot" }).owned).toBe(false);
  });
});

describe("markOwned and dismissIfOwned", () => {
  let db: Database;
  beforeAll(() => {
    db = new Database(":memory:");
    sqliteVec.load(db);
    for (const sql of MIGRATIONS) {
      try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
    }
    setDbForTesting(db);
  });
  afterAll(() => db.close());

  const base: AssetInput = {
    kind: "skill", title: "cathrynlavery/diagram-design — diagram skill", url: "https://github.com/cathrynlavery/diagram-design",
    summary: "s", track: "client-sites", value_score: 60, value_reason: "r", next_action: "Install it.",
  };

  it("marks owned assets with the reason and leaves others untouched", () => {
    const marked = markOwned(base, (a) => ownedMatch(a, index));
    expect(marked.details?.owned_reason).toContain("diagram-design");
    const other = { ...base, url: "https://github.com/acme/new-thing" };
    expect(markOwned(other, (a) => ownedMatch(a, index))).toBe(other);
  });

  it("dismisses a new owned asset as already_have, like a Dismiss click, and never touches one David acted on", async () => {
    const marked = markOwned(base, (a) => ownedMatch(a, index));
    const { id } = upsertAsset(marked, { source_kind: "tab", source_ref: "t1" });
    expect(await dismissIfOwned(id, marked)).toBe(true);
    const a = getAsset(id)!;
    expect(a.status).toBe("dismissed");
    expect(a.outcome).toBe("dismissed:already_have");
    expect(a.events[0]).toMatchObject({ action: "dismiss" });
    expect(a.events[0].note).toStartWith("already_have: ");

    const queued = upsertAsset({ ...marked, url: "https://github.com/mattpocock/skills", title: "mattpocock/skills pack" }, { source_kind: "tab", source_ref: "t2" });
    setAssetStatus(queued.id, "queued", "queue");
    expect(await dismissIfOwned(queued.id, { details: { owned_reason: "x" } })).toBe(false);
    expect(getAsset(queued.id)!.status).toBe("queued");
    expect(await dismissIfOwned(queued.id, { details: {} })).toBe(false);
  });
});
