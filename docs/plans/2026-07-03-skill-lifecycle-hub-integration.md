# Skill Lifecycle: decay, freshness, pins — aligned with local-mcp-hub

**Date:** 2026-07-03
**Status:** IMPLEMENTED 2026-07-04 (checklist items 1–6, including the Phase 2 hub-signal adapter — the hub shipped W1–W19 so its telemetry store is stable). Day-one pins applied: gog-oauth-recovery, reminder-management, psibot-meta, agent-deterministic-gates. Export gated on per-skill approval via `skill_manage action=approve_export`; curator digest lists candidates.
**Hub context:** `~/Documents/2_Code/2026/local-mcp-hub` — **complete** (W1–W19; `scripts/seed-paths.ts` wraps `~/.claude/skills/`, telemetry sink at `~/.config/hub/telemetry.db`). **Hard constraint: nothing in this design writes to the hub repo, imports its code, or blocks on its schedule.**

---

## 1. What already exists (don't rebuild it)

### PsiBot side
- `~/.psibot/skills/` — ~20 active skill dirs + `.archive/`; sidecar `.usage.json` per store with `{use_count, view_count, patch_count, last_*_at, created_at, state, pinned, archived_at, absorbed_into, created_by}`.
- `src/curator/transitions.ts` — **a decay state machine already runs**: `active → stale @ CURATOR_STALE_AFTER_DAYS (30) → archived @ CURATOR_ARCHIVE_AFTER_DAYS (90)`, pinned bypasses everything, archive is a recoverable `renameSync` into `.archive/`, reactivation on new activity. LLM curator phase handles merge/absorb (`absorbed_into`).
- Known telemetry problem (established 2026-07-03): 17/24 skills never used; most `view/patch` counts come from the curator and background review touching skills, not workflows consuming them.

### Hub side (what we align WITH, not build INTO)
- **`GoldenPath` schema** (`registry/schema.ts`, shipped): unifies `kind: "skill" | "workflow" | "sequence"`; carries `whenToUse`, `whenNotToUse` (lint-required), `namedFailureAvoided`, `ruledOutDeadEnd`, `evalSuiteRef`, `provenance: "auto" | "claude-mem" | "human"`.
- **Routability gate:** only `provenance:"human"` paths are ever returned by `hub_route`. Auto-seeded paths are inert catalog entries until a human writes real boundaries and flips provenance. (ARCHITECTURE §4.3)
- **Seeding plan (ROUTE-1, future wave):** the hub will mechanically wrap **`~/.claude/skills/`** as `kind:"skill"`, `provenance:"auto"` paths. This is the free integration seam — anything we place there gets ingested with zero hub changes.
- **Exposure tiers:** HOT (in context) / COLD (searchable, lazy) / HIDDEN (invisible) — the same vocabulary our lifecycle should speak.
- **Telemetry (v1 landing now):** OTel spans in `bun:sqlite` with `path.id` attribution reserved. Once routing lands, "skill X was used by harness Y" becomes queryable *outside* PsiBot.
- **Read-only foreign-store discipline (§6.5):** the hub reads claude-mem's SQLite `readonly:true`, `PRAGMA table_info` drift check, fail-soft to "unavailable". **We adopt the identical discipline in the reverse direction** when reading hub telemetry.

## 2. Flaws in the current PsiBot decay (fix these regardless of hub)

1. **Observer pollution.** `latestActivity()` counts `last_viewed_at`, and the curator/background-review are the main viewers — so maintenance itself keeps dead skills "active" forever. The maintainer resets the decay clock it is supposed to enforce.
2. **Cliff, not score.** Binary 30/90-day cliffs can't express "recent skills are fresher" or "used 6× two months ago vs. used once yesterday". No ranking signal exists for prompt-listing order.
3. **Decay without exposure is premature burial.** Until skills are actually surfaced in prompts/jobs (the integration work), archiving an unused skill mostly measures our own discovery failure. Decay must only count *post-exposure* idle time.
4. **Pinned = ignored.** Pinned skills bypass transitions AND get no maintenance. David's requirement is the opposite: pinned skills are the ones to maintain forever even if rarely used.
5. **`created_by: null` skills invisible.** `agentCreatedReport()` only walks agent-created skills; hand-made ones (e.g. `gog-oauth-recovery`, the most-used skill in the store) are outside the lifecycle entirely.

## 3. The lifecycle model

### 3.1 Freshness score (replaces raw timestamps as the ranking signal)

Per skill, recompute on each curator tick:

```
score = Σ_events  w(kind) · 2^(−Δdays / H)   +   B_new
```

- Events: each recorded use/patch/view with its timestamp. Requires an append-only `events` array in the sidecar (or derive approximately from `*_count` + `last_*_at` for the backfill).
- Weights: `use = 1.0`, `patch = 0.5`, `view = 0.15`, and **`view/patch` events from curator or background-review sessions = 0** (fix #1 — tag the caller: `skill_view`/`skill_manage` gain an optional `actor: "workflow" | "curator" | "review"` param; curator + review pass their actor, default stays `workflow`).
- Half-life `H = 21 days` (config: `SKILL_SCORE_HALF_LIFE_DAYS`).
- New-skill boost `B_new = 1.0 · 2^(−age_days / 14)` — a fresh skill ranks as if it had one recent use, decaying over ~2 weeks (the "recent ones are fresh" requirement, and the grace period so a skill can't die before it was ever surfaceable).

### 3.2 Tiers (hub vocabulary, PsiBot enforcement)

| Tier | Criteria | Exposure |
|---|---|---|
| **HOT** | `pinned`, or top-N by score (N≈8, config) with score ≥ θ_hot | Listed name+description in the system prompt (`buildSkillListing()`); eligible for per-job injection |
| **COLD** | everything else in `active`/`stale` | Searchable via `skills_list`, loadable via `skill_view`; not in prompt |
| **ARCHIVED** | score < θ_arch **and** `exposure_age_days ≥ 90` (see below) **and** not pinned | Moved to `.archive/`, invisible, recoverable; curator may still absorb its content into a survivor first (existing merge flow) |

- **`exposure_age_days`**: idle-time counting starts at `first_exposed_at` — stamped the first time the skill actually appears in a prompt listing or job injection — not at `created_at` (fix #3). Until integration ships, nothing new gets archived.
- Hysteresis: promote to HOT at θ_hot, demote below 0.7·θ_hot — no flapping.
- Lifecycle covers **all** skills, not just agent-created (fix #5); `created_by` stays as provenance metadata.

### 3.3 Pinned = a maintenance contract, not an exemption (fix #4)

`pinned: true` means: never decays, always HOT-eligible, **and** the curator runs a periodic **verification pass** (every ~30 days, staggered):

- Do referenced files/commands/URLs in the skill still exist? (cheap mechanical checks first: paths, binaries on PATH)
- One LLM check: "does this procedure still match reality?" → patch or flag `needs_review: true` in the sidecar (surfaces in the heartbeat digest).
- Sidecar gains `last_verified_at`, `needs_review`.

This is the "kept forever even if rare" tier David asked for — kept *and kept true*.

### 3.4 Outcome verdicts (quality signal, from the earlier session's design)

Background review of runs that loaded a skill records `helped | neutral | misled` into the sidecar (`verdicts: {helped: n, neutral: n, misled: n}`). `misled ≥ 2` with `helped = 0` ⇒ curator flags for rewrite/archive regardless of score. Verdicts also become `namedFailureAvoided`/eval evidence at export time (§4.3).

## 4. Hub tie-in — three phases, each matched to a hub milestone, zero hub-repo writes

### Phase 1 — now (hub dependency: none)

**Export seam = `~/.claude/skills/`.** The curator gains an **export step**: skills that clear the quality bar are synced (rsync-style copy, `psibot-` prefix collision-guarded) into `~/.claude/skills/<name>/`, because:

- It immediately fixes the audience mismatch (dev-stack skills reach Claude Code sessions where their triggers occur).
- The hub's own ROUTE-1 seeding task **already plans to wrap that exact directory** into `provenance:"auto"` GoldenPaths. Placing files there means hub ingestion happens later with **no hub changes and no coordination** — the definition of non-disruptive.

**Quality bar for export** (curator-checked, mirrors the hub's three-condition promotion gate so exported skills are promotion-ready):
1. Evidence it works: `use_count ≥ 2` with a `helped` verdict, **or** pinned by David.
2. SKILL.md description is trigger-phrased ("use when X…") and body ≤ ~300 lines (split to `references/` otherwise — `psibot` @1,191 lines and `web-ui-patterns` @1,231 lines fail until split).
3. The skill can name its failure mode: frontmatter gains `when_not_to_use`, `named_failure_avoided` fields (curator drafts from the skill's own incident history; David edits). These map 1:1 onto `GoldenPath.whenNotToUse` / `namedFailureAvoided`, so the eventual human provenance-flip in the hub is transcription, not invention.

Exported copies carry frontmatter `x-psibot: {origin: <store path>, exported_at, score, verdicts}` — provenance metadata the hub seeder can ignore safely (it's just extra frontmatter) but the future human-authoring pass can use.

**Sync discipline:** PsiBot store remains the source of truth; export is one-way, re-export on content change, tombstone (delete exported copy) when a skill is archived at home — an exported skill that decayed in PsiBot shouldn't linger in `~/.claude/skills` unmaintained. Never touch skills in `~/.claude/skills/` that PsiBot didn't create (manifest of exported names kept in the sidecar file).

### Phase 2 — when hub v1 telemetry is live (hub dependency: read-only)

The curator gains a second **activity signal source**: the hub's telemetry SQLite, read with **exactly the discipline the hub uses on claude-mem** (its invariant #9, mirrored):

- `readonly: true` + `PRAGMA busy_timeout`; schema drift check via `PRAGMA table_info` against a pinned column subset; **fail soft** to "hub signal unavailable" — never a hard dependency, never a crash, never a write.
- Query: spans/audit lines referencing an exported skill (by path id / skill name) → recorded as `use` events with `source: "hub"` in the sidecar.
- Effect: a PsiBot-born skill that Claude Code sessions use via the hub **stays fresh in PsiBot's lifecycle** even if PsiBot itself never triggers it. Cross-harness usage prevents wrong-decay — the exact "unused here but valuable there" failure mode.

Gate: don't build until the hub's telemetry store location/schema is stable (it's landing this week); the read adapter is ~50 lines and can wait for a settled target.

### Phase 3 — when hub v2/v3 routing + evals land (hub dependency: still read-only)

- **Provenance flips stay the hub's gate.** PsiBot never marks anything `provenance:"human"` — David does, in the hub repo. PsiBot's job ends at delivering promotion-ready candidates (Phase 1 bar).
- **Eval suites:** for pinned/high-traffic exported skills, PsiBot can generate 2–3 held-out task prompts (from real usage transcripts) into the skill's `references/eval-candidates.md` — raw material for the hub's `evalSuiteRef` suites, again as inert data the hub team (David) chooses to adopt.
- **Verdict backflow:** if the hub's promoted-lesson write-back (§6.5, off by default) ever emits "path X promoted/demoted" observations to claude-mem, the curator can read those via claude-mem search as additional verdict evidence. Optional; zero coupling.

### Non-disruption invariants (mirror of the hub's own invariant style)

1. PsiBot never writes inside `local-mcp-hub/` and never imports its code — schema alignment is by **data-shape mirroring** (frontmatter fields named to map 1:1), not by dependency.
2. All hub-directed data flows through neutral ground (`~/.claude/skills/`) that the hub already plans to consume.
3. All hub-sourced data is read-only, drift-checked, fail-soft.
4. Routability/promotion authority lives exclusively in the hub. PsiBot curates candidates; it never routes.

## 5. Implementation checklist (PsiBot repo only)

Small, ordered; 1–4 are independent of the hub entirely.

1. **Sidecar v2** (`src/skills/usage.ts`, `types.ts`): add `events[]` (append-only, capped ~200/skill), `verdicts`, `first_exposed_at`, `last_verified_at`, `needs_review`, `exported` manifest entry. Backfill scores from existing counts+timestamps.
2. **Actor tagging** (`src/agent/tools.ts` skill tools + curator/review call sites): `actor` param; curator/review activity excluded from freshness (weight 0).
3. **Score + tiers** (`src/curator/transitions.ts` rewrite): freshness score, HOT/COLD/ARCHIVED with hysteresis, exposure-anchored idle, all-skills coverage, pinned verification pass. Config: `SKILL_SCORE_HALF_LIFE_DAYS=21`, `SKILL_HOT_SET_SIZE=8`, thresholds.
4. **Exposure wiring** (from the earlier session's plan — this is what makes decay meaningful): `buildSkillListing()` of the HOT tier into the system prompt; per-job skill injection; stamp `first_exposed_at`.
5. **Export step** (`src/curator/export.ts`): quality bar, one-way sync to `~/.claude/skills/`, tombstones, `x-psibot` frontmatter, report line in curator summary.
6. **Phase 2 adapter** (`src/curator/hub-signal.ts`, later): read-only hub telemetry → `use{source:"hub"}` events; `hub signal: unavailable` line in curator report when absent.

## 6. Open questions for David

- HOT set size for PsiBot's prompt (default 8 — name+one-liner each, ~15 lines of prompt)?
- Which skills to pin day one? Candidates from usage + criticality: `gog-oauth-recovery` (proven), `reminder-management`, `psibot-meta`, `agent-deterministic-gates`.
- Should the export bar require David's one-tap approval per skill (Telegram inline button from the curator digest) instead of fully automatic? Recommended: yes for the first month — it doubles as the human-authoring queue for the hub's provenance flip.
