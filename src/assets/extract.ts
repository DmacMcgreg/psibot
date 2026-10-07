/**
 * Asset extractor: turns one piece of content (a video transcript, tab text,
 * README, research note) into zero or more concrete assets scored against
 * GOALS.md. It does not summarise. Most content yields nothing, and an empty
 * list is the expected answer.
 *
 * One tool-less glm-5.3 call per item (askJson). The reply is validated hard:
 * unknown kinds or tracks, generic titles, ungrounded URLs, items with neither
 * a URL nor steps, and anything scored under MIN_SCORE are dropped. Hugging
 * Face models and prompt books filed as datasets are re-kinded, a target_skill
 * the routing table rules out is cleared, and assets David already has are
 * marked (details.owned_reason) so the runner files them as dismissed.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askJson, modelName } from "./llm.ts";
import { goalsPromptBlock, trackIds } from "./goals.ts";
import { assetKey } from "./store.ts";
import { ASSET_KINDS, type AssetInput, type AssetKind, type AssetDetails, type Effort } from "./types.ts";
import { TRACK_KEYWORDS, ASSET_MARKERS } from "./gate.ts";
import { markOwned, ownedMatch, type OwnedAsset, type OwnedResult } from "./owned.ts";

export const EXTRACT_VERSION = "extract:v1";
export const MIN_SCORE = 35;
export const MAX_ASSETS = 8;
/** Characters of source text sent to the model (~6k tokens). */
export const MAX_TEXT_CHARS = 24_000;

export interface ExtractItem {
  source_kind: string;
  source_ref: string;
  url: string | null;
  title: string;
  text: string;
  published_at?: string | null;
  context?: string;
}

export type ExtractedAsset = AssetInput & { evidence: string | null };

export interface ExtractResult {
  assets: ExtractedAsset[];
  rejected: { title: string; reason: string }[];
  note: string | null;
  model: string;
}

type Ask = (prompt: string) => Promise<unknown>;

// --- skills --------------------------------------------------------------

const SKILL_DIRS = [join(homedir(), ".agents/skills"), join(homedir(), ".claude/skills")];
const SKILL_CACHE_MS = 10 * 60_000;
let skillCache: { at: number; names: string[] } | null = null;

/**
 * Installed skill names (folders with a SKILL.md under ~/.agents/skills and
 * ~/.claude/skills), the valid values for target_skill. Cached for ten
 * minutes, so a skill installed while the daemon runs is picked up.
 */
export function listSkillNames(dirs: string | string[] = SKILL_DIRS): string[] {
  if (skillCache && Date.now() - skillCache.at < SKILL_CACHE_MS) return skillCache.names;
  const names = new Set<string>();
  for (const dir of [dirs].flat()) {
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.name.startsWith(".") || !(d.isDirectory() || d.isSymbolicLink())) continue;
        if (existsSync(join(dir, d.name, "SKILL.md"))) names.add(d.name);
      }
    } catch { /* missing dir */ }
  }
  skillCache = { at: Date.now(), names: [...names].sort() };
  return skillCache.names;
}

// --- skill routing ---------------------------------------------------------

export interface SkillRoute {
  skill: string;
  /** What the skill covers, shown to the model. */
  about: string;
  /** Asset text that belongs in this skill (used when re-targeting old assets). */
  when: RegExp;
}

/**
 * Where a technique or prompt on each track goes: installed skills that cover
 * the track, best first. Only installed ones reach the prompt, so a track with
 * none (bids and data today) sends its techniques to the new-skills list.
 * `discover` picks up skills installed later by name (a pack's "copywriting",
 * "seo-audit" and so on).
 */
export const SKILL_ROUTES: Record<string, { skills: SkillRoute[]; discover?: RegExp }> = {
  "client-sites": {
    skills: [
      { skill: "design", about: "design tokens, colour, type, spacing, brand kits", when: /design.?tokens?|brand.?(tokens?|kit|colou?rs?)|palette|typograph|oklch|colou?r (system|roles)|spacing|radius/i },
      { skill: "design-taste-frontend", about: "landing pages, heroes and redesigns that don't look templated", when: /landing.?page|\bhero\b|redesign|aesthetic|portfolio|theme block/i },
      { skill: "marketing", about: "website copy, landing-page CRO, local SEO and GEO, WCAG audit offers", when: /copy|\bcro\b|conversion|local seo|google business|schema markup|wcag|accessib|\bgeo\b|ai search/i },
      { skill: "impeccable", about: "UI critique, polish and design audits", when: /critique|polish|design audit|visual hierarchy/i },
      { skill: "flow", about: "screens and user flows", when: /user flows?|onboarding|paywall|checkout|sign.?up flow/i },
      { skill: "ui-patterns", about: "choosing UI elements: sheets, tab bars, cards, toasts", when: /bottom sheet|tab bar|toast|modal|ui pattern/i },
      { skill: "web-perf", about: "Core Web Vitals and page speed", when: /core web vitals|\blcp\b|\binp\b|\bcls\b|page ?speed|lighthouse/i },
    ],
    discover: /(^|-)(website|landing|a11y|accessibility|wcag|cms|webflow|framer|astro)(-|$)/,
  },
  marketing: {
    skills: [
      { skill: "marketing", about: "positioning, offers, website copy, CRO, SEO and GEO, ads, email, brand kits, competitor research", when: /[\s\S]/ },
    ],
    discover: /(^|-)(marketing|copywriting|copy|seo|geo|aeo|cro|ads|ad|email|brand|positioning|funnel|launch|pricing|growth|leads?)(-|$)/,
  },
  social: {
    skills: [
      { skill: "marketing", about: "TikTok, Reels and Shorts hooks, scripts, titles and content calendars", when: /hooks?\b|scripts?\b|titles?\b|thumbnails?|content calendar|tiktok|\breels\b|\bshorts\b/i },
      { skill: "video-editing-craft", about: "cutting short-form clips, captions and pacing", when: /captions?|subtitles?|clips?\b|jump.?cuts?|repurpos/i },
      { skill: "video", about: "producing promos, explainers and faceless videos", when: /promo|explainer|faceless|motion graphic|voice.?over|\btts\b/i },
    ],
    discover: /(^|-)(social|tiktok|reels|shorts|instagram|linkedin|postiz|buffer|hooks?)(-|$)/,
  },
  video: {
    skills: [
      { skill: "drone-video-editing", about: "drone and aerial edits", when: /drone|aerial|\bdji\b|\bfpv\b/i },
      { skill: "video-editing-craft", about: "cutting, speed ramps, colour, ffmpeg filtergraphs", when: /speed ramp|colou?r grad|\bluts?\b|d-log|cut rhythm|transitions?\b|ffmpeg|stabili[sz]|davinci|\bresolve\b|beat.?sync/i },
      { skill: "video", about: "promos, explainers, motion graphics, captions and voiceover", when: /promo|explainer|motion graphic|kinetic|product demo|remotion|voice.?over|\btts\b|captions?|subtitles?/i },
      { skill: "hyperframes", about: "HyperFrames compositions", when: /hyperframes/i },
      { skill: "media-use", about: "finding BGM, SFX, stock media and LUTs", when: /\bbgm\b|\bsfx\b|sound effects?|stock (footage|music)|royalty.?free/i },
    ],
  },
  bids: { skills: [], discover: /(^|-)(bids?|tenders?|rfps?|grants?|proposals?|procurement)(-|$)/ },
  data: { skills: [] },
  "ai-services": { skills: [], discover: /(^|-)(n8n|zapier|smb|productized)(-|$)/ },
};

/** Developer skills a discover pattern must never pick up (cloudflare-email-service is not an email-marketing skill). */
const DEV_SKILL = /(^|-)(cloudflare|workers?|wrangler|sandbox|service|sdk|api|cli|mcp|typescript|react|swift|convex|effect|nextjs|git|docker|browser)(-|$)/;

/** The routing table's installed skills for one track, including discovered ones. */
export function routesFor(track: string, skills: string[]): SkillRoute[] {
  const spec = SKILL_ROUTES[track];
  if (!spec) return [];
  const have = new Set(skills);
  const out = spec.skills.filter((r) => have.has(r.skill));
  if (spec.discover) {
    for (const s of skills) {
      if (!spec.discover.test(s) || DEV_SKILL.test(s) || out.some((r) => r.skill === s)) continue;
      const words = s.split("-").filter((w) => w.length > 2).map((w) => w.replace(/[^\w]/g, ""));
      out.push({ skill: s, about: s.replace(/-/g, " "), when: new RegExp(`\\b(${words.join("|") || s})`, "i") });
    }
  }
  return out;
}

const SKILL_AUTHORING = /agent skills?|skill\.md|skill[- ]authoring|skill[- ](fleet|routing|evals?)|claude\.md|agents\.md|authoring (a |the )?skills?/i;

/**
 * Skills the extractor misused as catch-alls, with the subject each is really
 * about. A technique may target one only when its own text is on that subject:
 * a brand-file pattern for marketing skills is not about authoring skills, and
 * a YouTube-title method is not about summarising videos.
 */
export const GUARDED_SKILLS: Record<string, { about: string; re: RegExp }> = {
  "writing-skills": { about: "authoring agent skills", re: SKILL_AUTHORING },
  "writing-great-skills": { about: "authoring agent skills", re: SKILL_AUTHORING },
  youtube: { about: "summarising YouTube videos", re: /summari[sz]|transcripts?\b|youtube (notes|library|search)/i },
  "voiceink-rebuild": { about: "rebuilding VoiceInk", re: /voiceink/i },
  implement: { about: "the implement workflow", re: /\bimplement(s|ing|ation)?\b/i },
  "image-generation": {
    about: "generating images",
    re: /text-to-image|image (generation|generator|model|prompts?|editing)|generat\w* (an |the )?images?|gpt-image|imagen|nano.?banana|midjourney|stable diffusion|sdxl|\bflux\b/i,
  },
};

type SkillTarget = { title: string; summary?: string | null; url?: string | null; details?: AssetDetails | null };

function targetText(a: SkillTarget): string {
  const steps = Array.isArray(a.details?.steps) ? a.details.steps.join("\n") : "";
  return `${a.title}\n${a.summary ?? ""}\n${a.url ?? ""}\n${steps}`;
}

/** False when target_skill is a guarded catch-all and the asset is not about that skill's subject. */
export function targetSkillFits(skill: string, a: SkillTarget): boolean {
  const guard = GUARDED_SKILLS[skill];
  return !guard || guard.re.test(targetText(a));
}

/**
 * Best installed skill for a technique or prompt, by the routing table of its
 * tracks, or null when none fits (it then goes to the new-skills list).
 */
export function routeSkill(a: SkillTarget & { track: string; tracks?: string[] }, skills: string[]): string | null {
  // Title and summary only: steps mention incidental tools and words.
  const text = `${a.title}\n${a.summary ?? ""}`;
  for (const t of [...new Set([a.track, ...(a.tracks ?? [])])]) {
    for (const r of routesFor(t, skills)) if (r.when.test(text)) return r.skill;
  }
  return null;
}

/** The routing table as a prompt block, for the installed skills. */
export function routingBlock(skills: string[], tracks: string[]): string {
  const lines: string[] = [];
  const empty: string[] = [];
  for (const t of tracks) {
    const rs = routesFor(t, skills);
    if (rs.length) lines.push(`- ${t}: ${rs.map((r) => `${r.skill} (${r.about})`).join("; ")}`);
    else empty.push(t);
  }
  if (empty.length) {
    lines.push(`- ${empty.join(", ")}: no skill yet → target_skill null and a short new-skill name in suggested_skill (e.g. "tender-writing").`);
  }
  const guarded = Object.entries(GUARDED_SKILLS).map(([k, g]) => `${k} (${g.about})`).join(", ");
  return `## Where techniques and prompts go (target_skill)
Pick details.target_skill from the skills listed for the asset's track. Use another skill from <skills>
only when the technique is squarely about that skill's subject; otherwise set target_skill null and name
the skill it should seed in details.suggested_skill (it goes to David's new-skills list).
${lines.join("\n")}
Never route a technique to these catch-alls unless it is literally about the skill's subject: ${guarded}.
A brand-voice file for marketing skills is not about authoring skills; a YouTube-title method is not about
summarising videos.`;
}

// --- text preparation ----------------------------------------------------

const CHUNK = 2000;
const CONCRETE = [
  /https?:\/\/\S+/i, /\b(step|first|second|third|then|next|finally)\b/i, /\$\s?\d/, /\b\d+(\.\d+)?\s?(%|gb|mb|k\b|fps|ms)\b/i,
  /\b(install|download|license|dataset|repo|template|prompt|command|setting|filter|deadline|apply)\b/i,
];

/** How many useful signals a chunk carries: track vocabulary, asset markers, concrete detail. */
export function chunkSignal(chunk: string): number {
  let n = 0;
  for (const res of Object.values(TRACK_KEYWORDS)) n += res.filter((re) => re.test(chunk)).length;
  n += 2 * ASSET_MARKERS.filter((re) => re.test(chunk)).length;
  n += CONCRETE.filter((re) => re.test(chunk)).length;
  return n;
}

/**
 * Fit long text into `max` characters without losing the parts that carry
 * assets: always keep the opening (what it is) and the ending (links, calls
 * to action), then fill with the middle chunks that score highest on
 * chunkSignal, in their original order.
 */
export function prepareText(text: string, max = MAX_TEXT_CHARS): string {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= max) return clean;
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += CHUNK) chunks.push(clean.slice(i, i + CHUNK));
  const budget = Math.floor(max / CHUNK);
  const keep = new Set<number>([0, 1, chunks.length - 1].filter((i) => i >= 0 && i < chunks.length));
  const middle = chunks
    .map((c, i) => ({ i, s: chunkSignal(c) }))
    .filter(({ i }) => !keep.has(i))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  for (const { i } of middle) {
    if (keep.size >= budget) break;
    keep.add(i);
  }
  const ordered = [...keep].sort((a, b) => a - b);
  let out = "";
  let prev = -1;
  for (const i of ordered) {
    if (prev >= 0 && i !== prev + 1) out += "\n[…]\n";
    out += chunks[i];
    prev = i;
  }
  return out;
}

// --- prompt --------------------------------------------------------------

/**
 * The worked example. The skill pack sits at the 70 cap for generic packs.
 * The technique targets the installed marketing skill; without one it names
 * the skill it should seed instead.
 */
export function goldExample(skills: string[]): string {
  const marketingTarget = ["marketing", "product-marketing"].find((s) => skills.includes(s)) ?? null;
  return JSON.stringify({
    assets: [
      {
        kind: "skill",
        title: "coreyhaines31/marketingskills — 48 marketing skills for Claude Code (CRO, copywriting, AI-SEO, ads)",
        url: "https://github.com/coreyhaines31/marketingskills",
        summary: "MIT-licensed pack of ~48 Agent Skills for CRO, copywriting, SEO/AEO, ads, email and pricing, built around a product-marketing foundation skill every other skill reads first.",
        track: "marketing",
        tracks: ["marketing", "client-sites", "ai-services"],
        value_score: 70,
        value_reason: "Installable today and covers the copy, CRO and SEO work inside every $2,260 website package, but it is a generic pack, not paid work, so it stays at the 70 cap.",
        next_action: "Run `npx skills add coreyhaines31/marketingskills -a claude-code --skill cro copywriting ai-seo marketing-loops`, then run cro on the Cloud Nexus homepage.",
        effort: "S",
        evidence: "npx skills add coreyhaines31/marketingskills -a claude-code",
        deadline: null,
        amount: null,
        details: {
          repo: "coreyhaines31/marketingskills",
          install: "npx skills add coreyhaines31/marketingskills -a claude-code --skill cro copywriting ai-seo marketing-loops",
          license: "MIT",
        },
      },
      {
        kind: "technique",
        title: "Foundation context skill: one product-marketing file every marketing skill reads first",
        url: "https://github.com/coreyhaines31/marketingskills",
        summary: "Keep product, audience, positioning and voice in one per-project file that every marketing skill loads before it writes anything.",
        track: "marketing",
        tracks: ["marketing", "ai-services"],
        value_score: 62,
        value_reason: "Makes every client's copy, CRO and SEO output share one positioning source; reusable across all Cloud Nexus clients.",
        next_action: marketingTarget
          ? `Add a per-client product-marketing.md template to the ${marketingTarget} skill and make each marketing step read it first.`
          : "Start a product-marketing skill: a per-client product-marketing.md template that every marketing step reads first.",
        effort: "M",
        evidence: "a per-project context file lives at .agents/product-marketing.md",
        deadline: null,
        amount: null,
        details: {
          steps: [
            "Create .agents/product-marketing.md per client: product, audience, positioning, proof, voice.",
            "Make the first step of every marketing skill read that file.",
            "Cross-reference related skills (copywriting → cro → ab-testing) so outputs chain.",
          ],
          ...(marketingTarget ? { target_skill: marketingTarget } : { target_skill: null, suggested_skill: "product-marketing" }),
        },
      },
    ],
    note: null,
  });
}

export function buildPrompt(item: ExtractItem, skills: string[], text: string): string {
  return `You extract ASSETS for David McGregor from one piece of content. An asset is a concrete, named
thing he can USE THIS WEEK toward the goals below: a dataset to download, a tool or skill pack to
install, a technique to add to one of his skills, a design to reproduce, a prompt to reuse, or a
tender/grant to bid on. You are NOT summarising. Most content contains no asset; then reply
{"assets": [], "note": "<why, in under 12 words>"}. That is the expected, common answer.

${goalsPromptBlock()}

## Asset kinds and required fields
- dataset: a specific downloadable dataset (rows, files, media). url = its page (REQUIRED). details: host
  ("huggingface" | "kaggle" | "github" | …), repo_id ("owner/name"), license, size, contents.
  A Hugging Face MODEL (huggingface.co/<org>/<name>, no /datasets/ in the URL) is not a dataset: emit it
  as a tool with details.hf_type "model" and details.repo_id. A prompt book, prompt pack or PDF of
  prompts is a prompt, not a dataset.
- tool: a specific repo, app, CLI, API, service or model. url REQUIRED. details: repo ("owner/name" when
  on GitHub), install (the exact command, copied from the content), pricing.
- skill: an installable agent-skill package (Claude Code / Agent Skills / MCP pack). url REQUIRED.
  details.install = the exact install command, e.g. "npx skills add owner/repo".
- technique: a concrete method. details.steps REQUIRED: 3–8 specific steps with tool names, settings
  and numbers. details.target_skill = the ONE skill from <skills> it should be added to (see "Where
  techniques and prompts go" below), or null.
  details.timestamp if the content gives one.
- design_ref: a specific site, template, block or screen worth reproducing for client sites. url REQUIRED.
- prompt: a reusable prompt, quoted in details.steps (one string per part). target_skill as above.
- opportunity: an open tender, RFP, grant, funding program or named lead. url REQUIRED. deadline
  (YYYY-MM-DD), amount, details.org, details.opportunity_type (tender|rfp|grant|program|lead),
  details.eligibility, details.reference, details.region when stated.

## Rules
1. Every asset has a URL (for tools, skills, datasets, designs, opportunities: the page the content
   links, or the obvious official page of a product or owner/repo the content names) or, for
   technique and prompt, specific steps. No URL and no steps → don't emit it.
2. Never emit: generic advice ("Consider…", "Reflect on…", "Focus on quality", "Use AI to…"),
   opinions, commentary, news, announcements, benchmarks, product launches with nothing to install,
   or a summary of the content itself. A video ABOUT a topic is not an asset; a named tool, dataset
   or step-by-step method shown IN it can be.
3. The title names the thing, e.g. "coreyhaines31/marketingskills — 48 marketing skills for Claude
   Code" or "ffmpeg speed ramp with setpts + minterpolate at 60 fps". Never "Useful tool",
   "Marketing tips", "Key takeaway".
4. Don't invent facts. URLs, install commands, licences, sizes, deadlines and amounts come from the
   content; leave a field out when it isn't stated.
5. Emit at most ${MAX_ASSETS}, usually 0–3. Merge duplicates. Prefer the one best asset over several weak ones.
6. value_score 0–100 = how much it moves David toward paid work THIS WEEK, given the track weights. Paid
   work outranks tooling: a bid he can win beats any skill pack. Calibration:
   - 85–90: a winnable open bid, RFP or grant a 1–3 person shop qualifies for, or a warm lead with a named
     contact and a deadline (e.g. a small-agency website or AI-training RFP closing in 3 weeks, $40K, no clearance).
   - 70–80: a dataset or technique that directly powers a paid Cloud Nexus offer: the $2,260 small-business
     website package, WCAG accessibility audits, or AI automation at $85/hr (e.g. a measured accessibility
     audit method that produces a client report; a local-SEO page method with exact steps).
   - 70: MIT-licensed shadcn landing-page block library he can drop into client sites.
   - 65–70: an installable skill or tool pack with exact install commands (the gold example below). Cap
     generic packs at 70; go higher only when the pack itself delivers one of the paid offers above.
   - 65: ffmpeg or Resolve method with exact settings for drone speed ramps or D-Log M grading.
   - 55: an agent framework or MCP server he could turn into a client deliverable, with install steps.
   - 40: a tool that clearly fits a track but has no obvious use this week.
   - 25: David's own dev workflow — coding agents, agent orchestrators and harnesses, terminal, CI and
     editor utilities, output-style tweaks, ideas for PsiBot's internals — unless it directly produces
     a client deliverable or a marketing, video, social, data or bid capability.
   - 0: AI news, model benchmarks, politics, commentary, motivation, a tool that fits no track, and new
     general-purpose models, weights or inference APIs (he already has Claude and GLM; only a small model
     tuned for marketing, captioning or video work counts, under the data track).
   Anything you would score under ${MIN_SCORE}: don't emit it.
7. track = exactly one id from the goals (${trackIds().join(", ")}); tracks = every id that applies.
8. next_action = one imperative sentence naming the thing and the first concrete move.
9. effort: S (under an hour), M (half a day), L (days).
10. evidence = a short verbatim quote (≤ 25 words) from the content that supports the asset.
11. summary = one or two sentences on what the asset IS. value_reason = one sentence on why that score.

${routingBlock(skills, trackIds())}

## Gold example (from a research note on github.com/coreyhaines31/marketingskills)
${goldExample(skills)}

## Empty examples
- Video "The AI Race Just Changed Forever" (three frontier models launched; commentary) → {"assets": [], "note": "AI news commentary, nothing to use"}
- GitHub star "thaw-app/Thaw: open source menu bar manager" → {"assets": [], "note": "macOS utility, fits no track"}
- Tab "Ontario Fall Colour Tracker 2026" → {"assets": [], "note": "useful timing info, not an asset"}

<skills>
${skills.join(", ")}
</skills>

<content source="${item.source_kind}" url="${item.url ?? ""}" published="${item.published_at ?? ""}">
TITLE: ${item.title}
${item.context ? `CONTEXT: ${item.context}\n` : ""}
${text}
</content>

Reply with ONLY JSON: {"assets": [ {kind, title, url, summary, track, tracks, value_score, value_reason,
next_action, effort, evidence, deadline, amount, details} ], "note": string | null}`;
}

// --- validation ----------------------------------------------------------

const URL_REQUIRED: AssetKind[] = ["dataset", "tool", "skill", "design_ref", "opportunity"];
const PROMPT_BOOK = /\bprompts? ?(book|pack|guide|cheat ?sheet|pdf|e-?book)s?\b/i;
const HF_NON_REPO = /^(docs|blog|papers|collections|models|datasets|spaces|organizations|learn|tasks|pricing|settings|join|login)$/i;

/**
 * A "dataset" that is really a Hugging Face model or Space (→ tool, with
 * details.hf_type and repo_id) or a prompt book (→ prompt). Null when it is a
 * real dataset. Download only works on real datasets.
 */
export function fixDatasetKind(url: string | null, title: string): { kind: AssetKind; details: AssetDetails } | null {
  const m = url?.match(/^https?:\/\/(?:www\.)?huggingface\.co\/(spaces\/)?([\w.-]+)\/([\w.-]+)/i);
  if (m && !HF_NON_REPO.test(m[2])) return { kind: "tool", details: { hf_type: m[1] ? "space" : "model", repo_id: `${m[2]}/${m[3]}` } };
  if (PROMPT_BOOK.test(title)) return { kind: "prompt", details: {} };
  return null;
}
const GENERIC_START = /^(consider|reflect|focus on|leverage|stay|keep|think|remember|try to|explore|learn|understand|embrace|use ai|be\b|don'?t|always|never|make sure|avoid|why|the importance|the power of)/i;
const GENERIC_TITLE = /^(useful|key|important|general|various|some|other|misc|new)?\s*(tools?|tips?|takeaways?|insights?|advice|resources?|ideas?|techniques?|strategies|lessons?|notes?|summary|overview|best practices)( for .*)?$/i;

export function isGenericTitle(title: string): boolean {
  const t = title.trim();
  if (t.length < 6 || (t.split(/\s+/).length < 2 && !/[/.]/.test(t))) return true;
  return GENERIC_START.test(t) || GENERIC_TITLE.test(t);
}

/**
 * A URL is grounded when it appears in the content, is the item's own URL, or
 * its distinctive name (GitHub owner/repo, HF repo id, or the domain label such
 * as "remotion" in remotion.dev) is mentioned in the content. Stops the model
 * inventing links for things the source never names.
 */
export function urlGrounded(url: string, text: string, itemUrl: string | null): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  const hay = text.toLowerCase();
  const bare = (url.replace(/^https?:\/\/(www\.)?/i, "").replace(/[/#?]+$/, "")).toLowerCase();
  if (itemUrl && sameish(url, itemUrl)) return true;
  if (hay.includes(bare)) return true;
  const path = u.pathname.split("/").filter(Boolean);
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  if ((host === "github.com" || host === "huggingface.co") && path.length >= 2) {
    const [a, b] = path[0] === "datasets" || path[0] === "spaces" ? path.slice(1, 3) : path.slice(0, 2);
    if (b && (hay.includes(`${a}/${b}`.toLowerCase()) || hay.includes(b.toLowerCase()))) return true;
    return false;
  }
  const label = host.split(".").slice(-2, -1)[0] ?? "";
  if (label.length >= 4 && hay.includes(label)) return true;
  const spaced = label.replace(/-/g, " ");
  return spaced !== label && hay.includes(spaced);
}

function sameish(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/^https?:\/\/(www\.)?/i, "").replace(/[/#?]+$/, "").toLowerCase();
  return n(a) === n(b) || n(a).startsWith(n(b)) || n(b).startsWith(n(a));
}

const str = (v: unknown, max = 600): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate the model's raw reply into clean assets plus the reasons others were dropped. */
export function validateAssets(
  raw: unknown,
  item: ExtractItem,
  text: string,
  opts: { skills: string[]; tracks: string[]; model: string; today?: string },
): { assets: ExtractedAsset[]; rejected: { title: string; reason: string }[] } {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { assets?: unknown })?.assets) ? (raw as { assets: unknown[] }).assets : [];
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const assets: ExtractedAsset[] = [];
  const rejected: { title: string; reason: string }[] = [];
  const seen = new Set<string>();
  const groundText = `${item.title}\n${item.context ?? ""}\n${text}`;

  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const title = str(r.title, 200);
    const reject = (reason: string) => { rejected.push({ title: title || "(untitled)", reason }); };
    let kind = str(r.kind) as AssetKind;
    if (!ASSET_KINDS.includes(kind)) { reject(`unknown kind ${kind}`); continue; }
    if (!title || isGenericTitle(title)) { reject("generic title"); continue; }

    let track = str(r.track);
    const tracks = (Array.isArray(r.tracks) ? r.tracks : []).map((t) => str(t)).filter((t) => opts.tracks.includes(t));
    if (!opts.tracks.includes(track)) {
      if (tracks.length) track = tracks[0];
      else { reject(`unknown track ${track}`); continue; }
    }

    const score = Math.round(Number(r.value_score));
    if (!Number.isFinite(score) || score < MIN_SCORE) { reject(`score ${r.value_score}`); continue; }

    const rd = (r.details && typeof r.details === "object" ? r.details : {}) as Record<string, unknown>;
    const details: AssetDetails = {};
    for (const [k, v] of Object.entries(rd)) {
      if (v == null || v === "") continue;
      if (k === "steps" || k === "categories") {
        const arr = (Array.isArray(v) ? v : [v]).map((s) => str(s, 1200)).filter((s) => s.length > 3);
        if (arr.length) details[k] = arr.slice(0, 12);
      } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        details[k] = typeof v === "string" ? v.trim().slice(0, 600) : v;
      }
    }
    if (details.target_skill && !opts.skills.includes(String(details.target_skill))) {
      details.suggested_skill = details.target_skill;
      delete details.target_skill;
    }
    // A catch-all skill the technique isn't about (writing-skills for a marketing pattern): new-skills list instead.
    if (details.target_skill && !targetSkillFits(String(details.target_skill), { title, summary: str(r.summary, 600), url: str(r.url, 1000), details })) {
      delete details.target_skill;
    }

    let url: string | null = str(r.url, 1000) || null;
    if (url && !/^https?:\/\//i.test(url)) url = null;
    if (url && !urlGrounded(url, groundText, item.url)) {
      if (URL_REQUIRED.includes(kind)) { reject(`ungrounded url ${url}`); continue; }
      url = null;
    }
    if (kind === "dataset") {
      const fixed = fixDatasetKind(url, title);
      if (fixed) {
        kind = fixed.kind;
        Object.assign(details, fixed.details);
        // A Hugging Face id copied into `repo` would read as a GitHub repo.
        if (typeof details.repo === "string" && details.repo.toLowerCase() === String(details.repo_id ?? "").toLowerCase()) delete details.repo;
      }
    }
    const steps = (details.steps as string[] | undefined) ?? [];
    if (URL_REQUIRED.includes(kind) && !url) { reject("no url"); continue; }
    if ((kind === "technique" || kind === "prompt") && steps.length < 2 && !url) { reject("no url and no steps"); continue; }
    if (kind === "technique" && steps.length < 2) { reject("technique without steps"); continue; }

    const next_action = str(r.next_action, 400);
    if (!next_action || /^(consider|reflect|think about)/i.test(next_action)) { reject("no usable next_action"); continue; }

    let deadline: string | null = str(r.deadline, 40) || null;
    if (deadline && !/^\d{4}-\d{2}-\d{2}/.test(deadline)) deadline = null;
    if (deadline) deadline = deadline.slice(0, 10);
    if (kind === "opportunity" && deadline && deadline < today) { reject(`deadline passed ${deadline}`); continue; }

    const effort = (["S", "M", "L"].includes(str(r.effort)) ? str(r.effort) : null) as Effort | null;
    const summary = str(r.summary, 600) || str(r.value_reason, 600);
    const asset: ExtractedAsset = {
      kind, title, url, summary,
      track, tracks: [...new Set([track, ...tracks])],
      value_score: Math.min(100, score),
      value_reason: str(r.value_reason, 400) || summary,
      next_action, effort, details,
      deadline, amount: str(r.amount, 120) || null,
      published_at: item.published_at ?? null,
      extractor: `${EXTRACT_VERSION}:${opts.model}`,
      evidence: str(r.evidence, 300) || null,
    };
    const key = assetKey(asset);
    if (seen.has(key)) { reject("duplicate"); continue; }
    seen.add(key);
    assets.push(asset);
  }
  assets.sort((a, b) => b.value_score - a.value_score);
  for (const extra of assets.splice(MAX_ASSETS)) rejected.push({ title: extra.title, reason: "over cap" });
  return { assets, rejected };
}

// --- entry point ---------------------------------------------------------

/**
 * Extract validated assets from one item. Assets David already has come back
 * with details.owned_reason set (see owned.ts); the runner files them as
 * dismissed. Throws on model/parse failure.
 */
export async function extractAssets(
  item: ExtractItem,
  opts: { ask?: Ask; skills?: string[]; owned?: (a: OwnedAsset) => OwnedResult } = {},
): Promise<ExtractResult> {
  const text = prepareText(item.text);
  const skills = opts.skills ?? listSkillNames();
  const prompt = buildPrompt(item, skills, text);
  const ask: Ask = opts.ask ?? ((p) => askJson<unknown>(p, { timeoutMs: 240_000 }));
  const model = opts.ask ? "mock" : modelName("opus", "glm");
  const raw = await ask(prompt);
  const { assets, rejected } = validateAssets(raw, item, text, { skills, tracks: trackIds(), model });
  const owned = opts.owned ?? ((a: OwnedAsset) => ownedMatch(a));
  const note = typeof (raw as { note?: unknown })?.note === "string" ? ((raw as { note: string }).note) : null;
  return { assets: assets.map((a) => markOwned(a, owned)), rejected, note, model };
}
