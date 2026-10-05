/**
 * Pure answer mapping for the Discover triage: Jev's RawAnswers →
 * probabilities, decision reasons. No DB, no Jev client.
 */

import type { RawAnswer } from "./jev.ts";
import type { Decision, Probs } from "./triage-decide.ts";
import { rankReasons } from "./triage-questions.ts";
import type { ItemFacts, RubricExample } from "./triage-store.ts";

// ─── answers → decision + reason (pure) ─────────────────────────────────────

export interface Triaged {
  item: ItemFacts;
  decision: Decision;
  probs: Probs;
  reason: string;
}

function prob(a: RawAnswer | undefined, key: string): number {
  if (!a) return 0;
  const p = a.probabilities?.[key];
  if (typeof p === "number") return p;
  return a.choice === key ? (a.confidence ?? 1) : 0;
}

export function probsFrom(answers: Record<string, RawAnswer>): Probs {
  const g = answers.protected_interest;
  return {
    pNot: prob(answers.decision, "not_interested"),
    pInterest: prob(answers.decision, "interested"),
    pProtected: typeof g?.noul === "number" ? g.noul : 0,
  };
}

export function newsProbFrom(answers: Record<string, RawAnswer>): number | undefined {
  const n = answers.canadian_news?.noul;
  return typeof n === "number" ? n : undefined;
}

function closest(a: RawAnswer | undefined, examples: Map<string, RubricExample>): RubricExample | null {
  if (!a?.choice || a.choice === "none") return null;
  return examples.get(a.choice) ?? null;
}

export function reasonFor(
  decision: Decision,
  p: Probs,
  answers: Record<string, RawAnswer>,
  examples: Map<string, RubricExample>,
  keptBy: "guard" | "channel" | "news" | null = null,
  item?: ItemFacts,
  knownChannel = false,
): string {
  const rej = closest(answers.closest_rejected, examples);
  const lik = closest(answers.closest_liked, examples);
  const why = (e: RubricExample) =>
    e.note ? e.note : e.reasons.length ? rankReasons(e.reasons).slice(0, 2).join("; ") : e.verdict === "interested" ? "rated interested" : "rated not interested";
  const like = (e: RubricExample) =>
    e.source === "youtube_chosen"
      ? `like “${e.title.slice(0, 60)}${e.title.length > 60 ? "…" : ""}” (a video you chose)`
      : `like “${e.title.slice(0, 60)}${e.title.length > 60 ? "…" : ""}”: ${why(e)}`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (decision === "hide") return rej ? `Not interested ${pct(p.pNot)} — ${like(rej)}` : `Not interested ${pct(p.pNot)}`;
  if (decision === "pick") {
    const base = lik ? `Interested ${pct(p.pInterest)} — ${like(lik)}` : `Interested ${pct(p.pInterest)}`;
    return knownChannel && item?.chosenFromChannel && p.pInterest < 0.8 ? `${base} · channel you've chosen before` : base;
  }
  const n = item?.chosenFromChannel ?? 0;
  const guard = keptBy === "news"
    ? " (kept: Ottawa / Ontario / Canadian politics news)"
    : keptBy === "guard"
    ? " (kept: core-interest topic)"
    : keptBy === "channel"
      ? ` (kept: you chose ${n} video${n === 1 ? "" : "s"} from ${item?.by})`
      : "";
  const lean = p.pNot >= p.pInterest ? (rej ? ` — leans ${like(rej)}` : "") : lik ? ` — leans ${like(lik)}` : "";
  return `Unsure: not ${pct(p.pNot)}, interested ${pct(p.pInterest)}${guard}${lean}`;
}
