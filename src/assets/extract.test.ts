import { describe, it, expect } from "bun:test";
import {
  validateAssets, isGenericTitle, urlGrounded, prepareText, extractAssets, buildPrompt, MAX_ASSETS, type ExtractItem,
  goldExample, routingBlock, routeSkill, routesFor, targetSkillFits, fixDatasetKind,
} from "./extract.ts";

const TRACKS = ["client-sites", "marketing", "social", "video", "bids", "data", "ai-services"];
const SKILLS = ["drone-video-editing", "writing-skills", "video"];
const opts = { skills: SKILLS, tracks: TRACKS, model: "mock", today: "2026-09-26" };

const item: ExtractItem = {
  source_kind: "research", source_ref: "3", url: "https://github.com/coreyhaines31/marketingskills",
  title: "coreyhaines31/marketingskills — 48 marketing skills",
  text: "Install with npx skills add coreyhaines31/marketingskills -a claude-code. Uses ffmpeg too. See https://remotion.dev/docs for video.",
};

const good = {
  kind: "skill", title: "coreyhaines31/marketingskills — 48 marketing skills for Claude Code",
  url: "https://github.com/coreyhaines31/marketingskills", summary: "Skill pack.", track: "marketing", tracks: ["marketing", "bogus"],
  value_score: 85, value_reason: "Installable today.", next_action: "Run npx skills add coreyhaines31/marketingskills.",
  effort: "S", evidence: "npx skills add", details: { install: "npx skills add coreyhaines31/marketingskills", repo: "coreyhaines31/marketingskills" },
};

describe("validateAssets", () => {
  it("keeps a good asset and cleans its fields", () => {
    const { assets, rejected } = validateAssets({ assets: [good] }, item, item.text, opts);
    expect(rejected).toEqual([]);
    expect(assets).toHaveLength(1);
    expect(assets[0].tracks).toEqual(["marketing"]);
    expect(assets[0].evidence).toBe("npx skills add");
    expect(assets[0].extractor).toBe("extract:v1:mock");
  });

  it("drops unknown kinds, low scores, generic titles and unknown tracks", () => {
    const raw = [
      { ...good, kind: "news" },
      { ...good, title: "Other ffmpeg tool", value_score: 20 },
      { ...good, title: "Consider building a brand voice" },
      { ...good, title: "Useful tools" },
      { ...good, title: "Some ffmpeg thing", track: "gnosis", tracks: [] },
    ];
    const { assets, rejected } = validateAssets({ assets: raw }, item, item.text, opts);
    expect(assets).toHaveLength(0);
    expect(rejected.map((r) => r.reason)).toEqual(["unknown kind news", "score 20", "generic title", "generic title", "unknown track gnosis"]);
  });

  it("falls back to a valid secondary track", () => {
    const { assets } = validateAssets([{ ...good, track: "gnosis", tracks: ["video"] }], item, item.text, opts);
    expect(assets[0].track).toBe("video");
  });

  it("requires a URL for tools and steps for techniques", () => {
    const raw = [
      { ...good, kind: "tool", title: "Mystery CLI for sites", url: null, details: {} },
      { ...good, kind: "technique", title: "Speed ramp drone reveals", url: null, details: { steps: ["only one"] } },
      { ...good, kind: "technique", title: "Speed ramp drone reveals with setpts", url: null, details: { steps: ["Cut at beat", "Apply setpts ramp", "Concat with xfade"], target_skill: "drone-video-editing" } },
    ];
    const { assets, rejected } = validateAssets({ assets: raw }, item, item.text, opts);
    expect(rejected.map((r) => r.reason)).toEqual(["no url", "no url and no steps"]);
    expect(assets).toHaveLength(1);
    expect(assets[0].details?.target_skill).toBe("drone-video-editing");
  });

  it("moves an unknown target_skill aside", () => {
    const raw = [{ ...good, kind: "technique", title: "Brand voice guide in five samples", url: null, details: { steps: ["a step here", "another step"], target_skill: "brand-voice" } }];
    const { assets } = validateAssets(raw, item, item.text, opts);
    expect(assets[0].details?.target_skill).toBeUndefined();
    expect(assets[0].details?.suggested_skill).toBe("brand-voice");
  });

  it("rejects ungrounded URLs for url-required kinds", () => {
    const raw = [{ ...good, kind: "tool", title: "Invented thing CLI", url: "https://github.com/nobody/invented-thing", details: {} }];
    const { rejected } = validateAssets(raw, item, item.text, opts);
    expect(rejected[0].reason).toContain("ungrounded url");
  });

  it("drops opportunities whose deadline passed and normalises dates", () => {
    const opp = { ...good, kind: "opportunity", title: "City of Ottawa website RFP", url: "https://github.com/coreyhaines31/marketingskills" };
    const { assets, rejected } = validateAssets([{ ...opp, deadline: "2026-01-01" }, { ...opp, title: "City of Ottawa website RFP 2", url: "https://remotion.dev/rfp", deadline: "2026-10-15T16:00:00Z" }], item, item.text, opts);
    expect(rejected[0].reason).toBe("deadline passed 2026-01-01");
    expect(assets[0].deadline).toBe("2026-10-15");
  });

  it("dedupes on asset key and caps the count", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...good, kind: "technique", url: null, title: `Technique number ${i} with ffmpeg`, value_score: 40 + i, details: { steps: ["one step", "two step"] } }));
    const { assets, rejected } = validateAssets({ assets: [good, good, ...many] }, item, item.text, opts);
    expect(assets).toHaveLength(MAX_ASSETS);
    expect(assets[0].value_score).toBe(85);
    expect(rejected.filter((r) => r.reason === "duplicate")).toHaveLength(1);
    expect(rejected.filter((r) => r.reason === "over cap")).toHaveLength(5);
  });

  it("tolerates junk replies", () => {
    expect(validateAssets(null, item, item.text, opts).assets).toEqual([]);
    expect(validateAssets({ assets: "nope" }, item, item.text, opts).assets).toEqual([]);
    expect(validateAssets({ assets: [null, 3, "x"] }, item, item.text, opts).assets).toEqual([]);
  });
});

describe("isGenericTitle", () => {
  it("flags advice and vague labels, keeps named things", () => {
    expect(isGenericTitle("Consider your brand voice")).toBe(true);
    expect(isGenericTitle("Key takeaways")).toBe(true);
    expect(isGenericTitle("Tools")).toBe(true);
    expect(isGenericTitle("coreyhaines31/marketingskills")).toBe(false);
    expect(isGenericTitle("ffmpeg speed ramp with setpts")).toBe(false);
  });
});

describe("urlGrounded", () => {
  const text = "install coreyhaines31/marketingskills and try Remotion for video";
  it("accepts the item URL, repo mentions and named domains", () => {
    expect(urlGrounded("https://example.com/a", text, "https://example.com/a/")).toBe(true);
    expect(urlGrounded("https://github.com/coreyhaines31/marketingskills/tree/main", text, null)).toBe(true);
    expect(urlGrounded("https://www.remotion.dev/docs", text, null)).toBe(true);
  });
  it("rejects invented links", () => {
    expect(urlGrounded("https://github.com/acme/unknown", text, null)).toBe(false);
    expect(urlGrounded("https://madeup.io", text, null)).toBe(false);
    expect(urlGrounded("not a url", text, null)).toBe(false);
  });
});

describe("prepareText", () => {
  it("keeps short text whole", () => {
    expect(prepareText("hello   world")).toBe("hello world");
  });
  it("keeps the start, the end and the densest middle chunks", () => {
    const filler = "blah ".repeat(400); // 2000 chars
    const dense = "Run npx skills add foo/bar then ffmpeg setpts, dataset on huggingface.co/datasets/a/b, deadline $5,000 ".repeat(19).slice(0, 2000);
    const text = [filler, filler, filler, dense, filler, filler, filler, "THE END ".repeat(250)].join("");
    const out = prepareText(text, 8000);
    expect(out.length).toBeLessThanOrEqual(8000 + 20);
    expect(out.startsWith("blah")).toBe(true);
    expect(out).toContain("npx skills add foo/bar");
    expect(out).toContain("THE END");
    expect(out).toContain("[…]");
  });
});

describe("extractAssets (mocked model)", () => {
  it("builds a goal-aware prompt and validates the reply", async () => {
    let seen = "";
    const r = await extractAssets(item, {
      skills: SKILLS,
      ask: async (p) => { seen = p; return { assets: [good, { ...good, title: "Reflect on growth" }], note: null }; },
    });
    expect(seen).toContain("## track: marketing");
    expect(seen).toContain("drone-video-editing");
    expect(seen).toContain(item.text);
    expect(r.assets).toHaveLength(1);
    expect(r.rejected).toHaveLength(1);
  });
  it("returns the model's note on empty replies", async () => {
    const r = await extractAssets(item, { skills: SKILLS, ask: async () => ({ assets: [], note: "AI news" }) });
    expect(r.assets).toEqual([]);
    expect(r.note).toBe("AI news");
  });
  it("prompt lists every track id", () => {
    const p = buildPrompt(item, SKILLS, "x");
    for (const t of TRACKS) expect(p).toContain(t);
  });
});

describe("calibration: paid work first", () => {
  const p = buildPrompt(item, SKILLS, "x");
  it("anchors bids and warm leads above skill packs", () => {
    expect(p).toContain("85–90: a winnable open bid, RFP or grant");
    expect(p).toContain("70–80: a dataset or technique that directly powers a paid Cloud Nexus offer");
    expect(p).toContain("$2,260");
    expect(p).toContain("Cap\n     generic packs at 70");
    expect(p).not.toContain("85: installable marketing skill pack");
  });
  it("the gold skill pack sits at the 70 cap and its technique targets a marketing skill, never writing-skills", () => {
    const gold = JSON.parse(goldExample(SKILLS));
    expect(gold.assets[0].value_score).toBe(70);
    expect(gold.assets[1].details.target_skill).toBeNull();
    expect(gold.assets[1].details.suggested_skill).toBe("product-marketing");
    expect(JSON.parse(goldExample([...SKILLS, "marketing"])).assets[1].details.target_skill).toBe("marketing");
    expect(p).not.toContain('"target_skill":"writing-skills"');
  });
  it("tells the model Hugging Face models are tools and prompt books are prompts", () => {
    expect(p).toContain('details.hf_type "model"');
    expect(p).toContain("A prompt book, prompt pack or PDF of\n  prompts is a prompt");
  });
});

describe("skill routing", () => {
  const installed = ["design", "impeccable", "drone-video-editing", "video-editing-craft", "video", "writing-skills", "youtube", "cloudflare-email-service"];
  const tracks = ["client-sites", "marketing", "social", "video", "bids", "data", "ai-services"];

  it("lists installed skills per track and sends marketing to the new-skills list while none is installed", () => {
    const block = routingBlock(installed, tracks);
    expect(block).toContain("- video: drone-video-editing (drone and aerial edits); video-editing-craft");
    expect(block).toContain("- marketing, bids, data, ai-services: no skill yet → target_skill null");
    expect(block).not.toContain("cloudflare-email-service (");
    expect(block).toContain("Never route a technique to these catch-alls unless it is literally about the skill's subject: writing-skills (authoring agent skills)");
    // Once a marketing skill exists, marketing techniques route to it.
    expect(routingBlock([...installed, "marketing"], tracks)).toContain("- marketing: marketing (positioning, offers");
  });

  it("discovers marketing skills installed later, but not developer skills", () => {
    expect(routesFor("marketing", [...installed, "seo-audit", "copywriting"]).map((r) => r.skill)).toEqual(["seo-audit", "copywriting"]);
    expect(routesFor("marketing", [...installed, "marketing", "seo-audit"]).map((r) => r.skill)).toEqual(["marketing", "seo-audit"]);
  });

  it("re-targets by subject within the asset's tracks, else null", () => {
    expect(routeSkill({ track: "video", title: "Speed ramp drone reveals", details: { steps: ["setpts ramp"] } }, installed)).toBe("drone-video-editing");
    expect(routeSkill({ track: "video", title: "ffmpeg speed ramp with setpts", details: {} }, installed)).toBe("video-editing-craft");
    expect(routeSkill({ track: "marketing", title: "Brand-memory layer every marketing skill loads first" }, installed)).toBeNull();
    expect(routeSkill({ track: "marketing", title: "Brand-memory layer every marketing skill loads first" }, [...installed, "marketing"])).toBe("marketing");
    expect(routeSkill({ track: "social", tracks: ["social"], title: "Rank YouTube title variants" }, [...installed, "marketing"])).toBe("marketing");
    // Steps mention incidental words; only the title and summary pick a new home.
    expect(routeSkill({ track: "video", title: "MiniMax H3 full-scene prompting", details: { steps: ["Set transitions", "Use ffmpeg"] } }, installed)).toBeNull();
  });

  it("lets a guarded catch-all skill through only when the asset is on its subject", () => {
    expect(targetSkillFits("writing-skills", { title: "Foundation context skill: one product-marketing file every marketing skill reads first" })).toBe(false);
    expect(targetSkillFits("writing-skills", { title: "Gotchas-not-docs skill authoring with eval pruning" })).toBe(true);
    expect(targetSkillFits("youtube", { title: "Rank YouTube title variants with a vidIQ-calibrated model" })).toBe(false);
    expect(targetSkillFits("image-generation", { title: "MiniMax H3 prompting", summary: "an image-to-video quality bump" })).toBe(false);
    expect(targetSkillFits("image-generation", { title: "Fine-tune a Flux LoRA for a private text-to-image model" })).toBe(true);
    expect(targetSkillFits("drone-video-editing", { title: "anything" })).toBe(true);
  });

  it("validation clears a misrouted target but keeps a fitting one", () => {
    const raw = [
      { ...good, kind: "technique", title: "Brand-memory layer every marketing skill loads first", url: null, details: { steps: ["Create brand files", "Load them first"], target_skill: "writing-skills" } },
      { ...good, kind: "technique", title: "Skill authoring with eval pruning", url: null, details: { steps: ["Write gotchas", "Eval with and without"], target_skill: "writing-skills" } },
    ];
    const { assets } = validateAssets(raw, item, item.text, opts);
    const byTitle = Object.fromEntries(assets.map((a) => [a.title, a.details?.target_skill]));
    expect(byTitle["Brand-memory layer every marketing skill loads first"]).toBeUndefined();
    expect(byTitle["Skill authoring with eval pruning"]).toBe("writing-skills");
  });
});

describe("dataset kind fixes", () => {
  const hfItem: ExtractItem = {
    source_kind: "research", source_ref: "9", url: null, title: "MiniMax H3 roundup",
    text: "Weights at unsloth/MiniMax-H3-GGUF, a demo space acme/h3-demo, data in acme/clips, and the book hrrcne/ai-video-prompt-book-2026.",
  };
  const ds = { ...good, kind: "dataset", track: "data", tracks: ["data"], details: {} };

  it("files Hugging Face models and Spaces as tools and prompt books as prompts", () => {
    const raw = [
      { ...ds, title: "unsloth/MiniMax-H3-GGUF quantized model", url: "https://huggingface.co/unsloth/MiniMax-H3-GGUF" },
      { ...ds, title: "acme/h3-demo Space", url: "https://huggingface.co/spaces/acme/h3-demo" },
      { ...ds, title: "acme/clips — 10k captioned clips", url: "https://huggingface.co/datasets/acme/clips" },
      { ...ds, title: "The AI Video Prompt Book 2026", url: "https://huggingface.co/datasets/hrrcne/ai-video-prompt-book-2026" },
    ];
    const { assets } = validateAssets(raw, hfItem, hfItem.text, opts);
    const by = Object.fromEntries(assets.map((a) => [a.title, a]));
    expect(by["unsloth/MiniMax-H3-GGUF quantized model"]).toMatchObject({ kind: "tool", details: { hf_type: "model", repo_id: "unsloth/MiniMax-H3-GGUF" } });
    expect(by["acme/h3-demo Space"]).toMatchObject({ kind: "tool", details: { hf_type: "space", repo_id: "acme/h3-demo" } });
    expect(by["acme/clips — 10k captioned clips"].kind).toBe("dataset");
    expect(by["The AI Video Prompt Book 2026"].kind).toBe("prompt");
  });

  it("leaves real datasets and non-repo Hugging Face pages alone", () => {
    expect(fixDatasetKind("https://huggingface.co/datasets/a/b", "TikTok comments")).toBeNull();
    expect(fixDatasetKind("https://huggingface.co/docs/hub/models", "Docs")).toBeNull();
    expect(fixDatasetKind("https://www.kaggle.com/datasets/a/b", "Midjourney prompts dataset")).toBeNull();
  });
});

describe("owned assets", () => {
  it("extractAssets marks assets David already has", async () => {
    const r = await extractAssets(item, {
      skills: SKILLS,
      ask: async () => ({ assets: [good, { ...good, title: "Remotion video tool", kind: "tool", url: "https://remotion.dev/docs", details: {} }], note: null }),
      owned: (a) => (a.url?.includes("marketingskills") ? { owned: true, reason: "skills installed from it" } : { owned: false, reason: null }),
    });
    const by = Object.fromEntries(r.assets.map((a) => [a.url, a.details?.owned_reason]));
    expect(by["https://github.com/coreyhaines31/marketingskills"]).toBe("skills installed from it");
    expect(by["https://remotion.dev/docs"]).toBeUndefined();
  });
});
