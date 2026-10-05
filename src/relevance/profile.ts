/**
 * User-interest profile: a compact, deterministic text summary of the user's
 * past decisions, passed to Jev as part of the state for the profile-dependent
 * questions (the relevance gate, "matches liked", "matches disliked").
 *
 * It is one of the two learning levers (the other is the learner in
 * learner.ts): every retrain rebuilds it from the current labels, so new
 * decisions — especially stated reasons from the curation UI — change what
 * Jev is told about the user.
 *
 * Built only from labeled items. Unlabeled discovery videos are never
 * described as rejected. The keys of items quoted as exemplars are returned so
 * callers can keep them out of learner training/evaluation (their gate
 * answers would be inflated by seeing themselves in the profile).
 */

import { createHash } from "node:crypto";
import { mulberry32, shuffleInPlace } from "./learner.ts";
import type { RelItem } from "./labels.ts";

export interface ProfileOptions {
  seed?: number;
  videoPositiveExemplars?: number;
  videoNegativeExemplars?: number;
  articlePositiveExemplars?: number;
  articleNegativeExemplars?: number;
  topChannels?: number;
  /** Discover topic group slug → label, for the topic-mix line. */
  groupLabels?: Record<string, string>;
}

export interface Profile {
  text: string;
  hash: string;
  exemplarKeys: string[];
  basedOn: { videos: number; articles: number };
}

const REASON_LABELS: Record<string, string> = {
  known: "already known to the user",
  outdated: "outdated / superseded",
  irrelevant: "irrelevant to the user",
  low_quality: "low quality",
};

function pct(n: number, d: number): string {
  return d ? `${Math.round((100 * n) / d)}%` : "0%";
}

function topCounts(values: string[], k: number): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, k);
}

/**
 * Pick up to `n` items spread across categories (round-robin over
 * existingCategory buckets, largest bucket first), deterministic given seed.
 */
export function pickDiverse(items: RelItem[], n: number, seed: number): RelItem[] {
  if (n <= 0 || items.length === 0) return [];
  const rng = mulberry32(seed);
  const buckets = new Map<string, RelItem[]>();
  for (const it of [...items].sort((a, b) => a.key.localeCompare(b.key))) {
    const k = it.existingCategory ?? "_";
    const b = buckets.get(k);
    if (b) b.push(it);
    else buckets.set(k, [it]);
  }
  const ordered = [...buckets.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, b]) => shuffleInPlace(b, rng));
  const out: RelItem[] = [];
  let round = 0;
  while (out.length < n && ordered.some((b) => b.length > round)) {
    for (const b of ordered) {
      if (out.length >= n) break;
      if (b.length > round) out.push(b[round]);
    }
    round++;
  }
  return out;
}

export function buildProfile(labeled: RelItem[], opts: ProfileOptions = {}): Profile {
  const seed = opts.seed ?? 7;
  const groupLabels = opts.groupLabels ?? {};
  const vids = labeled.filter((i) => i.type === "video" && i.label !== null);
  const arts = labeled.filter((i) => i.type === "article" && i.label !== null);
  const vPos = vids.filter((i) => i.label === 1);
  const vNeg = vids.filter((i) => i.label === 0);
  const aPos = arts.filter((i) => i.label === 1);
  const aNeg = arts.filter((i) => i.label === 0);
  const exemplarKeys: string[] = [];
  const lines: string[] = [];

  lines.push(
    `USER INTEREST PROFILE — generated from ${vids.length + arts.length} past decisions by this user ` +
      `(${vPos.length} videos chosen, ${vNeg.length} videos rejected, ${aPos.length} links acted on, ` +
      `${aNeg.length} links archived or dropped). Use it to judge what this specific user wants.`,
  );

  if (vPos.length) {
    const grouped = vPos.filter((i) => i.existingCategory);
    const mix = topCounts(grouped.map((i) => i.existingCategory as string), 10)
      .map(([slug, n]) => `${groupLabels[slug] ?? slug} ${pct(n, grouped.length)}`)
      .join(", ");
    if (mix) lines.push(`\nVIDEOS THE USER CHOSE — topic mix: ${mix}.`);
    const channels = topCounts(vPos.map((i) => String(i.content.channel ?? "")), opts.topChannels ?? 15)
      .map(([c, n]) => `${c} (${n})`)
      .join(", ");
    lines.push(`Channels the user picks most: ${channels}.`);
    const ex = pickDiverse(vPos, opts.videoPositiveExemplars ?? 30, seed);
    lines.push("Sample of videos the user chose to watch:");
    for (const it of ex) {
      lines.push(`- "${it.title}" — ${it.content.channel ?? ""}`);
      exemplarKeys.push(it.key);
    }
  }

  if (vNeg.length) {
    const ex = pickDiverse(vNeg, opts.videoNegativeExemplars ?? 6, seed + 1);
    lines.push("\nVIDEOS THE USER EXPLICITLY REJECTED (stated reason):");
    for (const it of ex) {
      lines.push(`- "${it.title}" — ${it.reason ?? "no reason given"}`);
      exemplarKeys.push(it.key);
    }
    const reasons = topCounts(vNeg.map((i) => i.reason ?? ""), 8).map(([r, n]) => `${r} ×${n}`);
    if (reasons.length) lines.push(`All stated video-rejection reasons: ${reasons.join("; ")}.`);
  }

  if (aPos.length) {
    const ex = pickDiverse(aPos, opts.articlePositiveExemplars ?? 15, seed + 2);
    lines.push("\nLINKS THE USER ACTED ON (asked for research or to watch the topic):");
    for (const it of ex) {
      lines.push(`- ${articleLine(it)}`);
      exemplarKeys.push(it.key);
    }
  }

  if (aNeg.length) {
    const reasons = topCounts(aNeg.map((i) => i.reason ?? "no reason given"), 8)
      .map(([r, n]) => `${REASON_LABELS[r] ?? r} ×${n}`);
    lines.push(`\nLINKS THE USER ARCHIVED OR DROPPED without acting — reasons: ${reasons.join("; ")}.`);
    const ex = pickDiverse(aNeg, opts.articleNegativeExemplars ?? 8, seed + 3);
    for (const it of ex) {
      const r = it.reason ? ` — ${REASON_LABELS[it.reason] ?? it.reason}` : "";
      lines.push(`- ${articleLine(it)}${r}`);
      exemplarKeys.push(it.key);
    }
  }

  const text = lines.join("\n");
  return {
    text,
    hash: createHash("sha256").update(text).digest("hex").slice(0, 16),
    exemplarKeys,
    basedOn: { videos: vids.length, articles: arts.length },
  };
}

/** "[platform] title — summary lead" (X posts have uninformative titles). */
function articleLine(it: RelItem): string {
  const summary = String(it.content.summary ?? "");
  const lead = summary && !/^no summary/i.test(summary) ? ` — ${truncate(summary, 110)}` : "";
  return `[${it.content.platform ?? ""}] ${truncate(it.title, 80)}${lead}`;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
