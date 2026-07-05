# Knowledge Architecture, Weekly Digest & Mini App Direction

**Date:** 2026-07-02
**Status:** Proposed — awaiting decisions (see §6)
**Inputs:** Two audit agents (memory/library concepts; ingestion pipelines), live card review at 390px.

---

## 1. Memory vs Library — what these concepts actually are

### Findings

| | **Memory** | **Library (Atlas)** |
|---|---|---|
| **What it is** | Agent self-knowledge: identity, user context, preferences, procedural learnings | Index of everything captured/produced: inbox, YouTube, signals, research, daily logs, scans |
| **Storage** | `knowledge/*.md` files + `memory_entries` FTS table | `atlas_items` + FTS + 768-dim vectors + entity graph |
| **Writers** | Agent (`memory_*` tools), manual edits | Ingestion pipelines via `syncAtlasFor*()` (src/atlas/sync.ts) |
| **Surfaces** | Dashboard `/memory`, TMA Memory page, system prompt | TMA Library (Items/Entities/Synthesis/Aliases), agent `atlas_*` tools |

**"Atlas MCP" clarification:** Atlas is **not an external MCP server**. It's an internal subsystem (SQLite tables + functions in `src/atlas/`) exposed to the agent as four tools inside the internal `agent-tools` MCP server: `atlas_search`, `atlas_get`, `atlas_stats`, `atlas_synthesize` (src/agent/tools.ts:714–834). Nothing to configure; no external dependency.

### The overlap (the incoherent part)

Two content types live in **both** indexes:

1. **Daily logs** — written to `knowledge/memory/YYYY-MM-DD.md`, indexed by `memory_entries` FTS **and** synced to `atlas_items` (kind=`daily_log`). Two search indexes, two UI surfaces (TMA Memory search + TMA Library Synthesis) for the same files.
2. **Research notes** — written to NotePlan / `knowledge/research/`, indexed in both systems. Unclear source of truth.

### Proposed concept model

> **Memory = who the agent is and what it knows about you.**
> **Library = everything that was captured or produced.**

Concretely:

- **Atlas becomes the only content search index.** Remove `daily_log`/research duplication from `memory_entries` indexing — memory scope shrinks to: `IDENTITY.md`, `USER.md`, `TOOLS.md`, `memory.md`, per-agent memory files. Files stay where they are; only indexing/surfacing changes.
- **TMA:** Library is the single knowledge surface. The Memory page shrinks to a small "Agent Memory" editor under More (view/edit identity/user/memory.md). Daily logs and research surface **only** in Library (Synthesis / kind filters).
- **Agent tools:** add one `knowledge_search(query, scope: memory|library|both)` wrapper so the agent doesn't have to pick between `memory_search` / `atlas_search` / `youtube_search`; keep the specialized tools underneath.

### Do we need Graphiti / an external knowledge graph?

**Recommendation: no — extend Atlas instead.**

- Atlas already **is** a knowledge graph: entities (`atlas_entities`), typed mentions with confidence, co-occurrence edges (`atlas_entity_cooccur`), embeddings, FTS, LLM-driven alias merging. All in SQLite, zero infra, synced from six pipelines.
- Graphiti (Zep) would add: temporal/episodic edges, graph queries, contradiction handling. Cost: a Neo4j/FalkorDB service to run, a second source of truth to keep in sync, and re-plumbing six ingestion paths. The payoff only materializes if you need temporal reasoning ("what did I believe about X in March?") — which the daily/weekly/monthly synthesis files already approximate.
- If a real gap appears later, the cleanest path is adding a typed `atlas_entity_relations` table (subject, predicate, object, valid_from/to) — Graphiti's core idea without the infra.

---

## 2. Ingestion pipelines — what surfaces and what doesn't

### Current state (audit summary)

| Pipeline | Ingestion | Surfacing today | Gap |
|---|---|---|---|
| Reddit saved (job 32, 4h) | ✅ → pending_items (92) | ✅ Inbox digest → News topic, buttons work | — |
| GitHub stars (job 34, 4h) | ✅ → pending_items (432) | ✅ Same | — |
| X bookmarks | ⚠️ Chrome extension only (122 items) | ✅ Same once captured | **No poller** — X API v2 bookmarks needs OAuth2 user-context; batch polling isn't viable. Extension flow is the pragmatic answer; make it frictionless rather than build a poller. |
| Inbox triage (job 33) + research (job 35) | ✅ GLM triage → NotePlan notes | ⚠️ Research completes **silently** | No "research done" notification with the note link |
| YouTube watchlist (job 12) | ✅ 617 videos, 20K embedded chunks, topic graph | ❌ Mini-app only, pull-based | Videos never appear in any digest |
| YouTube discovery (`src/discovery/`) | ✅ 296 channels, 4,818 candidates | ⚠️ News-mining code exists; topic surfacing incomplete | Candidates pile up invisibly |
| Trading signals | ✅ trading_signals (1,454 atlas items) | Portfolio jobs only | By design — fine |
| **Weekly rollup** | — | ❌ **Does not exist** | The thing you asked for a million times |

Key point: **`synthesizeWeeklyThemes()` already writes `knowledge/weekly/YYYY-Www.md` every week** (src/atlas/synthesize.ts). The weekly intelligence exists — it just never leaves the Library's Synthesis tab. The digest is mostly a **delivery** problem, not an analysis problem.

### The Weekly Digest — spec (once and for all)

**New job: "Weekly Digest" — Friday 17:00 ET** (after market close; decision point §6).

Compose (pure DB/file reads, no LLM needed except a top-line summary):

1. **Week in numbers** — captured by source, triaged, researched, videos processed, discovery candidates surfaced.
2. **Top 10 items** of the week — by priority + signal score, with source links and one-line extracted value.
3. **Research completed** — each note: title, 1-line summary, `noteplan://` link.
4. **YouTube** — videos processed this week (title/channel), top 3 by interest-profile relevance; discovery news highlights (`mineNews()` output).
5. **Rising entities** — week-over-week mention deltas from `atlas_entity_mentions` ("Claude Agent SDK +12, TUDCA +5…").
6. **Weekly themes** — the existing `knowledge/weekly/` synthesis, embedded.

Delivery (decision point §6):
- **Email** — HTML email via `gog gmail send` (gog CLI is installed and authed on this Mac). Renders well in Gmail; this was the original ask.
- **Telegram** — short summary + link to the full digest in the News topic.
- **Archive** — digests saved to `knowledge/digests/YYYY-Www.md` + a `/tma/digest` reader page.

Supporting fixes shipped alongside:
- **Research-complete notification** — when auto-research archives an item, send a 1-liner + note link to News (currently silent; this is why the pipeline feels like a black hole).
- **YouTube in the daily flow** — job 12's Telegram output includes titles of processed videos (currently just counts).
- **Discovery surfacing** — finish wiring `mineNews()` to its topic, and cap/expire stale candidates.

**Effort:** compose+email is one focused session (small); notifications are trivial; discovery wiring is medium.

---

## 3. Mini app direction — if Chat isn't the point, what is?

You talk to the agent in Telegram itself; the mini app's edge is **structured surfaces chat can't do**: lists, queues, toggles, graphs. Best use cases, ranked:

1. **Review queue (replaces Chat as a tab)** — the killer app. 325 items sit in `triaged` awaiting action; Telegram surfaces only 5/tick. A full-screen card queue — swipe/tap Research / Watch / Archive / Drop, with the extracted-value summary — is the fastest way to work the backlog and exactly what a Mini App is for. Same actions as the existing inline buttons, same DB effects.
2. **Digest reader** — `/tma/digest`: this week's + archived weekly digests (pairs with §2).
3. **Discovery tuner** — swipe through discovery candidates (4,818 waiting) to accept/reject; feeds `discovery_interest_weights`. Trains your YouTube discovery like a recommender.
4. **Trading cockpit** — positions, open signals, IC eval summary (the eval dashboard exists on desktop; a phone glance-view of "what's the bot holding and why" is high value).
5. **Approvals hub** — alias merge proposals (exists), autonomy-rule changes, deep-research approvals: everything the agent wants a yes/no on, in one badge-counted place.
6. **Cost monitor** — per-job cost trends from `job_runs`; catch a runaway job from your phone.

Proposed nav: **Review · Jobs · Library · Trading · More** (Chat moves under More).

---

## 4. Card quality — review findings (fixed today)

At 390px the cards failed on: raw markdown in previews (`## Overview **…`), JSON junk from source content, `has source link` filler, health chips rendering "3,430items"/"8awaiting embed" (inline-flex whitespace collapse) styled like active filters, jobs showing `Next: 2mo ago` on disabled jobs, topic name repeated in every row of a topic-grouped list, `auto-generated`/`fallback` pipeline tags on every video, and video snippets re-stating the title.

**Fixed in this session** (all view-layer):
- `markdownSnippet()` shared helper — flattens markdown, skips title echo (components.ts); applied to Library items + YouTube cards.
- Health chips: proper spacing, new `.tma-chip-warn` amber style.
- Jobs rows: `Every 4h · ran 3h ago · next in 1h`; "next" hidden for disabled/paused; topic de-duplicated; `formatAgo()` handles future dates.
- Meta tags (`auto-generated`, `fallback`, …) hidden from video cards.
- **Jobs filter bug**: chips linked to the fragment endpoint `/tma/jobs/list` → unstyled raw HTML on click. Now navigate to `/tma/jobs?…`; search fragment rebuilds toolbar+list so HTMX swaps don't destroy the toolbar.

**Still open (design-level, for a follow-up pass):**
- Duplicate items in Library ("Introducing AgentFlow" as both inbox + research kinds) — needs URL-level dedup or a "related items" grouping in Atlas.
- Entity duplicates ("Claude Code" as TOPIC and NAME) — alias pipeline covers same-kind merges only; cross-kind needs a rule.
- Library titles clamp to one line — allow 2 lines.
- 3 stacked chip rows on Jobs (~200px of toolbar) — could collapse into one "Filters" sheet.

---

## 5. Implementation phases (post-decision)

| Phase | Scope | Size |
|---|---|---|
| **A. Digest** | Compose function + email template + `gog gmail send` + Telegram summary + `/tma/digest` reader + research-complete notifications | M |
| **B. Review queue** | `/tma/review` card queue with the 4 actions; nav swap Chat→Review | M |
| **C. Concept cleanup** | De-dup memory/atlas indexing; Memory page → More; `knowledge_search` tool | S–M |
| **D. Card polish round 2** | Dedup, 2-line titles, filter sheet, entity cross-kind aliasing | S |
| **E. Discovery surfacing** | Wire mineNews topic + candidate expiry + discovery tuner page | M |

---

## 6. Decisions needed

1. **Digest delivery**: email + Telegram summary (recommended)? Or Telegram-only?
2. **Digest timing**: Friday 5pm ET (recommended) or Sunday evening?
3. **Nav swap**: replace Chat tab with Review queue (recommended)?
4. **Concept cleanup**: proceed with Atlas-as-only-content-index (recommended), or leave the dual indexing alone for now?
5. **Graphiti**: recommendation is to skip; veto if you want to experiment anyway.
