/**
 * Background self-improvement review prompts.
 *
 * Direct ports of Hermes' three review prompts, MIT-licensed from
 * https://github.com/NousResearch/hermes-agent (run_agent.py:3353,3364,3440).
 *
 * Why we don't rewrite these: they encode lessons the Hermes maintainers
 * learned over months of running the loop in production:
 *   - Frustration signals ("stop doing X") are FIRST-CLASS skill signals,
 *     not just memory signals. Memory captures who the user is; skills
 *     capture how to do this class of task for them.
 *   - use_count is not a reason to skip consolidation. Counters are noisy
 *     for a young library.
 *   - Pairwise distinctness is not a reason to keep separate. The right bar
 *     is "would a human write this as N skills, or one skill with N
 *     subsections?"
 *   - The 4-tier preference ladder (patch loaded > patch umbrella > add
 *     support file > create new) is the actual fix for skill bloat.
 *
 * We will discover these failure modes ourselves over time; starting from
 * the tuned prompts saves us a quarter of trial and error.
 */

export const MEMORY_REVIEW_PROMPT = (
  "Review the conversation above and consider saving to memory if appropriate.\n\n" +
  "Focus on:\n" +
  "1. Has the user revealed things about themselves — their persona, desires, " +
  "preferences, or personal details worth remembering?\n" +
  "2. Has the user expressed expectations about how you should behave, their work " +
  "style, or ways they want you to operate?\n\n" +
  "If something stands out, save it using the memory tools (memory_append or " +
  "memory_write_section). If nothing is worth saving, just say 'Nothing to save.' " +
  "and stop."
);

export const SKILL_REVIEW_PROMPT = (
  "Review the conversation above and update the skill library. Be " +
  "ACTIVE — most sessions produce at least one skill update, even if " +
  "small. A pass that does nothing is a missed learning opportunity, " +
  "not a neutral outcome.\n\n" +
  "Target shape of the library: CLASS-LEVEL skills, each with a rich " +
  "SKILL.md and a `references/` directory for session-specific detail. " +
  "Not a long flat list of narrow one-session-one-skill entries. This " +
  "shapes HOW you update, not WHETHER you update.\n\n" +
  "Signals to look for (any one of these warrants action):\n" +
  "  • User corrected your style, tone, format, legibility, or " +
  "verbosity. Frustration signals like 'stop doing X', 'this is too " +
  "verbose', 'don't format like this', 'why are you explaining', " +
  "'just give me the answer', 'you always do Y and I hate it', or an " +
  "explicit 'remember this' are FIRST-CLASS skill signals, not just " +
  "memory signals. Update the relevant skill(s) to embed the " +
  "preference so the next session starts already knowing.\n" +
  "  • User corrected your workflow, approach, or sequence of steps. " +
  "Encode the correction as a pitfall or explicit step in the skill " +
  "that governs that class of task.\n" +
  "  • Non-trivial technique, fix, workaround, debugging path, or " +
  "tool-usage pattern emerged that a future session would benefit " +
  "from. Capture it.\n" +
  "  • A skill that got loaded or consulted this session turned out " +
  "to be wrong, missing a step, or outdated. Patch it NOW.\n\n" +
  "Preference order — prefer the earliest action that fits, but do " +
  "pick one when a signal above fired:\n" +
  "  1. UPDATE A CURRENTLY-LOADED SKILL. Look back through the " +
  "conversation for skills loaded via skill_view. If any of them " +
  "covers the territory of the new learning, PATCH that one first. " +
  "It is the skill that was in play, so it's the right one to extend.\n" +
  "  2. UPDATE AN EXISTING UMBRELLA (via skills_list + skill_view). " +
  "If no loaded skill fits but an existing class-level skill does, " +
  "patch it. Add a subsection, a pitfall, or broaden a trigger.\n" +
  "  3. ADD A SUPPORT FILE under an existing umbrella. Skills can be " +
  "packaged with three kinds of support files — use the right " +
  "directory per kind:\n" +
  "     • `references/<topic>.md` — session-specific detail (error " +
  "transcripts, reproduction recipes, provider quirks) AND " +
  "condensed knowledge banks: quoted research, API docs, external " +
  "authoritative excerpts, or domain notes you found while working " +
  "on the problem. Write it concise and for the value of the task, " +
  "not as a full mirror of upstream docs.\n" +
  "     • `templates/<name>.<ext>` — starter files meant to be " +
  "copied and modified (boilerplate configs, scaffolding, a " +
  "known-good example the agent can `reproduce with modifications`).\n" +
  "     • `scripts/<name>.<ext>` — statically re-runnable actions " +
  "the skill can invoke directly (verification scripts, fixture " +
  "generators, deterministic probes, anything the agent should run " +
  "rather than hand-type each time).\n" +
  "     Add support files via skill_manage action=write_file with " +
  "file_path starting 'references/', 'templates/', or 'scripts/'. " +
  "The umbrella's SKILL.md should gain a one-line pointer to any " +
  "new support file so future agents know it exists.\n" +
  "  4. CREATE A NEW CLASS-LEVEL UMBRELLA SKILL when no existing " +
  "skill covers the class. The name MUST be at the class level. " +
  "The name MUST NOT be a specific PR number, error string, feature " +
  "codename, library-alone name, or 'fix-X / debug-Y / audit-Z-today' " +
  "session artifact. If the proposed name only makes sense for " +
  "today's task, it's wrong — fall back to (1), (2), or (3).\n\n" +
  "User-preference embedding (important): when the user expressed a " +
  "style/format/workflow preference, the update belongs in the " +
  "SKILL.md body, not just in memory. Memory captures 'who the user " +
  "is and what the current situation and state of your operations " +
  "are'; skills capture 'how to do this class of task for this " +
  "user'. When they complain about how you handled a task, the " +
  "skill that governs that task needs to carry the lesson.\n\n" +
  "OUTCOME VERDICTS (always do this first, it takes seconds): for " +
  "EACH skill that was loaded via skill_view during the session, " +
  "record a verdict with skill_manage action=verdict verdict=helped|" +
  "neutral|misled. 'helped' = its procedure matched what actually " +
  "worked; 'neutral' = loaded but didn't matter; 'misled' = it was " +
  "wrong or sent the run down a bad path (then ALSO patch it). " +
  "Verdicts drive the curator's quality signal — a skill that is " +
  "repeatedly misleading gets flagged for rewrite regardless of usage.\n\n" +
  "If you notice two existing skills that overlap, note it in your " +
  "reply — the background curator handles consolidation at scale.\n\n" +
  "'Nothing to save.' is a real option but should NOT be the " +
  "default. If the session ran smoothly with no corrections and " +
  "produced no new technique, just say 'Nothing to save.' and stop. " +
  "Otherwise, act."
);

export const COMBINED_REVIEW_PROMPT = (
  "Review the conversation above and update two things:\n\n" +
  "**Memory**: who the user is. Did the user reveal persona, " +
  "desires, preferences, personal details, or expectations about " +
  "how you should behave? Save facts about the user and durable " +
  "preferences with the memory tools.\n\n" +
  "**Skills**: how to do this class of task. Be ACTIVE — most " +
  "sessions produce at least one skill update. A pass that does " +
  "nothing is a missed learning opportunity, not a neutral outcome.\n\n" +
  "Target shape of the skill library: CLASS-LEVEL skills with a rich " +
  "SKILL.md and a `references/` directory for session-specific detail. " +
  "Not a long flat list of narrow one-session-one-skill entries.\n\n" +
  "Signals that warrant a skill update (any one is enough):\n" +
  "  • User corrected your style, tone, format, legibility, " +
  "verbosity, or approach. Frustration is a FIRST-CLASS skill " +
  "signal, not just a memory signal. 'stop doing X', 'don't format " +
  "like this', 'I hate when you Y' — embed the lesson in the skill " +
  "that governs that task so the next session starts fixed.\n" +
  "  • Non-trivial technique, fix, workaround, or debugging path " +
  "emerged.\n" +
  "  • A skill that was loaded or consulted turned out wrong, " +
  "missing, or outdated — patch it now.\n\n" +
  "Preference order for skills — pick the earliest that fits:\n" +
  "  1. UPDATE A CURRENTLY-LOADED SKILL. Check what skills were " +
  "loaded via skill_view in the conversation. If one of them covers " +
  "the learning, PATCH it first. It was in play; it's the right place.\n" +
  "  2. UPDATE AN EXISTING UMBRELLA (skills_list + skill_view to " +
  "find the right one). Patch it.\n" +
  "  3. ADD A SUPPORT FILE under an existing umbrella via " +
  "skill_manage action=write_file. Three kinds: " +
  "`references/<topic>.md` for session-specific detail OR condensed " +
  "knowledge banks (quoted research, API docs excerpts, domain " +
  "notes) written concise and task-focused; `templates/<name>.<ext>` " +
  "for starter files meant to be copied and modified; " +
  "`scripts/<name>.<ext>` for statically re-runnable actions " +
  "(verification, fixture generators, probes). Add a one-line " +
  "pointer in SKILL.md so future agents find them.\n" +
  "  4. CREATE A NEW CLASS-LEVEL UMBRELLA when nothing exists. " +
  "Name at the class level — NOT a PR number, error string, " +
  "codename, library-alone name, or 'fix-X / debug-Y' session " +
  "artifact. If the name only fits today's task, fall back to (1), " +
  "(2), or (3).\n\n" +
  "User-preference embedding: when the user complains about how " +
  "you handled a task, update the skill that governs that task — " +
  "memory alone isn't enough. Memory says 'who the user is and " +
  "what the current situation and state of your operations are'; " +
  "skills say 'how to do this class of task for this user'. Both " +
  "should carry user-preference lessons when relevant.\n\n" +
  "OUTCOME VERDICTS: for each skill loaded via skill_view this " +
  "session, record skill_manage action=verdict verdict=helped|" +
  "neutral|misled ('misled' → also patch it). This is the curator's " +
  "quality signal.\n\n" +
  "If you notice overlapping existing skills, mention it — the " +
  "background curator handles consolidation.\n\n" +
  "Act on whichever of the two dimensions has real signal. If " +
  "genuinely nothing stands out on either, say 'Nothing to save.' " +
  "and stop — but don't reach for that conclusion as a default."
);

export type ReviewKind = "memory" | "skill" | "combined";

export function pickReviewPrompt(kind: ReviewKind): string {
  if (kind === "combined") return COMBINED_REVIEW_PROMPT;
  if (kind === "memory") return MEMORY_REVIEW_PROMPT;
  return SKILL_REVIEW_PROMPT;
}
