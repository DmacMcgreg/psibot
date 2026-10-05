/**
 * Jev payload builder for the Discover triage: the protected-interests
 * floor, the rubric/decision questions and the per-item state layout.
 */

import { choice, noul, type Payload } from "./jev.ts";
import { loadGoals } from "../assets/goals.ts";
import { isNewsChannel, NEWS_QUESTION, NEWS_RULE } from "./triage-decide.ts";
import { SOURCE_TEXT, type ChosenVideo, type ItemFacts, type RubricExample } from "./triage-store.ts";

// ─── Jev payload ────────────────────────────────────────────────────────────

/**
 * Safety floor, from David's own words: his note on a rejected anime recap
 * ("I'm interested in the spiritual philosophical ancient type") and his
 * interested examples (agent harness engineering, coding-agent tools, AI
 * roadmap analysis). Anything that is genuinely about these is never hidden.
 */
export const PROTECTED_INTERESTS =
  "Is this item a genuine, non-fiction treatment of spirituality, esotericism, religion, philosophy, consciousness, " +
  "ancient history or ancient mysteries, or of AI agent engineering (agent harnesses, coding-agent tools and models, " +
  "serious analysis of the AI roadmap or superintelligence)? Fiction, anime or manga recaps, games, and scripted drama " +
  "that merely borrow these themes do not count.";

/**
 * PROTECTED_INTERESTS plus David's money tracks from knowledge/GOALS.md, so a
 * concrete how-to on marketing, TikTok growth, AI or drone video editing,
 * client sites, tenders/grants, datasets or AI services is never hidden
 * either. Read at question-build time, so editing GOALS.md retargets Jev.
 * Falls back to PROTECTED_INTERESTS when the goals file can't be read.
 */
export function protectedInterests(tracks?: Array<{ id: string; description: string }>): string {
  let ts = tracks;
  if (!ts) {
    try {
      ts = loadGoals().tracks;
    } catch {
      ts = [];
    }
  }
  const goals = ts.filter((t) => t.description).map((t) => `${t.id} (${t.description.replace(/\.$/, "")})`);
  if (goals.length === 0) return PROTECTED_INTERESTS;
  return (
    PROTECTED_INTERESTS.replace(/\?\s*Fiction,/, "? Or is it a concrete, practical treatment (tools, techniques, steps, datasets, " +
      "open tenders or grants) of one of David's work goals: " + goals.join("; ") + "? Fiction,")
  );
}

const DECISION_Q =
  "Using David's rated examples, his reasons and his notes as the rubric, how would David most likely rate the item in his Discover queue?";
const DECISION_OPTIONS = {
  interested: "Interested: it matches the kinds of things he marked interested and he would want to watch or read it.",
  not_interested:
    "Not interested: it shares the reasons he gave for rejecting his not-interested examples (format, genre, source, language, length or lack of substance).",
  unsure: "Unsure: the rubric does not clearly settle it, or it is a topic he likes in a form he might or might not want.",
};

function factsState(f: ItemFacts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: f.title,
    source: SOURCE_TEXT[f.source] ?? f.source,
    topic_group: f.topicGroup,
    channel_or_author: f.by,
  };
  if (f.tags.length) out.tags = f.tags;
  if (f.durationMin !== null) out.duration_minutes = f.durationMin;
  if (f.hasTranscript !== null) out.has_transcript = f.hasTranscript;
  if (f.chosenFromChannel) out.david_chose_videos_from_this_channel = f.chosenFromChannel;
  out.excerpt = f.excerpt;
  return out;
}

/** The /discover page's generic reason chips; specific reasons carry more signal. */
const GENERIC_REASONS = new Set([
  "Exactly my interest", "Great source", "Want more like this", "Save for later",
  "Not interested", "Don't care", "Not my genre", "Wrong topic", "Already know this", "Too long", "Low quality",
]);

/** Specific reasons first, generic chips last, duplicates dropped. */
export function rankReasons(reasons: string[]): string[] {
  const uniq = [...new Set(reasons)];
  return [...uniq.filter((r) => !GENERIC_REASONS.has(r)), ...uniq.filter((r) => GENERIC_REASONS.has(r))];
}

/** Stable option key for a rubric example. */
export const exampleKey = (e: RubricExample) => `${e.verdict === "interested" ? "l" : "r"}_${e.atlasId}`;

export interface TriageQuestionSet {
  payloadFor(item: ItemFacts): Payload;
  examples: Map<string, RubricExample>;
}

export const chosenKey = (v: ChosenVideo) => `c_${v.videoId}`;

function ratedState(e: RubricExample, nReasons: number): Record<string, unknown> {
  return {
    title: e.title.slice(0, 80),
    channel: e.by,
    ...(e.durationMin !== null ? { minutes: e.durationMin } : {}),
    ...(e.reasons.length ? { reasons: rankReasons(e.reasons).slice(0, nReasons) } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

export function buildQuestions(rubric: RubricExample[], chosenSample: ChosenVideo[] = []): TriageQuestionSet {
  const liked = rubric.filter((e) => e.verdict === "interested");
  const rejected = rubric.filter((e) => e.verdict === "not_interested");
  if (rejected.length === 0 || liked.length === 0) {
    throw new Error(`rubric needs at least one interested and one not-interested rating (have ${liked.length}/${rejected.length})`);
  }
  const examples = new Map<string, RubricExample>(rubric.map((e) => [exampleKey(e), e]));
  // Chosen videos double as "liked" examples for the pick reason.
  for (const v of chosenSample) {
    examples.set(chosenKey(v), {
      atlasId: v.atlasId ?? 0, title: v.title, source: "youtube_chosen", topicGroup: v.topicGroup, by: v.channel,
      tags: v.tags, durationMin: null, hasTranscript: null, excerpt: "", verdict: "interested", reasons: ["a video you chose"], note: null,
    });
  }
  const opts = (xs: RubricExample[]) => {
    const o: Record<string, string> = {};
    for (const e of xs) o[exampleKey(e)] = `"${e.title.slice(0, 50)}"`;
    return o;
  };
  const likedOpts = { ...opts(liked) };
  for (const v of chosenSample) likedOpts[chosenKey(v)] = `"${v.title.slice(0, 40)}"`;
  likedOpts.none = "None of these is a close match.";
  const rejectedOpts = { ...opts(rejected), none: "None of these is a close match." };
  // Compact on purpose: the rubric rides in every call's state, so its size
  // sets the per-item cost. The item itself gets the full facts.
  const rubricState = {
    task:
      "David curates a Discover queue of videos, repositories and posts. david_chosen_videos are videos he picked " +
      "himself (saved to Watch Later or sent in), so they show the breadth of what he likes. david_rated_examples are " +
      "Discover items he rated, with his reasons and notes. Predict how he would rate a new item, judging it the way " +
      "he judged these.",
    sources: SOURCE_TEXT,
    // Every one of these is a positive: David picked it himself.
    david_chosen_videos: chosenSample.map((v) => ({
      title: v.title.slice(0, 80),
      channel: v.channel,
      ...(v.topic ? { topic: v.topic } : {}),
      ...(v.tags.length ? { tags: v.tags.slice(0, 2) } : {}),
    })),
    david_rated_examples: {
      interested: liked.map((e) => ratedState(e, 2)),
      not_interested: rejected.map((e) => ratedState(e, 3)),
    },
  };
  const questions = {
    decision: choice(DECISION_Q, DECISION_OPTIONS),
    closest_rejected: choice(
      "Which of David's not-interested examples is the item most like, in the sense that he would reject it for the same reason?",
      rejectedOpts,
    ),
    closest_liked: choice(
      "Which of David's interested examples is the item most like, in the sense that he would want it for the same reason?",
      likedOpts,
    ),
    protected_interest: noul(protectedInterests()),
  };
  return {
    examples,
    // Non-news payloads are unchanged, so their Jev cache stays valid.
    payloadFor: (item) =>
      isNewsChannel(item.by)
        ? { state: { ...rubricState, david_news_rule: NEWS_RULE, item: factsState(item) }, questions: { ...questions, canadian_news: noul(NEWS_QUESTION) } }
        : { state: { ...rubricState, item: factsState(item) }, questions },
  };
}
