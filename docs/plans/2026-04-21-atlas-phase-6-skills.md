# Atlas Phase 6 — Procedural Memory (Skills)

**Date:** 2026-04-21
**Status:** Draft — design only, no implementation yet
**Prior art:** `.claude/plans/one-of-the-biggest-cozy-forest.md` (Phases 0–5 shipped 2026-04-20)
**Inspiration:** Hermes Agent (Nous Research) procedural memory + Honcho dialectic; Karpathy three-layer memory

---

## 1. Why this is a separate plan

Atlas (Phases 0–5) is a **content index** — every captured item lives in `atlas_items`, searchable by hybrid FTS + vector, enriched with entities, and rolled up into daily/weekly/monthly narratives. Atlas answers "**what did we learn about X?**"

Phase 6 is **procedural memory** — codified, reusable *patterns of action* the agent has learned work well. It answers "**when I encounter situation X, what do I do?**". Different abstraction: content vs. behaviour. Same storage substrate (SQLite + markdown files) but different lifecycle, invocation model, and user surface.

Shipping Atlas first was deliberate: let the content index mature so we can see **which behaviours recur often enough to be worth codifying** before we build the machinery to codify them. This plan captures the design we'll pick up when that moment arrives.

## 2. What exists today that's skill-shaped

The repo already has three proto-skill artifacts; we need to decide which of these becomes a Skill and which stays where it is:

| Artifact | Location | Skill-like property | Gap vs. true procedural memory |
|---|---|---|---|
| Scheduled jobs | `jobs` table | Recurring, named, invoked by cron | Static prompt, no evolution, no cross-job composition |
| Heartbeat phases | `src/heartbeat/*.ts` | Named steps, sequential, idempotent | Hard-coded in TypeScript, can't be edited by the agent |
| `HEARTBEAT.md` | `knowledge/HEARTBEAT.md` | Documents what heartbeat does | Documentation only, not executable |
| Agent subagents | `src/agent/subagents.ts` | Named capability, scoped tools | Static definitions, not learned |

A skill sits between "scheduled job" and "subagent": **a named, invocable, agent-editable procedure** with preconditions, a prompt template, success criteria, and a track record.

## 3. Design principles

1. **A skill is never inferred, always proposed and approved.** Same dialectic pattern as alias proposals. The agent drafts, the user approves. No silent procedural drift.
2. **Skills are markdown first.** The primary representation is a file in `knowledge/skills/`. SQLite holds metadata (invocation count, success rate, last used) but the skill *body* is plain markdown the user can edit in NotePlan.
3. **Evolution is monotonic and traceable.** Every change to a skill is a new version in `atlas_skill_versions`. Nothing overwrites silently. Retirement is soft — retired skills stay readable but aren't invoked.
4. **Invocation is explicit at first, triggered later.** Phase 6a: agent must name a skill to use it. Phase 6b (after we have enough data): preconditions can auto-match into the system prompt.
5. **Skills are scoped.** A skill declares *which surface* it applies to (inbox triage, trading signal classification, research deep-dive kickoff, daily narrative style). No free-floating "general purpose" skills.
6. **Failing skills get surfaced, not hidden.** If a skill's success rate drops below a threshold, the weekly digest proposes retirement. Never auto-deletes.

## 4. Skill anatomy

A skill is one markdown file plus one DB row.

### 4.1 Markdown body (`knowledge/skills/<slug>.md`)

```markdown
---
name: inbox-triage-github-star
scope: inbox_triage
status: active
created: 2026-05-03
version: 4
---

## When to use
Pending item where `source = 'github_stars'` and the repo description mentions
trading, ML, or local-first. Don't use on infra or dev-tool stars — those go to
the archive skill.

## Procedure
1. Fetch README (first 2000 chars) via `web_fetch`.
2. Classify into one of: `strategy`, `tool`, `reference`, `drop`.
3. If `strategy`, spawn deep-research subagent with prompt template in §3.
4. If `tool`, add to `knowledge/TOOLS.md` as a candidate, status `evaluating`.
5. If `reference`, file under Research tag, status `archived`.
6. Always: write a 2-sentence summary to the pending_item's `triage_summary`.

## Success signal
User approved auto-decision without override in >70% of runs last 30 days.

## Known failure modes
- Repos with only a screenshot in the README (no text) — fall back to search.
- Forks where the README describes the upstream, not the fork's deviation.
```

### 4.2 DB row (`atlas_skills`)

```sql
CREATE TABLE atlas_skills (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,           -- matches filename
  scope           TEXT NOT NULL,                  -- inbox_triage | signal_classify | research_kickoff | narrative_style | digest_compose
  status          TEXT NOT NULL DEFAULT 'active', -- draft | active | retired
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  retired_at      TEXT,
  retired_reason  TEXT
);

CREATE TABLE atlas_skill_versions (
  id         INTEGER PRIMARY KEY,
  skill_id   INTEGER NOT NULL REFERENCES atlas_skills(id),
  version    INTEGER NOT NULL,
  body_md    TEXT NOT NULL,                      -- full markdown snapshot
  change_note TEXT,                               -- why this version was written
  author     TEXT NOT NULL,                      -- 'user' | 'agent:<model>' | 'evolution'
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(skill_id, version)
);

CREATE TABLE atlas_skill_invocations (
  id           INTEGER PRIMARY KEY,
  skill_id     INTEGER NOT NULL REFERENCES atlas_skills(id),
  version      INTEGER NOT NULL,                 -- which version was active
  invoked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  surface      TEXT NOT NULL,                    -- heartbeat | job:<id> | chat | mini_app
  subject_id   TEXT,                             -- opaque — pending_item id, signal id, etc.
  outcome      TEXT,                             -- success | override | error | unknown
  latency_ms   INTEGER,
  cost_usd     REAL,
  notes        TEXT
);

CREATE INDEX idx_atlas_skill_invocations_skill ON atlas_skill_invocations(skill_id, invoked_at DESC);
```

### 4.3 Proposal row (`atlas_skill_proposals`)

Same dialectic pattern as alias proposals — the system drafts, the user approves.

```sql
CREATE TABLE atlas_skill_proposals (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL,                   -- new | refine | retire
  target_skill  INTEGER REFERENCES atlas_skills(id),  -- null for new
  proposed_body TEXT NOT NULL,                   -- markdown of the new version
  rationale     TEXT NOT NULL,                   -- why the agent proposed this
  evidence_json TEXT,                            -- invocation IDs that motivated it
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  proposed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolved_at   TEXT,
  resolved_by   TEXT
);
```

## 5. Invocation semantics

### 5.1 Phase 6a — explicit name lookup (first)

The agent gains an MCP tool pair:

- `skill_list(scope?)` → list of `{slug, name, scope, status, when_to_use}` — called by the agent *before* deciding how to act on a pending item, signal, etc.
- `skill_run(slug, subject)` → loads body markdown, executes its procedure (by spawning a sub-query with the markdown as the instruction, plus the subject), logs the invocation, returns result.

Inside `skill_run`, execution is a nested `query()` call with the skill body as system prompt and the caller's surface context as user message. This keeps skills composable with existing MCP tools.

### 5.2 Phase 6b — preconditions that auto-match (later)

Once we have ≥30 days of invocation data, we can add a `precondition_json` column (JSONPath-style expression over the subject) and have the heartbeat or job executor auto-inject matching skills into the system prompt rather than waiting for the agent to look them up.

Don't do this in 6a. Explicit `skill_run` calls give us the invocation log we need to even judge whether auto-matching would work.

### 5.3 Composition

Skills can call other skills via `skill_run` from inside their procedure body (e.g. the trading signal classifier delegates to `trading-options-strategy-match` for options-specific signals). The invocation log stores the parent `skill_invocations.id` so we can see call chains in the Mini App.

Guardrail: max call depth 3. Prevents runaway recursion, forces the user to flatten truly deep chains into a top-level orchestrating skill.

## 6. Evolution loop

This is the Hermes-inspired self-improvement piece. Runs weekly (piggyback on the existing weekly synthesis cron — Sundays 20:00, after synthesis, before alias proposals at 21:00).

```
for each active skill:
  invocations = last 30 days
  if invocations.count < 5:
    continue            # too little data
  success_rate = successful / (successful + override + error)

  if success_rate < 0.5:
    propose_retirement(skill, reason: "success < 50% over N runs")
  elif overrides.count > 0:
    diffs = compare_user_overrides_to_skill_output(overrides)
    if diffs.shows_consistent_pattern():
      propose_refinement(skill, new_body)
```

`propose_refinement` uses Sonnet (not Opus — this is a weekly job, cost matters) with the current skill body, the 30-day invocation log, and the user's override actions as input. Output: a new markdown body and a rationale. Writes to `atlas_skill_proposals`.

The agent does **not** edit the live skill. Approval flows through the Mini App, same as alias proposals.

## 7. Retirement policy

A skill moves `active → retired` only when:
1. User explicitly retires it via the Mini App, OR
2. User approves an auto-retirement proposal (generated by the evolution loop when success < 50% or invocations = 0 for 90 days).

Retired skills:
- Stay visible in Mini App under a "Retired" tab (history matters).
- Are excluded from `skill_list` calls — the agent can't see them.
- Keep their invocation log — useful for "why did we drop this?" retrospectives.
- Have their markdown file moved to `knowledge/skills/retired/` (still readable, never deleted).

## 8. Storage summary

| Layer | Where | Purpose |
|---|---|---|
| Live skill body | `knowledge/skills/<slug>.md` | Editable by user in NotePlan, single source of truth |
| Skill metadata | `atlas_skills` | Fast lookup, status, current version |
| Version history | `atlas_skill_versions` | Every body ever written, monotonic |
| Usage log | `atlas_skill_invocations` | Success / cost / latency over time |
| Proposals | `atlas_skill_proposals` | Pending changes awaiting approval |
| Retired archive | `knowledge/skills/retired/<slug>.md` | Read-only history |

FTS index: a contentless FTS5 over `atlas_skills.slug + latest_version.body_md` so the agent can do `skill_search("inbox github")` if it doesn't remember the slug. Mirrors `atlas_items_fts`.

## 9. User surface — Mini App

New tab under `/tma/library`:

- **Skills** — list of active skills, grouped by scope, with success-rate sparkline.
- **Skill detail** — markdown preview, invocation timeline (last 30), version history diff viewer, actions: Edit, Retire, Add tag.
- **Proposals** — pending skill proposals (new / refine / retire) — same approve/reject UX as aliases.

Telegram: weekly digest footer adds a "Skill proposals ready: N" line when >0, linking to the Mini App. No per-invocation notifications (too noisy).

## 10. Phased rollout

| Phase | Scope | Effort | Blocks on |
|---|---|---|---|
| **6.0 — Schema + file layout** | Tables, `knowledge/skills/` dir, seed 3 hand-written skills | 1 day | — |
| **6.1 — Read path** | `skill_list`, `skill_run` MCP tools, invocation logging | 2 days | 6.0 |
| **6.2 — Mini App read-only** | Skills tab, skill detail, invocation timeline | 1 day | 6.1 (need logs to display) |
| **6.3 — Proposal pipeline** | Evolution loop weekly job, proposals table, approve/reject in Mini App | 2 days | 6.1 (need invocation data to mine) |
| **6.4 — Auto-match preconditions** | `precondition_json`, heartbeat injection | 2 days | 30 days of data from 6.1 |

Total: ~8 dev-days across ≥30 days of calendar time (6.4 is gated on real usage data).

## 11. Open questions

Questions the user will need to answer before 6.0 kicks off.

1. **Scope vocabulary.** Is `inbox_triage | signal_classify | research_kickoff | narrative_style | digest_compose` the right starting set? Should `heartbeat_phase` be a scope so heartbeat steps can graduate to skills? Or keep those in TypeScript?
2. **Skill authorship boundary.** Can the user write skills directly in NotePlan and have them auto-ingest, or must every new skill come through a proposal? (Symmetric to current `knowledge/USER.md` editing — the user edits freely, the agent observes.)
3. **Cost budget.** Should skills declare a max cost per invocation? Easy to add a column. Open: who enforces — the runner, the skill's prompt template, or both?
4. **Nested skill depth.** Is 3 the right cap, or should it be configurable per scope?
5. **Retirement threshold.** 50% success rate feels arbitrary. Do we let the user tune per-scope? (Narrative style skills shouldn't be judged by success/fail the same way classification skills are.)
6. **PII.** Skills live in markdown on disk and get loaded into every `skill_run` prompt. If a skill body accidentally contains a ticker-specific rule mentioning account numbers, that's a leak. Do we add a pre-write linter, or lean on the user to review?

## 12. What this plan deliberately does NOT cover

- **Skill marketplace / sharing.** This is single-user. No need for a "global" skill repo.
- **Fine-tuning from invocations.** Skills stay as prompt templates. We're not training models from invocation data in this phase.
- **Skills that edit the codebase.** Procedural memory here means *agent behaviour*, not *code generation*. The `coder` subagent already exists for that.
- **Auto-proposal of entirely new skills.** Evolution loop only refines or retires *existing* skills. Creation is user-initiated in 6.0–6.3. (In 6.4+ we could let the evolution loop propose brand-new skills from clusters of repeated ad-hoc prompts, but that's gated on having enough invocation history to even identify the pattern.)

---

## Decision point before starting

The useful question to answer first isn't "how do we build this" — we have a design — it's **"do we have enough recurring agent behaviour to justify the machinery?"**

Suggested trigger: when we can point to 3–5 tasks the agent is clearly re-deriving each time (inbox triage rules, signal classification conventions, digest tone, research kickoff prompts) and the user is tired of correcting the same drift, that's when 6.0 starts. Until then, hand-authored files in `knowledge/` and prompt-engineering in `src/agent/prompts.ts` are doing enough work.

If the evolution loop can't find 5+ invocations in 30 days per skill, we built too early.
