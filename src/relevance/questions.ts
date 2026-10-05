/**
 * Jev question batteries per item type.
 *
 * Each item gets up to three calls:
 *   1. CONTENT battery — profile-free feature nouls + a category Choice.
 *      State = the item only, so answers are cached forever and survive
 *      profile changes (cheap nightly retrains).
 *   2. PROFILE battery — the relevance gate plus "matches liked / disliked",
 *      with the user-interest profile in the state. Recomputed when the
 *      profile changes.
 *   3. GATE-ONLY — the gate noul alone with the profile (benchmark baseline).
 *
 * Entities use a single battery (no profile): a 3-level Score in the style of
 * Jev example 09 (leave / queue / merge) plus referent nouls.
 */

import { choice, noul, score, type Payload, type Questions } from "./jev.ts";
import type { ItemType, RelItem } from "./labels.ts";

// ─── categories ─────────────────────────────────────────────────────────────

/** PsiBot triage value types (pending_items.value_type), reused for articles. */
export const VALUE_TYPES: Record<string, string> = {
  technique: "A technique, method, pattern or workflow the reader can learn and apply.",
  tool: "A specific tool, library, app, repository, model or service.",
  actionable: "Something to act on now: news with a consequence, a deal, a deadline, a setting to change.",
  no_value: "Nothing extractable: entertainment, opinion, promotion, or content that failed to load.",
};

// ─── noul texts (kept stable: changing wording invalidates the cache) ───────

const GATE_VIDEO =
  "Given the user interest profile, would this user choose to watch this video if it were offered to them?";
const GATE_ARTICLE =
  "Given the user interest profile, would this user act on this link (ask for research on it or follow the topic) rather than archive or drop it?";

export const VIDEO_CONTENT_NOULS: Record<string, string> = {
  clickbait: "Is the title clickbait — sensational, vague or exaggerated relative to what the video actually delivers?",
  short_form: "Is this a short-form clip, meme, edit, reaction or viral short rather than a substantive video?",
  news_drama: "Is the video mainly news-cycle commentary, outrage or drama rather than durable knowledge?",
  teaches_technique: "Does the video teach a concrete technique, tool or workflow in enough detail to apply it?",
  ai_software: "Is the video mainly about AI, LLMs, coding agents or software development?",
  spiritual: "Is the video mainly about spirituality, esotericism, religion, consciousness or ancient mysteries?",
  entertainment: "Is the video primarily entertainment — gaming, sports, celebrities, comedy or lifestyle vlogs?",
  promotional: "Is the video mainly a product promotion, sponsored pitch or course sale?",
  non_en_es: "Is the video's spoken or written content in a language other than English or Spanish?",
  substantive: "Does the summary describe substantive, information-dense content rather than filler?",
};

export const ARTICLE_CONTENT_NOULS: Record<string, string> = {
  is_tool: "Is this item mainly a specific tool, library, repository, model or app?",
  teaches_technique: "Does this item explain a concrete technique or workflow the reader could apply?",
  actionable_now: "Could a builder act on this item right away (install, try, change a setting, follow up)?",
  common_knowledge: "Is this something an experienced AI engineer would most likely already know?",
  outdated: "Is this item likely outdated or already superseded by newer tools or releases?",
  low_quality: "Is this item low quality — thin, hype-driven, a promotion, or content that failed to load?",
  ai_software: "Is this item mainly about AI, LLMs, coding agents or software development?",
  hype: "Is the item framed as hype (e.g. 'game changer', 'insane', 'this changes everything')?",
};

const PROFILE_NOULS_VIDEO: Record<string, string> = {
  matches_liked: "Does this video's main subject match one of the topics or channels the profile shows the user chooses?",
  matches_disliked: "Does this video resemble the kinds of content the profile shows the user rejects or does not care about?",
};
const PROFILE_NOULS_ARTICLE: Record<string, string> = {
  matches_liked: "Does this link's subject match the kinds of links the profile shows the user acts on?",
  matches_disliked: "Does this link resemble the kinds of links the profile shows the user archives or drops (e.g. already known, outdated)?",
};

export const ENTITY_LEVELS = [
  "The alias refers to something different from the entity (merging would conflate two things).",
  "The alias could refer to the entity, but it is ambiguous or also names other things.",
  "The alias is just another way of writing the entity's name and always means it.",
];

export const ENTITY_NOULS: Record<string, string> = {
  same_referent: "Would a reader who sees the alias text almost always mean exactly this entity?",
  alias_names_other_thing: "Does the alias on its own name a different well-known thing (a product, person, place or organisation)?",
  generic_alias: "Is the alias a generic word or short phrase that could refer to many different things?",
  formatting_only: "Do the alias and the entity name differ only in spacing, hyphenation, punctuation, capitalisation or singular/plural?",
};

// ─── battery builders ───────────────────────────────────────────────────────

export function contentBattery(item: RelItem, groups: Record<string, string>): Payload {
  if (item.type === "video") {
    const qs: Questions = {};
    for (const [k, t] of Object.entries(VIDEO_CONTENT_NOULS)) qs[k] = noul(t);
    qs.category = choice("Which topic group does this video belong to?", groups);
    return { state: { video: item.content }, questions: qs };
  }
  if (item.type === "article") {
    const qs: Questions = {};
    for (const [k, t] of Object.entries(ARTICLE_CONTENT_NOULS)) qs[k] = noul(t);
    qs.value_type = choice("What kind of value does this saved link offer?", VALUE_TYPES);
    return { state: { link: item.content }, questions: qs };
  }
  const qs: Questions = {
    link_state: score("How does the proposed alias relate to the entity?", ENTITY_LEVELS),
  };
  for (const [k, t] of Object.entries(ENTITY_NOULS)) qs[k] = noul(t);
  return {
    state: {
      task: "A knowledge-graph builder proposes adding an alias to an entity so mentions of the alias get merged into it.",
      ...item.content,
    },
    questions: qs,
  };
}

export function profileBattery(item: RelItem, profile: string): Payload | null {
  if (item.type === "entity") return null;
  const isVideo = item.type === "video";
  const qs: Questions = { relevant: noul(isVideo ? GATE_VIDEO : GATE_ARTICLE) };
  for (const [k, t] of Object.entries(isVideo ? PROFILE_NOULS_VIDEO : PROFILE_NOULS_ARTICLE)) qs[k] = noul(t);
  return {
    state: { user_interest_profile: profile, [isVideo ? "video" : "link"]: item.content },
    questions: qs,
  };
}

export function gateOnly(item: RelItem, profile: string): Payload | null {
  if (item.type === "entity") return null;
  const isVideo = item.type === "video";
  return {
    state: { user_interest_profile: profile, [isVideo ? "video" : "link"]: item.content },
    questions: { relevant: noul(isVideo ? GATE_VIDEO : GATE_ARTICLE) },
  };
}

/** Feature names (in vector order) for a type; entity features include code-derived ones. */
export function featureNames(type: ItemType): string[] {
  if (type === "video") return ["relevant", ...Object.keys(PROFILE_NOULS_VIDEO), ...Object.keys(VIDEO_CONTENT_NOULS)];
  if (type === "article") return ["relevant", ...Object.keys(PROFILE_NOULS_ARTICLE), ...Object.keys(ARTICLE_CONTENT_NOULS)];
  return ["link_state", ...Object.keys(ENTITY_NOULS), "alias_is_separate_entity", "log_containing"];
}
