/**
 * Facts-only payload for the fine-tuned decider adapter (cc-j8ti).
 *
 * No rubric in the state and only the decision question: the adapter learns
 * David's taste from the ratings, so the prompt is short and carries nothing
 * a held-out rating could leak into. `local-decider.py --adapter` expects this
 * payload shape. It does not cover closest_rejected / closest_liked (their
 * options are rubric keys) or protected_interest.
 */

import { choice, type Payload } from "./jev.ts";
import type { ItemFacts } from "./triage-store.ts";
import { factsState } from "./triage-questions.ts";

export const LITE_TASK =
  "David curates a Discover queue of videos, repositories and posts and rates each item Interested or Not interested. " +
  "Predict how he would rate the item.";
export const LITE_QUESTION = "How would David most likely rate the item in his Discover queue?";
export const LITE_OPTIONS = {
  interested: "Interested: David would want to watch or read it.",
  not_interested: "Not interested: David would reject it (format, genre, source, language, length or lack of substance).",
  unsure: "Unsure: it could go either way.",
};

export function litePayload(item: ItemFacts): Payload {
  return { state: { task: LITE_TASK, item: factsState(item) }, questions: { decision: choice(LITE_QUESTION, LITE_OPTIONS) } };
}
