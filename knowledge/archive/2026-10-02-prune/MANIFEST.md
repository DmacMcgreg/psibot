# PRUNE archive — 2026-10-02

Executed by board row `psibot-knowledge-prune-exec` (scout). License:
`research/psibot-knowledge-value-2026-10.md` in the vivaldi-home repo (the
knowledge-value audit's "What the numbers license today" list, rows 1–6).
Content is preserved verbatim — moved, not deleted. Nothing here is injected
into any prompt or indexed by any ingestion path.

## What moved

| Dir / file here | Came from | Audit row | Last live write |
|---|---|---|---|
| `trading/` (123 files) | `knowledge/trading/` | #16 (+ #9 injection) | PLAYBOOK Aug 1 · MODELS Sep 1 (monthly synthesis) |
| `stock-screens/` (21 files) | `knowledge/stock-screens/` | #16 | May |
| `charts/` (178 files, 27 MB) | `data/charts/` (gitignored) | #23 | May |
| `digests/` (13 files) | `knowledge/digests/` | #13 | W39 ~Sep 28 |
| `gmail/` + `gmail-parent-label-sync.gs` | `knowledge/gmail/` + `scripts/gmail-parent-label-sync.gs` | #18 | Apr 22 |
| `reddit-research/` (5 files) | `knowledge/reddit-research/` | #19 | stale |
| `pattern-scout/` (84 files) | `knowledge/pattern-scout/` | #20 | flags Sep 29 (zombie writer, see below) |
| `db/trading_signals.json` | `trading_signals` table dump (snapshot, mode=ro) | #9 | 1,454 rows, newest May 8 |
| `db/atlas_items-signal.json` | `atlas_items` kind=`signal` dump | #9 | 1,454 rows |
| `db/atlas_items-scan.json` | `atlas_items` kind=`scan` dump | #6 | 52 rows, newest Apr 20 |

Git note: `.gitignore`'s `knowledge/*` rule (with only `!knowledge/trading/`
carved out) means `trading/`, the `.gs` script, this MANIFEST and `db/` are
git-tracked; the other five dirs and `charts/` stay disk-only — exactly their
pre-prune tracking state, content unchanged.

## Code paths updated to exclude the pruned sources

- `src/agent/prompts.ts` — no edit needed: the Trading Context block reads
  `trading/PLAYBOOK.md` + `trading/REGIME.md` through
  `readKnowledgeFileOptional(...) ?? ""`; with the files archived both reads
  return `null` and the block's gate (`tradingPlaybook || tradingRegime`) is
  false. Probed post-move: both reads `null`. That is the whole ~43 KB/session
  injection gone (43,013 B measured = the audit's ~43 KB).
- `src/digest/index.ts` — DigestRunner no longer writes the superseded
  `knowledge/digests/` archive (compose + Telegram delivery + receipts
  unchanged; `sent_messages` rows are the record).
- `src/atlas/sync.ts` — `syncAtlasForTradingSignal` and `syncAtlasForScan`
  removed (atlas ingestion paths for the pruned `signal`/`scan` kinds).
- `src/db/queries.ts` — `insertTradingSignal` no longer syncs to atlas.
- `scripts/backfill-atlas.ts` — trading-signal backfill block removed;
  `scripts/backfill-atlas-scans.ts` deleted (scan-only, read `knowledge/trading/scans/`).

## Not executed (David's call, deliberately)

- **Live-db deletes.** `trading_signals` (1,454), `atlas_items` kind `signal`
  (1,454) and kind `scan` (52) rows still sit in `data/app.db`, dumps above
  preserve content. Deleting atlas rows needs matching vec/fts/entity cleanup —
  prepared statements, run only after review:
  - `DELETE FROM trading_signals;`
  - `DELETE FROM atlas_items WHERE kind IN ('signal','scan');` then
    `rebuildFtsAll()` (src/atlas/index.ts) + embedding/entity purge for the
    removed ids.
- **Job enablement untouched** (automation changes stay David's):
  - **Zombie writer = job 70 "Daily Claude-Mem Digest"** (enabled,
    `0 22 * * *`). Its prompt Step 4: *"Write a flag file:
    knowledge/pattern-scout/flags/YYYY-MM-DD.md"*, feeding job 69
    "Weekly Pattern Scout" (disabled 2026-08-15, last own run Aug 12). Flag
    mtimes sit at 22:01–22:05 (job 70's cron slot) through Sep 29 — 25 runs
    since Sep 1 — while job 69 was already dead. It will recreate
    `pattern-scout/daily/` + `flags/` on its next run until David edits the
    job prompt (drop Steps 3/4) or lets the dir stay pruned.
  - Job 64 "Gmail Parent Label Sync" stays disabled; its script is archived
    here.

## Residual references (dormant, documented)

- `src/atlas/synthesize.ts` monthly lane appends to `knowledge/trading/{PLAYBOOK,
  LESSONS,MODELS,RESEARCH}.md` — file under active sibling edit 2026-10-02, not
  touched; last append Sep 1, next monthly run would recreate `knowledge/trading/`.
- `src/agent/subagents.ts` trading-analyst persona saves screenshots to
  `data/charts/` (text only; subagent is part of the dead trading lane).
- Mini-app `/digest` route lists `knowledge/digests/` — dir absent → empty list,
  graceful. `/library` monthly section existsSync-guards each trading file —
  graceful.
- `trading_signals`/`signal`/`scan` remain valid atlas kinds (rows still in db).

## Numbers (audit's own arithmetic)

- Trading block: PLAYBOOK 22,896 B + REGIME 20,117 B = **43,013 B** (~43 KB).
- Before: 43,013 B × every session — 354 sessions/30d ≈ **15.2 MB dead
  context/30d** (audit: ~15 MB); goal C2's 1400 sessions/3wk ≈ **60.2 MB**.
- After: **0 B** — reads null, block absent (probe in the follow-up note).
- Recounted 2026-10-02: psibot agent_sessions 352/30d; claude-mem
  session_summaries 1,537/21d (the C2 quote's "1400 in three weeks" has grown).
