/**
 * Goal gate: a cheap relevance check that runs before any model call.
 *
 * The gate embeds an item's title plus its first ~2k characters (Gemini, the
 * same embedder the rest of PsiBot uses) and compares it with cached
 * embeddings of each GOALS.md track: the whole track (description + wins) and
 * each individual "wins" clause. A keyword boost rewards track vocabulary and
 * asset markers (install commands, dataset links, RFP language); a penalty
 * applies when the item sits closer to the "not" lists and generic noise
 * (politics, drama, AI news) than to any track.
 *
 * Items David chose himself (Watch Later, Telegram sends, GitHub stars, the
 * Research button) pass unless they score clearly off-goal.
 *
 * Thresholds were calibrated on 120 days of real tabs and videos; see
 * vivaldi-home/research/revamp-extractor.md.
 */

import { createHash } from "node:crypto";
import { embedBatch } from "../shared/embeddings.ts";
import { getOpsState, setOpsState } from "../db/queries.ts";
import { loadGoals, type Track } from "./goals.ts";

/** Tunables. Scores are 0–100. */
export const GATE = {
  /** Cosine at or below SIM_LO maps to 0, at SIM_HI maps to 100. */
  SIM_LO: 0.5,
  SIM_HI: 0.75,
  /** Weight of the whole-track anchor vs the best single wins-clause anchor. */
  TRACK_W: 0.5,
  /** Points per distinct track keyword hit, and the cap. */
  KW_POINTS: 6,
  KW_CAP: 18,
  /** Points for asset markers (install commands, dataset/repo links, RFP words). */
  MARKER_POINTS: 4,
  MARKER_CAP: 8,
  /** Points lost per 0.01 of cosine that the best noise anchor comes within NEG_MARGIN of (or beats) the best track. */
  NEG_PER_CENT: 3,
  NEG_MARGIN: 0.02,
  /** Pass line for items a feed or discovery found. */
  PASS: 45,
  /** Items David chose pass unless they fall below this. */
  EXPLICIT_FLOOR: 20,
  /** Characters of body text embedded after the title. */
  TEXT_CHARS: 2000,
};

export interface GateInput {
  title: string;
  text: string;
  explicit?: boolean;
}

export interface GateDecision {
  score: number;        // 0–100
  track: string | null; // best-matching track id
  pass: boolean;
  sim: number;          // best combined cosine
  neg: number;          // best noise cosine
  kw: number;           // keyword + marker points
}

// --- anchors -------------------------------------------------------------

/** Generic noise the research system must ignore, beyond each track's "not" list. */
export const NOISE_ANCHORS = [
  "political news, elections, government scandals and war coverage",
  "celebrity gossip, influencer drama and entertainment news",
  "AI industry news, model launch announcements and benchmark comparisons",
  "hands-on test of a newly released AI model: is it better than GPT, Claude or Gemini",
  "which computer or GPU to buy for running local AI models",
  "tech company strategy, acquisitions, funding rounds and CEO interviews",
  "developer tools for running, sandboxing and orchestrating several coding agents, terminals and IDEs",
  "sports highlights and match commentary",
  "movies, TV shows and pop culture recaps",
  "spirituality, religion, philosophy and personal growth talks",
  "stock trading strategies, crypto speculation and market commentary",
  "science news and documentaries about space, animals and history",
  "motivational self-help and productivity advice without concrete tools",
];

export interface Anchor {
  track: string | null; // null = noise anchor
  kind: "track" | "clause" | "noise";
  text: string;
}

export function buildAnchors(tracks: Track[]): Anchor[] {
  const out: Anchor[] = [];
  for (const t of tracks) {
    out.push({ track: t.id, kind: "track", text: `${t.description} Wins: ${t.wins}` });
    for (const clause of splitClauses(t.wins)) {
      out.push({ track: t.id, kind: "clause", text: `${t.description} Specifically: ${clause}` });
    }
    for (const clause of splitClauses(t.not)) out.push({ track: null, kind: "noise", text: clause });
  }
  for (const n of NOISE_ANCHORS) out.push({ track: null, kind: "noise", text: n });
  return out;
}

function splitClauses(s: string): string[] {
  return s.split(/;\s*/).map((c) => c.replace(/\.$/, "").trim()).filter((c) => c.length > 3);
}

// --- keywords ------------------------------------------------------------

/** Track vocabulary. Each distinct match adds KW_POINTS to that track. */
export const TRACK_KEYWORDS: Record<string, RegExp[]> = {
  "client-sites": [
    /\blanding[- ]page/i, /\bshadcn\b/i, /\btailwind\b/i, /\bweb ?site (builder|template|generator)/i, /\bastro\b/i,
    /\bwebflow\b/i, /\bframer\b/i, /\bcms\b/i, /\blocal seo\b/i, /\bwcag\b/i, /\baccessibility\b/i,
    /\bcomponent librar/i, /\bui blocks?\b/i, /\bsmall[- ]business (website|client)/i, /\bconversion rate\b/i, /\bhero section\b/i,
  ],
  marketing: [
    /\bcopywriting\b/i, /\bcro\b/, /\bseo\b/i, /\bgeo\b/, /\bgenerative engine optimi[sz]ation/i, /\baeo\b/i,
    /\bemail marketing\b/i, /\bcold email\b/i, /\bad (creative|copy|library)/i, /\bfacebook ads\b/i, /\bgoogle ads\b/i,
    /\bpositioning\b/i, /\bbrand (voice|kit|identity|guidelines)/i, /\blead gen(eration)?\b/i, /\bfunnel\b/i, /\bmarketing skills?\b/i,
  ],
  social: [
    /\btiktok\b/i, /\breels\b/i, /\byoutube shorts\b/i, /\bshort[- ]form\b/i, /\bfaceless\b/i, /\bhooks?\b.*\b(video|content)/i,
    /\bpostiz\b/i, /\bbuffer\b/i, /\bscheduling posts?\b/i, /\bcaptions?\b/i, /\bsubtitles?\b/i, /\blinkedin posts?\b/i,
  ],
  video: [
    /\bffmpeg\b/i, /\bdavinci\b/i, /\bresolve\b/i, /\bcolou?r grad/i, /\blut\b/i, /\bd-log\b/i, /\bdrone\b/i, /\bdji\b/i,
    /\bspeed ramp/i, /\bstabili[sz]/i, /\bframe interpolation\b/i, /\bvideo edit/i, /\bremotion\b/i, /\bhyperframes\b/i,
    /\bfpv\b/i, /\baerial\b/i, /\b(veo|kling|runway|sora|seedance)\b/i,
  ],
  bids: [
    /\brfp\b/i, /\brfq\b/i, /\btender\b/i, /\bsolicitation\b/i, /\bcanadabuys\b/i, /\bprocurement\b/i, /\bgrant\b/i,
    /\birap\b/i, /\bcanexport\b/i, /\bfunding program/i, /\bstanding offer\b/i, /\bbid\b/i, /\bdeadline\b/i,
  ],
  data: [
    /\bdataset\b/i, /\bhugging ?face\b/i, /\bkaggle\b/i, /\bcorpus\b/i, /\bfine[- ]tun/i, /\bscraped\b/i,
    /\btraining data\b/i, /\bcc-by\b/i, /\blicen[cs]e\b.*\b(mit|apache|cc)\b/i,
  ],
  "ai-services": [
    /\bclaude code\b/i, /\bmcp server/i, /\bagent skills?\b/i, /\bskills? pack/i, /\bautomation (agency|recipe|workflow)/i,
    /\bn8n\b/i, /\bproductized\b/i, /\bai agency\b/i, /\bsmb\b/i, /\bsmall business(es)? automat/i, /\bagent sdk\b/i,
  ],
};

/** Signals that a concrete, usable asset is present. */
export const ASSET_MARKERS: RegExp[] = [
  /\b(npx|pnpm dlx|bunx|pip install|uv tool install|brew install|npm i(nstall)?|cargo install|go install)\s+\S+/i,
  /huggingface\.co\/(datasets\/)?[\w.-]+\/[\w.-]+/i,
  /github\.com\/[\w.-]+\/[\w.-]+/i,
  /\b(closing date|submission deadline|applications? (close|due))\b/i,
  /\bskills? add\b/i,
];

export function keywordPoints(text: string): { perTrack: Record<string, number>; markers: number } {
  const perTrack: Record<string, number> = {};
  for (const [track, res] of Object.entries(TRACK_KEYWORDS)) {
    const hits = res.filter((re) => re.test(text)).length;
    if (hits) perTrack[track] = Math.min(GATE.KW_CAP, hits * GATE.KW_POINTS);
  }
  const m = ASSET_MARKERS.filter((re) => re.test(text)).length;
  return { perTrack, markers: Math.min(GATE.MARKER_CAP, m * GATE.MARKER_POINTS) };
}

// --- math ----------------------------------------------------------------

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Pure scoring: given the item vector, anchor vectors and the item text,
 * returns the gate decision. Exported for tests and offline calibration.
 */
export function scoreGate(
  itemVec: ArrayLike<number>,
  anchors: { anchor: Anchor; vec: ArrayLike<number> }[],
  text: string,
  explicit = false,
  weights: Record<string, number> = {},
): GateDecision {
  const trackSim = new Map<string, number>();
  const clauseSim = new Map<string, number>();
  let neg = -1;
  for (const { anchor, vec } of anchors) {
    const c = cosine(itemVec, vec);
    if (anchor.kind === "noise") neg = Math.max(neg, c);
    else if (anchor.kind === "track") trackSim.set(anchor.track!, c);
    else clauseSim.set(anchor.track!, Math.max(clauseSim.get(anchor.track!) ?? -1, c));
  }
  const { perTrack, markers } = keywordPoints(text);
  let best = { track: null as string | null, score: -Infinity, sim: 0 };
  for (const [track, ts] of trackSim) {
    const cs = clauseSim.get(track) ?? ts;
    const sim = GATE.TRACK_W * ts + (1 - GATE.TRACK_W) * cs;
    // Track weight (0–3) breaks near-ties toward the money tracks: ±3 points.
    const w = weights[track] ?? 2;
    const s = simToPoints(sim) + (perTrack[track] ?? 0) + (w - 2) * 3;
    if (s > best.score) best = { track, score: s, sim };
  }
  let score = best.score + markers;
  if (neg > best.sim - GATE.NEG_MARGIN) score -= Math.round((neg - best.sim + GATE.NEG_MARGIN) * 100 * GATE.NEG_PER_CENT);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const pass = explicit ? score >= GATE.EXPLICIT_FLOOR : score >= GATE.PASS;
  return { score, track: best.track, pass, sim: round3(best.sim), neg: round3(neg), kw: (perTrack[best.track ?? ""] ?? 0) + markers };
}

function simToPoints(sim: number): number {
  return ((sim - GATE.SIM_LO) / (GATE.SIM_HI - GATE.SIM_LO)) * 100;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// --- anchor cache --------------------------------------------------------

type Embedder = (texts: string[]) => Promise<Float32Array[]>;

/**
 * embedBatch in chunks of 25 with backoff on 429. The Gemini key's per-minute
 * token quota rejects a 100-text batch of 2k-character texts.
 */
export async function embedPaced(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 25) {
    const part = texts.slice(i, i + 25);
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await embedBatch(part)));
        break;
      } catch (e) {
        if (attempt >= 5 || !/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(String(e))) throw e;
        await Bun.sleep(15_000 * (attempt + 1));
      }
    }
  }
  return out;
}

let anchorCache: { hash: string; anchors: { anchor: Anchor; vec: Float32Array }[] } | null = null;
const OPS_KEY = "assets:gate:anchors";

/** Anchor embeddings, cached in memory and in ops_state until GOALS.md changes. */
export async function getAnchors(embed: Embedder = embedPaced): Promise<{ anchor: Anchor; vec: Float32Array }[]> {
  const anchors = buildAnchors(loadGoals().tracks);
  const hash = createHash("sha1").update(JSON.stringify(anchors)).digest("hex");
  if (anchorCache?.hash === hash) return anchorCache.anchors;
  try {
    const stored = getOpsState(OPS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as { hash: string; vecs: string[] };
      if (parsed.hash === hash && parsed.vecs.length === anchors.length) {
        anchorCache = { hash, anchors: anchors.map((a, i) => ({ anchor: a, vec: b64ToVec(parsed.vecs[i]) })) };
        return anchorCache.anchors;
      }
    }
  } catch { /* re-embed */ }
  const vecs = await embed(anchors.map((a) => a.text));
  anchorCache = { hash, anchors: anchors.map((a, i) => ({ anchor: a, vec: vecs[i] })) };
  try {
    setOpsState(OPS_KEY, JSON.stringify({ hash, vecs: vecs.map(vecToB64) }));
  } catch { /* memory cache is enough */ }
  return anchorCache.anchors;
}

export function vecToB64(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
}
export function b64ToVec(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** The text the gate embeds: title plus the first TEXT_CHARS characters. */
export function gateText(item: GateInput): string {
  return `${item.title}\n\n${item.text.replace(/\s+/g, " ").slice(0, GATE.TEXT_CHARS)}`.slice(0, GATE.TEXT_CHARS + 400);
}

/** Gate many items with one batched embedding call per 100 items. */
export async function gateItems(items: GateInput[], embed: Embedder = embedPaced): Promise<GateDecision[]> {
  if (!items.length) return [];
  const anchors = await getAnchors(embed);
  const weights = Object.fromEntries(loadGoals().tracks.map((t) => [t.id, t.weight]));
  const texts = items.map(gateText);
  const vecs = await embed(texts);
  return items.map((it, i) => scoreGate(vecs[i], anchors, texts[i], it.explicit, weights));
}

/** Test hook: drop the in-memory anchor cache. */
export function resetGateCache(): void {
  anchorCache = null;
}
