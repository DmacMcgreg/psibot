# Discover — unified Mini App content hub (redesign)

**Status:** ✅ shipped (v1, all 4 waves) · **Date:** 2026-07-15

**v1.2 hotfix (2026-07-15):** YouTube summaries were STILL posting to the News
topic after v1 silenced the discovery digest. Root cause: a **second** surfacing
path. `src/youtube/process.ts` queues every processed video into `pending_items`
(`source='youtube'`) for triage/atlas indexing, and the heartbeat **inbox** digest
(`src/heartbeat/index.ts` `phaseSurfacing` + `surfaceBacklog`) posts *all* triaged
`pending_items` to the channel — with no source filter. Silencing the discovery
digest never touched it. Fix: a single gate, `src/shared/surface-policy.ts`
(`DISCOVER_ONLY_SOURCES = ['youtube']`, `isInboxSurfaceable()`,
`INBOX_SURFACEABLE_SQL`), applied at the query layer (`getUnsurfacedTriagedItems`),
the `topItems` selection, AND belt-and-suspenders at both send loops. Any new
path that posts `pending_items` to the channel MUST route through this gate.
Lesson: content reaches Telegram through multiple independent paths — silence the
*source class*, not one path.

**Shipped v1:** Telegram content posting silenced; `discover_*` tables +
`src/discover/` (db, k-means indexer, lazy chips, taxonomy refine); Mini App
`/tma/discover` as tab #1 (Agents moved under More, weekly digest folded in);
inline Interesting/Not-for-me feedback with generic + agent-generated chips +
free text; `discover_summary` MCP tool + morning/nightly brief one-liner.
Bootstrap on real data → **20 topic clusters** across 1,159 items
(github 443 · reddit 92 · YouTube 624). Verified end-to-end (page render +
feedback write + summary). Key gotcha fixed: `atlas_items_vec` embeddings come
back from bun:sqlite as raw Uint8Array bytes — must be reinterpreted as Float32.

**Shipped v1.1 (triage UX):** compact single-row topic cards + compact 2-line
item cards; client-side search (`tmaFilter`), sort (`tmaSort` — topics: Most
new/Largest/A–Z; items: Newest/Best match/A–Z) and source filter (🎬/⭐/👽)
reusing the shared tma.js helpers; **one-tap Skip** per item + **Skip all** for a
topic's new items (new `skipped` sentiment — CHECK rebuild in
`expandSourceCheckConstraints`; does not feed the negative-interest signal);
feedback panel now opens **instantly** on expanded generic reason chips
("Not interested / Don't care / Not my genre / Wrong topic / …") with
agent-generated chips streaming in lazily via `/api/discover/item/:id/chips`
(hx-trigger=load) so the LLM is never on the critical path.

**Follow-ups (not shipped):** pagination on large topics (currently capped at 100
items/filter); map YouTube feedback to `discovery_interest_weights` topics;
richer taxonomy pass (LLM split/merge, not just centroid-convergence merge);
an explicit un-skip / undo affordance.

Replaces the Telegram-posted "YouTube Discovery Digest" with a categorized,
interactive **Discover** hub in the Telegram Mini App (`/tma`). It unifies **four
content sources** into topic-clustered digests you browse yourself, rating each
item *interesting* / *not* with a reason that teaches the ranker and taxonomy
over time. The channel goes silent for content processing.

## Goals (from user)

1. **In the Mini App, not Telegram.** No content-processing messages in the
   channel; at most a one-line pointer in the morning/nightly brief.
2. **Unified hub across four sources:** YouTube discovery · YouTube watch-laters
   · GitHub stars · Reddit saved.
3. **Categorized / indexed.** Multiple digests grouped by main topic. Start with
   auto topic clusters; **learn and adjust over time** from feedback.
4. **Mark interesting / not**, capturing **why**: generic reason chips **+
   agent-generated per-item chips + optional free text**.

## Key architectural insight

A **unified, embedded index already exists**: `atlas_items` + `atlas_items_vec`
(768-dim, `gemini-embedding-001`). Every source is already projected in with an
embedding:

| Discover source | atlas rows | Selector over `atlas_items` |
|---|---|---|
| YouTube discovery | `kind='youtube'` | `video_id ∈ discovery_candidates(status IN processed,surfaced)` |
| YouTube watch-later | `kind='youtube'` | `youtube_videos.playlist_item_id IS NOT NULL` |
| GitHub stars | `kind='inbox'` | `json_extract(metadata_json,'$.source')='github'` (443 rows) |
| Reddit saved | `kind='inbox'` | `…'$.source')='reddit'` (92 rows) |
| *(dedup — exclude)* | `kind='inbox'` | `…'$.source')='youtube'` (cross-post dupe of the `youtube` kind) |

So **Discover does not need a new item table** — it is a topic-clustered,
feedback-driven *view* over `atlas_items`. We only add grouping + feedback on top.
`atlas_items.metadata_json` already carries `{source, platform, profile,
priority, category, value_type, watch_status, signal_score, status}`; body
preference is `triage_summary → quick_scan_summary → description`.

**Done already (this change):** `surfaceDigest()` marks picks `surfaced` and
persists news **without** posting to Telegram unless
`DISCOVERY_SURFACE_TELEGRAM=true` (default false). Channel is silent; data flows.

---

## Data model (new — all source-agnostic)

### `discover_topic_groups` — the digests
```sql
CREATE TABLE discover_topic_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,              -- "AI & Agents", "Psychology & Focus"
  emoji TEXT,
  centroid TEXT,                    -- base64 768-dim Float32, same space as atlas
  auto INTEGER NOT NULL DEFAULT 1,  -- 1 auto-created, 0 user-renamed/curated
  sort_order INTEGER NOT NULL DEFAULT 0,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### `discover_item_groups` — assignment (atlas item → group)
```sql
CREATE TABLE discover_item_groups (
  atlas_item_id INTEGER PRIMARY KEY REFERENCES atlas_items(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES discover_topic_groups(id) ON DELETE CASCADE,
  similarity REAL,
  chips_json TEXT,                  -- lazily generated {pos:[],neg:[]}; NULL until first open
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
```

### `discover_feedback` — ratings + why
```sql
CREATE TABLE discover_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  atlas_item_id INTEGER NOT NULL REFERENCES atlas_items(id) ON DELETE CASCADE,
  group_id INTEGER,
  sentiment TEXT NOT NULL CHECK(sentiment IN ('interested','not_interested')),
  reasons_json TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_discover_feedback_item ON discover_feedback(atlas_item_id);
```

**"New" = an eligible `atlas_item` with no `discover_feedback` row.** Simple,
source-agnostic, and needs no new status column on shared infra.

Reason chips: **generated lazily** on first feedback-open (one cheap LLM call
from the item's title+body), cached in `discover_item_groups.chips_json`. Falls
back to generic chips. Generic set:
- **not interested:** Too long · Already know this · Wrong topic · Not now · Low quality
- **interested:** Exactly my interest · Great source · Want more like this · Save for later

---

## Indexer (assignment step)

A `DiscoverIndexer` (runs on the discovery tick + a startup pass):
1. Select eligible `atlas_items` (four-source selector above) **not yet** in
   `discover_item_groups`.
2. For each, fetch its `atlas_items_vec` embedding; find nearest group centroid
   (cosine). Assign if `≥ SIM_THRESHOLD`; else create a new auto group seeded
   from the item (label from its dominant entity/keyword, or a cheap LLM label
   when several unlabeled items accrue).
3. Incrementally update `centroid` (bounded nudge) + `item_count`.

Runs cheap: pure vector math except occasional new-group labeling. Bounded per
tick (e.g. 200 items) with the remainder logged.

## Mini App UX

New section **Discover** (id `discover`; add to shell tabs / `MORE_PAGES` +
`more.ts` card).

- **`/tma/discover`** — list of topic-group digests. Each card: emoji + label +
  `N new` + a small **source mix** (🎬 videos · ⭐ repos · 👽 reddit) + preview
  titles. Sorted by new-count then affinity. "Discover / Other" last.
- **`/tma/discover/:slug`** — items in the group. Filter chips **New ·
  Interested · All** and optional source filter. Each card adapts to source:
  - *video*: `🎬 title — channel · match NN%` + summary + **Watch ↗**
  - *github*: `⭐ owner/repo · lang · stars` + description + **Open ↗**
  - *reddit*: `👽 r/sub · title` + snippet + **Open ↗**
  - all: **Interesting** / **Not for me**
- **Feedback panel** (inline HTMX): expands with generic + per-item chips
  (multi-select) + optional free text; `POST /tma/api/discover/feedback` records
  it, updates weights/centroid, swaps card to "✓ noted".

Reuse `pageHeader`, `card`, `listRow`, `filterChips`, `badge`, `button`,
`formField`, `emptyState`. Escape everything. API under `/api/*` (HMAC auth).

## Telegram brief pointer

One line in `MORNING-BRIEF.md` / `NIGHTLY-BRIEF.md`:
`📺 Discover: {N} new across {M} topics → {tmaLink("discover")}`.
Counts via a small MCP tool `discover_summary` → `{ newCount, groupCount, bySource, deepLink }`.

## Learning over time

- Immediate: feedback nudges group centroids; for YouTube items also
  `discovery_interest_weights`.
- Periodic (heartbeat/light job): agent rereads recent `discover_feedback` to
  rename / merge / split / retire groups. Bounded + logged.

---

## Build plan (waves)

### Wave 1 — Silence + foundation
- [x] **A1.** Gate Telegram surfacing behind `DISCOVERY_SURFACE_TELEGRAM` (default off). *(done)*
- [ ] **A2.** Migrations: `discover_topic_groups`, `discover_item_groups`, `discover_feedback` (+indexes). Live-DB edit + convention.
- [ ] **A3.** `src/discover/db.ts`: groups CRUD, assignment upserts, feedback insert, the four-source eligible-items query (join atlas_items + discovery_candidates + youtube_videos, reconstruct match% from `discovery_candidates.score_breakdown_json`), "new" = no feedback.

### Wave 2 — Indexer + chips
- [ ] **B1.** `src/discover/indexer.ts` `DiscoverIndexer` (nearest-centroid assign, seed/label new groups, centroid maintenance). Wire into `DiscoveryRunner` tick + startup.
- [ ] **B2.** Lazy reason-chip generation endpoint + cache in `discover_item_groups.chips_json`.

### Wave 3 — Mini App Discover
- [ ] **C1.** `src/web/routes/mini-app/discover.ts`: `/discover`, `/discover/:slug`, `POST /api/discover/feedback`, filter fragment. Register in mini-app `index.ts`.
- [ ] **C2.** `src/web/views/mini-app/discover.ts`: list, topic digest, per-source item card, inline feedback panel. Add `discover` tab + `more.ts` card.
- [ ] **C3.** Wire feedback → centroid + `discovery_interest_weights` (+ `feedback_log` mirror).

### Wave 4 — Pointer + learning
- [ ] **D1.** `discover_summary` MCP tool + brief one-liner.
- [ ] **D2.** Periodic taxonomy-refinement pass.
- [ ] **D3.** Retire `dv:drop` Telegram callback (dormant behind flag).

## Pitfalls

- **Dedup:** exclude `kind='inbox'` `source='youtube'` (dupe of `kind='youtube'`).
- **DB conventions:** live-DB edits + CHECK rebuild per `psibot-architecture-facts`.
- **vec0 only at runtime:** `atlas_items_vec` needs the app's loaded sqlite-vec; the CLI can't read it. Query embeddings through the app DB layer.
- **Shared infra:** do NOT add Discover columns to `atlas_items`; keep grouping/feedback in the new `discover_*` tables keyed by `atlas_item_id`.
- **Auth/escaping:** Discover API under `/tma/api/*`; all interpolation via `escapeHtml`/`escapeAttr`.
- **Cost:** chip generation is lazy + cached (per item, first open only).
