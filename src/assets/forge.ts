/**
 * Skill forge: once a week (Sunday 18:00 America/Toronto) it turns the field
 * notes that **Add to skill** filed into concrete skill-edit proposals.
 *
 * - For each skill whose `references/field-notes.md` gained entries since the
 *   last run (entry-count watermark in ops_state), Claude sonnet reads the
 *   skill's SKILL.md plus its notes and drafts a proposed edit into
 *   `knowledge/skill-forge/<skill>-<YYYY-MM-DD>.md`.
 * - For each track in `new-skills.md` with 3 or more entries and at least one
 *   new since the last proposal, it drafts a new-skill proposal.
 *
 * It never edits a SKILL.md: proposals are files David reviews and applies.
 */

import { Cron } from "croner";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../shared/logger.ts";
import { getOpsState, setOpsState } from "../db/queries.ts";
import { askText, type AskOptions } from "./llm.ts";
import { HOMES, FIELD_NOTES, NEW_SKILLS_FILE, assertInsideHomes, resolveSkillHome, type SkillHome } from "./homes.ts";

const log = createLogger("skill-forge");

export const FORGE_CRON = "0 18 * * 0";
export const FORGE_TZ = "America/Toronto";
const NOTES_KEY = (skill: string) => `skill-forge:notes:${skill}`;
const NEW_SKILL_KEY = (track: string) => `skill-forge:new-skills:${track}`;
const LAST_RUN_KEY = "skill-forge:last-run";
/** A track needs this many new-skill entries before the forge proposes a skill. */
export const NEW_SKILL_THRESHOLD = 3;
const MAX_SKILL_CHARS = 40_000;
const MAX_NOTES_CHARS = 40_000;

/** Entries are `## YYYY-MM-DD · …` (field notes) or `### YYYY-MM-DD · …` (new-skills.md). */
export function splitEntries(doc: string, level: 2 | 3): string[] {
  const head = new RegExp(`^${"#".repeat(level)} \\d{4}-\\d{2}-\\d{2}`, "m");
  const parts: string[] = [];
  let cur: string[] | null = null;
  for (const line of doc.split("\n")) {
    if (head.test(line)) {
      if (cur) parts.push(cur.join("\n").trim());
      cur = [line];
    } else if (cur) {
      if (/^#{1,2} /.test(line) && !head.test(line) && level === 3) {
        parts.push(cur.join("\n").trim());
        cur = null;
      } else cur.push(line);
    }
  }
  if (cur) parts.push(cur.join("\n").trim());
  return parts;
}

/** new-skills.md → entries per track. */
export function newSkillTracks(doc: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const sections = doc.split(/^## track:\s*/m).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf("\n");
    const track = (nl < 0 ? sec : sec.slice(0, nl)).trim();
    const body = nl < 0 ? "" : sec.slice(nl + 1);
    out.set(track, splitEntries(body, 3));
  }
  return out;
}

/** Every skill that has a field-notes file, keyed by name, at its source of truth. */
export function skillsWithNotes(): SkillHome[] {
  const names = new Set<string>();
  for (const root of [HOMES.designKitSkillsDir, HOMES.hubSkillsDir, HOMES.agentsSkillsDir, HOMES.claudeSkillsDir]) {
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const n of entries) if (existsSync(join(root, n, FIELD_NOTES))) names.add(n);
  }
  const homes: SkillHome[] = [];
  for (const n of [...names].sort()) {
    const h = resolveSkillHome(n);
    if (h && existsSync(join(h.dir, FIELD_NOTES))) homes.push(h);
  }
  return homes;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n\n[…truncated at ${n} characters]` : s);

function skillPrompt(h: SkillHome, skillMd: string, notes: string[], fresh: number): string {
  const older = notes.slice(0, notes.length - fresh);
  const recent = notes.slice(notes.length - fresh);
  return `You maintain David's agent skills. Draft a concrete, reviewable edit to the "${h.name}" skill
from field notes that were filed from his research (videos, articles, repos).

Rules:
- Propose only what the NEW field notes justify. Older notes are context; they were already considered.
- Prefer small, surgical changes. If the SKILL.md body is long, put detail in a new
  references/<topic>.md file and add a one-line pointer in SKILL.md.
- Keep the skill's voice and structure. Don't restate what SKILL.md already says.
- Cite the source link of each note you use.
- If nothing in the new notes is worth changing the skill for, say so in one paragraph and stop.

Reply in Markdown with exactly these sections:
## Summary — two or three sentences: what changes and why.
## Proposed SKILL.md edit — a unified diff (\`\`\`diff with --- a/SKILL.md +++ b/SKILL.md and @@ hunks) against the SKILL.md below, or "none".
## New or updated reference files — for each, the path (e.g. references/foo.md) and its full proposed content in a fenced block, or "none".
## Notes not used — one line each with the reason.

Skill directory: ${h.dir} (owner: ${h.owner})

<skill_md>
${clip(skillMd, MAX_SKILL_CHARS)}
</skill_md>

<older_field_notes>
${clip(older.join("\n\n"), MAX_NOTES_CHARS / 2) || "(none)"}
</older_field_notes>

<new_field_notes>
${clip(recent.join("\n\n"), MAX_NOTES_CHARS)}
</new_field_notes>`;
}

function newSkillPrompt(track: string, entries: string[], existing: string[]): string {
  return `You maintain David's agent skills. The techniques below were filed for goal track "${track}" but no
existing skill fits them. Decide whether they justify one new skill (or an addition to an existing one) and draft it.

Existing skill names (reuse one if it clearly fits instead of proposing a new skill):
${existing.join(", ")}

Reply in Markdown with exactly these sections:
## Verdict — "new skill", "extend <existing-skill>", or "not yet" with one sentence why.
## Proposed skill — name (kebab-case), a one-paragraph description that says when to use it,
   then a full draft SKILL.md in a fenced block (frontmatter name + description, then concise steps).
   Put long material in proposed references/<topic>.md files, each in its own fenced block.
## Entries used — one line per entry with its source link.

<entries>
${clip(entries.join("\n\n"), MAX_NOTES_CHARS)}
</entries>`;
}

export interface ForgeProposal { kind: "skill" | "new-skill"; name: string; path: string; entries: number }
export interface ForgeRun { at: string; proposals: ForgeProposal[]; errors: string[] }

type Ask = (prompt: string, opts: AskOptions) => Promise<string>;

export class SkillForgeRunner {
  private cron: Cron | null = null;
  private running = false;

  constructor(private readonly ask: Ask = askText, private readonly now: () => Date = () => new Date()) {}

  start(): void {
    log.info("Starting skill forge", { cron: FORGE_CRON, tz: FORGE_TZ });
    this.cron = new Cron(FORGE_CRON, { timezone: FORGE_TZ }, () => {
      this.runOnce().catch((err) => log.error("Skill forge run failed", { error: String(err) }));
    });
  }

  stop(): void {
    this.cron?.stop();
    this.cron = null;
  }

  async runOnce(): Promise<ForgeRun> {
    const run: ForgeRun = { at: this.now().toISOString(), proposals: [], errors: [] };
    if (this.running) {
      run.errors.push("already running");
      return run;
    }
    this.running = true;
    try {
      const day = localDay(this.now());
      mkdirSync(HOMES.forgeDir, { recursive: true });

      for (const h of skillsWithNotes()) {
        try {
          const notes = splitEntries(readFileSync(join(h.dir, FIELD_NOTES), "utf-8"), 2);
          const seen = Number(getOpsState(NOTES_KEY(h.name)) ?? 0);
          const fresh = notes.length - seen;
          if (fresh <= 0) continue;
          const skillMd = existsSync(join(h.dir, "SKILL.md")) ? readFileSync(join(h.dir, "SKILL.md"), "utf-8") : "(no SKILL.md)";
          const reply = await this.ask(skillPrompt(h, skillMd, notes, fresh), { backend: "claude", tier: "sonnet", timeoutMs: 300_000 });
          if (!reply.trim()) throw new Error("empty reply");
          const path = this.writeProposal(`${h.name}-${day}.md`, [
            `# Skill forge proposal: ${h.name}`,
            "",
            `Drafted ${day} from ${fresh} new field note(s). Source of truth: \`${h.dir}\` (${h.owner}).`,
            `Field notes: \`${join(h.dir, FIELD_NOTES)}\`. Nothing was applied: review, then edit SKILL.md by hand.`,
            ...(h.owner === "hub" ? ["", "This skill is hub-managed: apply the edit in local-mcp-hub, then run `bun run scripts/install.ts`."] : []),
            ...(h.owner === "design-kit" ? ["", "This skill is owned by design-kit: apply the edit there, then run `pnpm skills:sync --push`."] : []),
            "",
            reply.trim(),
            "",
          ].join("\n"));
          setOpsState(NOTES_KEY(h.name), String(notes.length));
          run.proposals.push({ kind: "skill", name: h.name, path, entries: fresh });
        } catch (e) {
          run.errors.push(`${h.name}: ${String(e)}`);
          log.warn("Skill proposal failed", { skill: h.name, error: String(e) });
        }
      }

      const nsFile = NEW_SKILLS_FILE();
      if (existsSync(nsFile)) {
        const existing = skillNames();
        for (const [track, entries] of newSkillTracks(readFileSync(nsFile, "utf-8"))) {
          const seen = Number(getOpsState(NEW_SKILL_KEY(track)) ?? 0);
          if (entries.length < NEW_SKILL_THRESHOLD || entries.length <= seen) continue;
          try {
            const reply = await this.ask(newSkillPrompt(track, entries, existing), { backend: "claude", tier: "sonnet", timeoutMs: 300_000 });
            if (!reply.trim()) throw new Error("empty reply");
            const path = this.writeProposal(`new-skill-${track}-${day}.md`, [
              `# Skill forge proposal: new skill for track ${track}`,
              "",
              `Drafted ${day} from ${entries.length} entries in \`new-skills.md\`. Nothing was created: review, then author the skill with the writing-skills skill.`,
              "",
              reply.trim(),
              "",
            ].join("\n"));
            setOpsState(NEW_SKILL_KEY(track), String(entries.length));
            run.proposals.push({ kind: "new-skill", name: track, path, entries: entries.length });
          } catch (e) {
            run.errors.push(`new-skill ${track}: ${String(e)}`);
            log.warn("New-skill proposal failed", { track, error: String(e) });
          }
        }
      }

      setOpsState(LAST_RUN_KEY, JSON.stringify(run));
      log.info("Skill forge run complete", { proposals: run.proposals.length, errors: run.errors.length });
      return run;
    } finally {
      this.running = false;
    }
  }

  private writeProposal(file: string, body: string): string {
    const path = join(HOMES.forgeDir, file.replace(/[^\w.-]+/g, "-"));
    assertInsideHomes(path);
    writeFileSync(path, body);
    return path;
  }
}

function localDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FORGE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function skillNames(): string[] {
  const names = new Set<string>();
  for (const root of [HOMES.designKitSkillsDir, HOMES.hubSkillsDir, HOMES.agentsSkillsDir, HOMES.claudeSkillsDir]) {
    try {
      for (const n of readdirSync(root)) if (!n.startsWith(".")) names.add(n);
    } catch { /* missing root */ }
  }
  return [...names].sort();
}

/** Field notes filed since the last forge run, per skill. */
export function pendingFieldNotes(): { skill: string; fresh: number }[] {
  const out: { skill: string; fresh: number }[] = [];
  for (const h of skillsWithNotes()) {
    try {
      const n = splitEntries(readFileSync(join(h.dir, FIELD_NOTES), "utf-8"), 2).length;
      const fresh = n - Number(getOpsState(NOTES_KEY(h.name)) ?? 0);
      if (fresh > 0) out.push({ skill: h.name, fresh });
    } catch { /* unreadable */ }
  }
  return out;
}

export function lastForgeRun(): ForgeRun | null {
  const raw = getOpsState(LAST_RUN_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as ForgeRun; } catch { return null; }
}

/**
 * One or two lines for the digest: the last run's proposals and what is
 * waiting for the next one. Empty string when there's nothing to say.
 */
export function forgeSummary(): string {
  const last = lastForgeRun();
  const pending = pendingFieldNotes();
  const lines: string[] = [];
  if (last?.proposals.length) {
    const names = last.proposals.map((p) => (p.kind === "new-skill" ? `new skill (${p.name})` : p.name));
    lines.push(`Skill forge ${last.at.slice(0, 10)}: ${last.proposals.length} proposal(s) to review — ${names.join(", ")} (knowledge/skill-forge/).`);
  }
  if (pending.length) {
    const n = pending.reduce((s, p) => s + p.fresh, 0);
    lines.push(`${n} field note(s) waiting for Sunday's forge: ${pending.map((p) => `${p.skill} ${p.fresh}`).join(", ")}.`);
  }
  return lines.join("\n");
}
