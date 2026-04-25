# Trading Agent Eval + Research Suite — Plan v2

**Date:** 2026-04-25
**Status:** Approved (post-review consensus), autonomous execution in progress
**Spans repos:** `telegram-claude-code/` (agent traces) + `trading-bot/` (research DB, dashboard)
**Predecessor plan:** [look-over-all-the-elegant-adleman.md](~/.claude/plans/look-over-all-the-elegant-adleman.md) — built the `/agents` dashboard + envelope ingestion.

**Plan v1 → v2 changelog:** Two reviewer subagents (architecture rigor + risk/failure modes) ran on v1 in parallel. Their consensus surfaced 7 blockers and ~12 risks. This v2 incorporates every blocker fix and most risk mitigations. See **Reviewer-driven changes** section below for delta.

---

## Why this exists

The first plan got the dashboard live and ingested 209 historical job runs as `house`-attributed envelopes. Reconstructing trades from `JOURNAL.md` worked but surfaced a deeper problem: the agent's *memory* of what happened is unreliable.

Cleaning up the trade log isn't enough. The real question is whether the agent's *decisions* were good given the data it had — and whether the data it chose to look at was the right data. Three layers stacked:

```
Layer 3: Eval     — score agent decisions against Layer 2's ground truth
Layer 2: Ground   — universe-wide point-in-time feature snapshots + correlation mining
Layer 1: Catalogue — what the agent actually saw + asked for
```

Without Layer 2, Layer 3 is just measuring the agent against itself. Without Layer 1, we can't separate "wrong decision" from "missing information."

---

## Reviewer-driven changes (v1 → v2)

### Blockers fixed

| Blocker | v1 assumption | v2 fix |
|---|---|---|
| **Russell 3000 source** | "Wikipedia → S&P 1500 → S&P 500" fallback | No "List of Russell 3000 Index" Wikipedia page exists. Primary source is iShares IWV ETF holdings CSV (`https://www.ishares.com/us/products/239714/ishares-russell-3000-etf/1467271812596.ajax?fileType=csv&fileName=IWV_holdings`). Fallback to S&P 1500 (sp500 + sp400 + sp600 from Wikipedia) then sp500 alone. **All fallbacks log loudly and write `universe_load_log` row with chosen source + count.** |
| **technical_analysis service signatures** | Plan claimed it returns `ema_distance_50, ema_distance_200, mtf_alignment_pct, trend_score` | Verified: service returns 7 indicators (RSI, MACD, SMA_Crossover, BB_Position, Volume_Trend, EMA_Trend, ATR) using 9/21 EMA, no MTF. EPIC B.3 explicitly enumerates per-column derivation path. Columns without a clear derivation (`mtf_alignment_pct`, `trend_score`) are NULLABLE in v1; will be derived in EPIC B.3a after `multi_timeframe.py` is checked. |
| **CLI framework** | "Typer/argparse skeleton" | `typer` not in pyproject. **Lock to argparse** (matches existing `scripts/backfill_runs.py`). |
| **Service signature gating** | A.6 was 🟡 "verify regime/calendar/fundamentals" | Promoted to 🔴 strict-serial. Produces `docs/plans/services_contract.md` artifact listing actual callable signatures. EPIC B.7 (macro/regime), B.8 (analyst), B.9 (calendar) cannot start until this artifact exists. Already-confirmed: `RegimeMatcherService.compute_fingerprint(candles)` returns a 6-element list, NOT label/confidence — adapter will be needed. |
| **Disk pressure** | Not addressed | 96% full at start, 73 GB free. PRE.6 added: legacy `.bak` files MOVED (not deleted) to `~/db-backups/legacy-pre-2026-04-25/`; `research/ingest.py` checks free space every 1000 rows and writes `data/.halt` if below 10 GB. |
| **Layer 1 scope** | "158+ sessions" | Actual: **7,584 JSONL files, 637 MB**. EPIC D.3 changed: regex `\b[A-Z]{1,5}\b` MUST intersect Russell 3000 ticker set AND co-occur with finance keywords (`price\|RSI\|earnings\|target\|sentiment\|buy\|sell`) within ±50 chars OR appear inside a tool-call argument key matching `symbol\|ticker\|tickers`. v1 caps at `MAX_SESSIONS=500`; `--all` flag for later. |
| **Yahoo News has no historical query** | Plan assumed historical news count by date | Yahoo's `ticker.news` returns ~last 7 days only. v1 NULLs `news_*` columns for snapshots older than 7 days; current-day snapshots populate fully. Look-ahead bias documented as a known limitation. Polygon news endpoint moved up to a Phase B follow-on once core ships. |

### Risks mitigated

- **Module path:** Nest under `app/research/` — acceptance commands use `python -m app.research.cli`.
- **Async concurrency on yfinance/Yahoo:** Separate semaphore per provider (polygon=80/s, yahoo=2/s with jitter, yfinance=3/s, alpha_vantage=20/day). Documented in `research/rate_limit.py`.
- **Base metadata isolation:** `research/models.py` defines its own `class ResearchBase(DeclarativeBase): pass`. Never imported into `app.models.*` namespace.
- **Spearman IC:** Use `pandas.DataFrame.corr(method='spearman', min_periods=200)`. NaN columns logged separately. `news_sentiment_24h` filtered by `published_at < snapshot_as_of` (when historical news source eventually exists).
- **JSONL multi-source:** D.2 parser handles three sources: root `<sid>.jsonl`, `subagents/*.jsonl`, `tool-results/*.json`.
- **Idempotency:** Entire `UniverseSnapshot` written in one transaction with `INSERT ... ON CONFLICT(ticker, date, time) DO UPDATE`; checkpoint row in same txn.
- **Smoke gate:** Explicit pass/fail rule in EPIC E.7 (see EPIC E acceptance below).
- **Builder timeout:** `asyncio.wait_for(builder, timeout=30s)`. On timeout, NULL the column, continue.
- **WAL pragmas:** `journal_mode=WAL; busy_timeout=10000; synchronous=NORMAL` in `research/db.py` startup.
- **Dashboard / backfill collision:** EPIC F serial AFTER EPIC G's backfill quiesces. Plan invariant: "Backfill must not be running when EPIC F edits `main.py`."

### Suggestions adopted

- **Cut `factor_clusters` (k-means) from v1.** Defer to Phase 2.
- **Structured JSON logging.** `logging.getLogger("research")` → `backend/data/research.log`.
- **`--dry-run` mode** on backfill skips network calls, emits synthetic fixtures.
- **Safety asserter in `db.py`:** refuses to open `app.db` or `trading_bot.db` for write.
- **Reorder D before B:** Layer 1 catalogue is pure local file ETL — fastest insight per hour. New order: PRE → A → D → {B || C} → E → G → F → H. (B and C remain parallel siblings inside the inner block.)
- **Halt sentinel:** `data/.halt` checked by backfill loop every iteration; `scripts/eval/halt.sh` writes it.

---

## Decisions locked in

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where reconstructed history lives | New `house-historical` agent (📜, inactive) — already done | Keeps `house` as a clean baseline going forward |
| Universe | Russell 3000 (current members only, via iShares IWV CSV) | Survivorship-bias-adjusted version is too much complexity for v1 |
| History depth | 90 days | Aligns with available news coverage; covers FOMC + Iran + earnings cycles |
| Snapshot resolution | 2 per trading day: **premarket (8:30 AM ET)** + **midday (12:30 PM ET)** | Matches when agent's overnight + afternoon scanners actually fire |
| Storage | Separate `trading-bot/backend/data/research.db` (SQLite, WAL, NullPool) | Snapshot store will grow to several GB; isolating it keeps operational DB fast |
| News provider | **Yahoo Finance + Alpha Vantage news** (current-day only); historical news NULL | Existing `news_aggregator.py` is Yahoo + AV. Polygon news endpoint = Phase B. |
| Sidecar suites | Reddit, copy-trader, Unusual Whales — each as its own corpus + eval | Phase 2 |
| First sidecar after core | Reddit | Data is ours via existing telegram-claude-code reddit jobs |
| Backups | Before any pipeline run, `data/app.db` and `backend/trading_bot.db` snapshotted to `~/db-backups/<date>/` with sha256 manifest | Done in PRE.1 |
| CLI | `argparse` (no new dep) | Matches existing `scripts/backfill_runs.py` |
| `factor_clusters` | **DEFERRED** to Phase 2 | Not critical for v1 IC numbers |

---

## Verified existing services (use these, don't reimplement)

| Service | File | Entrypoint | Returns | Concurrency |
|---|---|---|---|---|
| Market data | `app/services/market_data.py` | `market_data_service.get_candles(symbol, timeframe, start_date, end_date)` | `MarketDataResponse` with `.candles: list[Candle]` | Polygon shared httpx async client (safe under gather) |
| Technical analysis | `app/services/technical_analysis.py` | `technical_analysis_service.analyze(symbol, timeframe, candles)` | `TechnicalAnalysisResult` with `.indicators` (RSI/MACD/SMA_Crossover/BB_Position/Volume_Trend/EMA_Trend/ATR), `.overall_signal`, `.signal_strength` | CPU-only |
| Volume profile / S+R | `app/services/volume_profile.py` | `volume_profile_service.analyze(symbol, ohlcv_df, current_price)` | `VolumeProfileAnalysis` with `.support_levels`, `.resistance_levels`, `.profile` (POC/VAH/VAL) | CPU-only |
| Sentiment (multi-source) | `app/services/sentiment_service.py` | `sentiment_service.get_aggregated_sentiment(symbol, days, sources)` | `AggregatedSentiment` with `.overall_score`, `.confidence`, `.sources` | Hits Yahoo + AV — gate via yahoo+av semaphores |
| News aggregator | `app/services/news/news_aggregator.py` | `NewsAggregator().scan_all_sources(symbols)` | `MarketNewsDigest` (current-day only — Yahoo `ticker.news` returns ~7d max) | Yahoo scrape + AV (25/day) |
| Options (live only) | `app/services/options_service.py` | `options_service.analyze(symbol)` | `OptionsAnalysisResult` with PCR, IV rank, GEX regime, unusual flow | yfinance — gate via yfinance semaphore |
| Regime | `app/services/regime_matcher.py` | `RegimeMatcherService.compute_fingerprint(candles)` returns 6-element list | Adapter needed | CPU-only |
| Calendar (earnings) | `app/services/calendar_service.py` | TBD — enumerated in A.6 | TBD | TBD |
| Fundamentals | `app/services/fundamentals_service.py` | yfinance-backed | TBD — enumerated in A.6 | yfinance — gate |
| Polygon HTTP client | `app/services/data_providers/massive_provider.py` | `MassiveProvider` (httpx async, has API key) | Extension point for new endpoints | Shared async client |
| Async DB engine | `app/db.py` | `create_engine(url=...)`, NullPool for SQLite | Mirror this pattern for `research.db` | `aiosqlite` + NullPool |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CORE EVAL SUITE  (build first)                                 │
│  Universe: Russell 3000 (sp500 fallback if IWV CSV fails)       │
│  History: 90d  ·  Snapshots: 2x/day                             │
│                                                                  │
│  trading-bot/backend/data/research.db                           │
│  ├─ universe_snapshots       — point-in-time feature vectors    │
│  ├─ universe_load_log        — which source, when, count        │
│  ├─ snapshot_news            — news items joined to ticker+time │
│  ├─ snapshot_analyst         — STUB; populated in Phase B       │
│  ├─ ingest_checkpoints       — (ticker, date, time, status)     │
│  └─ factor_ic                — IC of each feature vs forward ret │
│                                                                  │
│  (factor_clusters DEFERRED to Phase 2)                          │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — AGENT CONTEXT CATALOGUE  (build BEFORE Layer 2)      │
│  Sources: ~/.claude/projects/<proj>/<sid>.jsonl    (7,584 files)│
│           ~/.claude/projects/<proj>/<sid>/subagents/*.jsonl     │
│           ~/.claude/projects/<proj>/<sid>/tool-results/*.json   │
│           data/app.db job_runs (link via session_id)            │
│                                                                  │
│  research.db                                                     │
│  ├─ context_runs              — 1 per session: agent, model     │
│  ├─ context_tool_calls        — 1 per tool_use: name, args, out │
│  ├─ context_symbols           — symbols asked-about per run     │
│  ├─ context_news_items        — news from sentiment/scan output │
│  ├─ context_searches          — web searches                     │
│  └─ context_knowledge_reads   — which knowledge files consulted │
└─────────────────────────────────────────────────────────────────┘
```

---

## Epics + tasks (parallelization-aware, post-review reordering)

Legend:
- 🟢 = no dependencies, can start immediately
- 🟡 = depends on another task in the same epic, parallelizable with siblings once unblocked
- 🔴 = strict serial dependency

**Subagent assignment plan:** Tasks tagged with `[subagent: <id>]` will be delegated to a parallel subagent. Tasks without that tag run inline.

### EPIC PRE — Pre-flight (already done in this run)

- [x] **PRE.1** Backup `data/app.db` and `backend/trading_bot.db` to `~/db-backups/2026-04-25/` with sha256 manifest
- [x] **PRE.2** Survey backend services to verify what exists vs. what plan assumed
- [x] **PRE.3** Restructure plan v1 into epics with parallelization graph
- [x] **PRE.4** 2 reviewer subagents analyze plan v1 (architecture rigor + risk/failure modes); synthesize consensus
- [x] **PRE.5** Update plan to v2 with reviewer-driven changes (this section)
- [x] **PRE.6** Move legacy `.bak` files in `data/` to `~/db-backups/legacy-pre-2026-04-25/` (PRESERVED, not deleted)
- [ ] **PRE.7** Commit revised plan + backup manifest

### EPIC A — Research package skeleton (under `app/research/`)

Goal: Compilable package with all module stubs, working DB connection to a fresh `research.db`, all CRUD primitives. No business logic yet.

- [ ] **A.1** 🟢 Create `trading-bot/backend/app/research/` package + `__init__.py`
- [ ] **A.2** 🟢 `app/research/db.py` — async engine + sessionmaker pointing at `backend/data/research.db`. WAL pragmas (`journal_mode=WAL; busy_timeout=10000; synchronous=NORMAL`). **Safety asserter**: refuses to open any URL not containing `research.db`.
- [ ] **A.3** 🟢 `app/research/models.py` — SQLAlchemy ORM. **MUST** define `class ResearchBase(DeclarativeBase): pass`. Tables: `universe_snapshots, universe_load_log, snapshot_news, snapshot_analyst, ingest_checkpoints, factor_ic, context_runs, context_tool_calls, context_symbols, context_news_items, context_searches, context_knowledge_reads`. NO `factor_clusters` (deferred).
- [ ] **A.4** 🟢 `app/research/schema.py` — Pydantic models mirroring ORM
- [ ] **A.5** 🟡 `app/research/cli.py` — `argparse` skeleton with subcommands: `init-db, universe-load, catalogue-traces, backfill, forward-returns, compute-ic, verify, halt`
- [ ] **A.6** 🔴 **BLOCKING for B.7/B.8/B.9**: read `app/services/regime_matcher.py`, `calendar_service.py`, `fundamentals_service.py`, `multi_timeframe.py` and produce `docs/plans/services_contract.md` documenting exact callable signatures + return shapes. [subagent: contract-reader]
- [ ] **A.7** 🔴 `python -m app.research.cli init-db` runs end-to-end; `research.db` exists with all tables; `sqlite3 ".schema"` confirms columns
- [ ] **A.8** 🔴 Commit EPIC A

**Acceptance:** `uv run python -m app.research.cli init-db` creates `backend/data/research.db` with all tables; `services_contract.md` exists.

### EPIC D — Layer 1 agent context catalogue (run FIRST after A)

Goal: Read `~/.claude/projects/<proj>/<sid>.jsonl` files + `data/app.db job_runs`, populate `context_*` tables. Pure file/DB ETL — no API calls, no rate limits. **Highest insight per hour epic.**

- [ ] **D.1** 🟢 `app/research/catalogue/discover.py` — find session JSONL files in `~/.claude/projects/-Users-davidmcgregor-Documents-2-Code-2026-telegram-claude-code/`; cap at `MAX_SESSIONS=500` for v1; cross-reference with `data/app.db job_runs.session_id` (read-only via `mode=ro`); filter to trading-related sessions (jobs 24, 30, 31, 36, 37, 38, 39 per CLAUDE.md). [subagent: catalogue-D1-D3]
- [ ] **D.2** 🟢 `app/research/catalogue/parser.py` — JSONL parser handling THREE sources: root `<sid>.jsonl`, `subagents/*.jsonl`, `tool-results/*.json`. Tolerate format drift across SDK versions. [subagent: catalogue-D1-D3]
- [ ] **D.3** 🟢 `app/research/catalogue/extractors.py` — extract:
  - **Symbols**: regex `\b[A-Z]{1,5}\b` MUST intersect loaded Russell 3000 ticker set AND (co-occur with finance keywords `price|RSI|earnings|target|sentiment|buy|sell|long|short` within ±50 chars OR appear inside a tool-call argument key matching `symbol|ticker|tickers`)
  - **Tool calls**: name, args (truncated to 1KB), output (truncated to 1KB)
  - **Web searches**: queries
  - **News items mentioned**: titles (best-effort)
  - **Knowledge file paths read**: from `Read` tool calls
  [subagent: catalogue-D1-D3]
- [ ] **D.4** 🟡 `app/research/catalogue/ingest.py` — populate context_* tables. Idempotent via UNIQUE on (session_id, message_index). [subagent: catalogue-D4-D5]
- [ ] **D.5** 🟡 `app/research/cli.py catalogue-traces` subcommand wires it together [subagent: catalogue-D4-D5]
- [ ] **D.6** 🔴 Run on first 500 sessions; smoke-check counts:
  - `SELECT COUNT(*) FROM context_runs` ≥ 100
  - `SELECT COUNT(DISTINCT name) FROM context_tool_calls` ≥ 10
  - `SELECT COUNT(*) FROM context_searches` (this is the bias finding — likely small)
  - `SELECT name, COUNT(*) FROM context_tool_calls GROUP BY name ORDER BY 2 DESC LIMIT 10`
- [ ] **D.7** 🔴 Write findings summary to `docs/plans/results/2026-04-25-layer1-findings.md` (top tools, top symbols, top knowledge reads, search count)
- [ ] **D.8** 🔴 Commit EPIC D

**Acceptance:** `context_runs` ≥ 100 rows; findings summary exists and shows clear tool-usage pattern (e.g., "trading-bot MCP dominates, only N web searches across all sessions").

### EPIC B — Snapshot builder (parallel with C, after A and A.6)

Goal: For one (ticker, date, time) tuple, produce a complete `UniverseSnapshot` row by composing existing services. Failures degrade gracefully (NULL the column, log, continue). 30s timeout per builder.

- [ ] **B.1** 🟢 `app/research/universe.py` — `load_russell_3000() -> list[str]`. Strategy:
  1. iShares IWV CSV: `https://www.ishares.com/us/products/239714/ishares-russell-3000-etf/1467271812596.ajax?fileType=csv&fileName=IWV_holdings`
  2. If fails: S&P 1500 (sp500 + sp400 + sp600 from Wikipedia via existing `universe_service` pattern)
  3. If fails: sp500 only
  Each fall-through writes a `universe_load_log` row + WARNING log line. Acceptance: ≥ 2900 tickers, OR halt with `data/.halt` and exit. [subagent: builder-B1-B5]
- [ ] **B.2** 🟢 `app/research/builders/price.py` — fetch OHLCV via `market_data_service.get_candles`; compute `close, prev_close, open_today, high_today, low_today, ret_1d, ret_5d, ret_20d, atr_14, dollar_volume, gap_pct`. [subagent: builder-B1-B5]
- [ ] **B.3** 🟢 `app/research/builders/technical.py` — call `technical_analysis_service.analyze`, extract from `.indicators` list: `rsi_14, macd_hist, bb_pos`. Compute `ema_distance_50, ema_distance_200` from raw candles in this builder (existing service uses 9/21 EMA only). NULL `mtf_alignment_pct, trend_score` until B.3a derives them via `multi_timeframe.py`. [subagent: builder-B1-B5]
- [ ] **B.3a** 🟡 (post-B.3) Read `app/services/multi_timeframe.py`; derive `mtf_alignment_pct, trend_score` if achievable in <1hr; otherwise document and leave NULL.
- [ ] **B.4** 🟢 `app/research/builders/levels.py` — call `volume_profile_service.analyze`, derive `poc_distance, value_area_position, near_resistance, near_support, distance_to_resistance, distance_to_support, consolidation_score, accumulation_score, breakout_distance`. [subagent: builder-B1-B5]
- [ ] **B.5** 🟢 `app/research/builders/news.py` — call `NewsAggregator().scan_all_sources([symbol])` for current-day; for snapshots > 7d old, NULL `news_*` columns and write a row to `snapshot_news` flagged as historical-skip. Persist raw items into `snapshot_news` for current-day. **Filter by `published_at < snapshot_as_of`.** [subagent: builder-B1-B5]
- [ ] **B.6** 🟢 `app/research/builders/options.py` — for current-day: call `options_service.analyze(symbol)`. For historical: NULL all columns + log "options historical not in subscription". [subagent: builder-B6-B9]
- [ ] **B.7** 🟢 (depends A.6) `app/research/builders/macro.py` — fetch VIX/DXY/10Y via `market_data_service` for index symbols; sector via `ticker_info`; regime via `RegimeMatcherService.compute_fingerprint` → adapter mapping 6-element fingerprint to `regime_label` string. [subagent: builder-B6-B9]
- [ ] **B.8** 🟢 (depends A.6) `app/research/builders/analyst.py` — STUB (NULL all columns, log "phase B"). Real implementation lands after core works. [subagent: builder-B6-B9]
- [ ] **B.9** 🟢 (depends A.6) `app/research/builders/calendar_features.py` — call `calendar_service` for `earnings_in_n_days, earnings_surprise_last`. [subagent: builder-B6-B9]
- [ ] **B.10** 🔴 `app/research/snapshot_builder.py` — orchestrator: takes (ticker, date, time), calls all builders concurrently with `asyncio.gather`, each wrapped in `asyncio.wait_for(timeout=30s)`. Per-builder try/except → NULL on failure. Writes one transaction with `INSERT ... ON CONFLICT DO UPDATE` + checkpoint row.
- [ ] **B.11** 🔴 Unit-style smoke: build 1 snapshot for SPY today; print row; verify in DB
- [ ] **B.12** 🔴 Commit EPIC B

**Parallelization:** B.1, B.2, B.3, B.4, B.5 run in parallel (independent files) under [subagent: builder-B1-B5]. B.6, B.7, B.8, B.9 run in parallel under [subagent: builder-B6-B9] (after A.6 lands). B.10 orchestrator depends on all.

**Acceptance:** `python -m app.research.cli backfill --tickers SPY --since 2026-04-23 --until 2026-04-24` writes 2 rows to `universe_snapshots` with price/technical/levels/macro columns populated; news populated for current-day only.

### EPIC C — Forward returns + IC math (parallel with B, after A)

Goal: Once snapshots exist + dates have aged, fill `fwd_ret_*` and compute Spearman IC per feature.

- [ ] **C.1** 🟢 `app/research/forward_returns.py` — for snapshots aged ≥1d, fetch fwd close via `market_data_service`, compute `fwd_ret_1d, fwd_ret_5d, fwd_ret_20d, hit_stop_5pct, hit_target_10pct`. Idempotent UPDATEs. [subagent: math-C1]
- [ ] **C.2** 🟢 `app/research/factor_ic.py` — uses `pandas.read_sql_table` to load `universe_snapshots`; `df.corr(method='spearman', min_periods=200)` per feature column vs `fwd_ret_5d` and `fwd_ret_20d`. Bucketed by `regime_label` slice. NaN-heavy columns logged separately. Writes `factor_ic` rows. [subagent: math-C2]
- [ ] **C.3** 🟡 `app/research/cli.py forward-returns`, `compute-ic` subcommands [subagent: math-C2]
- [ ] **C.4** 🔴 Synthetic-data unit smoke: 100 fake snapshots with known correlation, run forward-returns + IC, verify expected IC > 0.95 for known-good feature, IC ∈ (-0.1, 0.1) for noise
- [ ] **C.5** 🔴 Commit EPIC C

**Acceptance:** Synthetic-data smoke passes; `factor_ic` table populated with at least 1 IC row.

### EPIC E — Smoke test (depends on A, B, C, D — strict serial)

Goal: End-to-end run on 10 tickers × 5 days × 2 snapshots = 100 rows.

- [ ] **E.1** 🔴 Tickers: SPY, QQQ, AAPL, NVDA, AMD, MRK, TSLA, GDX, USO, UVXY
- [ ] **E.2** 🔴 Dates: 2026-04-15, 2026-04-17, 2026-04-21, 2026-04-23, 2026-04-24
- [ ] **E.3** 🔴 Run `cli.py backfill --tickers ... --dates ...`
- [ ] **E.4** 🔴 Validation script: every column-fill rate, RSI ∈ [0,100], sentiment ∈ [-1,1] where present, row count = 100
- [ ] **E.5** 🔴 Run `cli.py forward-returns` (only fills 1d for newest dates), then `compute-ic`
- [ ] **E.6** 🔴 Spot-check: SPY 2026-04-23 row matches manual lookup of OHLCV
- [ ] **E.7** 🔴 **Smoke gate (all four must pass to launch G):**
  1. Fill rate per non-NULL-expected column ≥ 70%
  2. RSI in [0,100] for 100% of rows
  3. IC computation finishes without exception
  4. Total runtime ≤ 30 min
  If any fail, halt, write `docs/plans/results/2026-04-25-blockers.md` with diffs, do NOT launch backfill.
- [ ] **E.8** 🔴 Commit EPIC E with smoke output as an artifact

**Acceptance:** Smoke gate passes OR blockers doc written and execution halts.

### EPIC G — Backfill CLI + checkpointing (depends on E gate passing)

Goal: Resumable, multi-rate-limit-aware backfill loop. Runs as background process.

- [ ] **G.1** 🟢 `app/research/ingest.py` — generator over (ticker, date, time) tuples; consults `ingest_checkpoints`; skips completed; writes checkpoint row in same txn as snapshot. **Disk-space check every 1000 rows; halt if `<10 GB free`.** **Halt sentinel check every iteration: if `data/.halt` exists, exit cleanly.**
- [ ] **G.2** 🟢 `app/research/rate_limit.py` — async semaphores per provider:
  - `polygon=80/s`
  - `yahoo=2/s` (random jitter 0-500ms)
  - `yfinance=3/s`
  - `alpha_vantage=20/day` (hard cap)
  Documented binding-constraint per builder.
- [ ] **G.3** 🟢 `app/research/cli.py backfill --since YYYY-MM-DD --until YYYY-MM-DD --tickers all|sp500|r3k --resume --dry-run` subcommand
- [ ] **G.4** 🟡 `scripts/eval/research_backfill.sh` (`nohup`-able; structured-JSON heartbeat per 1000 rows)
- [ ] **G.5** 🟡 `scripts/eval/research_nightly.sh` (cron: today's snapshots + forward-return fill on aged rows)
- [ ] **G.6** 🟡 `scripts/eval/halt.sh` — touches `data/.halt` sentinel
- [ ] **G.7** 🔴 Resume test: run backfill on 50 tickers, kill after 20, restart, verify it resumes
- [ ] **G.8** 🔴 Commit EPIC G

**Acceptance:** Killing backfill mid-run and restarting resumes from checkpoint without re-fetching completed rows.

### EPIC F — `/agents/eval` dashboard route (depends on C, E; AFTER G backfill is paused or done)

**Plan invariant:** EPIC F edits `main.py`. If `--reload` uvicorn is running, this restarts the server. EPIC F runs serially AFTER any active backfill is paused.

- [ ] **F.1** 🟢 Backend: `app/routers/eval.py` — GET `/api/v1/eval/factor-ic?regime=&horizon=`, GET `/api/v1/eval/coverage`
- [ ] **F.2** 🟢 Backend: register router in `main.py`
- [ ] **F.3** 🟢 Frontend: `frontend/src/lib/eval/api.ts` + `frontend/src/lib/hooks/use-eval.ts` (mirror agents pattern)
- [ ] **F.4** 🟡 Frontend: `frontend/src/app/agents/eval/page.tsx` — IC table with regime + horizon dropdowns, sortable columns
- [ ] **F.5** 🟡 Frontend: link from `/agents` index → `/agents/eval`
- [ ] **F.6** 🔴 Run `bun run api:sync` if it exists; otherwise hand-type the response interface
- [ ] **F.7** 🔴 Commit EPIC F

**Acceptance:** Visiting `https://trading-bot.localhost:1355/agents/eval` shows a sortable IC table with at least 1 row from smoke test.

### EPIC H — Final commit + summary

- [ ] **H.1** 🔴 Update CLAUDE.md "Active plans" entry status: in-flight → infrastructure complete; smoke test passing; full backfill runnable
- [ ] **H.2** 🔴 Capture run metrics in `docs/plans/results/2026-04-25-eval-suite-results.md` — rows ingested, IC headlines, agent-bias findings from D.7
- [ ] **H.3** 🔴 Final commit

---

## Parallelization graph (v2 — D moved before B/C)

```
PRE.1..PRE.6 (done) ─→ PRE.7 (commit plan v2)
                             │
                             ▼
                    EPIC A (skeleton)
                  A.1..A.5 parallel
                  A.6 (subagent: contract-reader, BLOCKING for B.7/B.8/B.9)
                  A.7 → A.8 commit
                             │
                             ▼
            ┌────────────────┼────────────────┐
            ▼                ▼                ▼
       EPIC D            EPIC B           EPIC C
   (highest insight)  (after A.6)     (independent of B)
   D.1..D.3 parallel  B.1..B.5 (sub: B1-B5)   C.1, C.2 (sub: math)
   D.4..D.5 parallel  B.6..B.9 (sub: B6-B9)   C.3 → C.4 → C.5 commit
   D.6 → D.7 → D.8    B.10 → B.11 → B.12
            │                │                │
            └────────────────┼────────────────┘
                             ▼
                       EPIC E (smoke gate, serial)
                             │
                             ▼
                       (gate passes?)
                             │
                             ▼
                       EPIC G (backfill CLI)
                             │
                             ▼
              [optional pause: kick off background backfill]
                             │
                             ▼
                       EPIC F (dashboard route — needs server restart)
                             │
                             ▼
                       EPIC H (final)
```

---

## Storage estimate (unchanged from v1)

3000 tickers × 60 trading days × 2 snapshots ≈ 360k rows × ~80 cols × ~80 bytes ≈ **2.3 GB** for snapshot table. News + sidecars maybe another 1-2 GB. Comfortable for SQLite at 73 GB free.

## Polygon rate budget (revised)

~5 endpoint calls per snapshot × 360k snapshots = 1.8M calls. At **80 req/sec** (conservative under 100/sec subscription cap, leaves 20% headroom): **~6.3 hours** as one overnight backfill. **Yahoo + yfinance** binding constraints make real-world wall time likely **8-12 hours**.

---

## Safety + ops invariants

- **Backups before any mutation.** Done in PRE.1.
- **No git stash, no destructive resets.** Modified files in working tree (unrelated to this plan) remain untouched. Commits during this work touch ONLY new files.
- **Add files only, no deletes.** Legacy `.bak` files MOVED (not deleted) in PRE.6.
- **Commit per epic.** Every epic ends with a commit.
- **Read-only access to existing DBs.** Pipeline NEVER writes to `app.db` or `trading_bot.db`. Only `research.db`. Layer 1 catalogue reads `app.db` via `mode=ro` URI. Safety asserter in `research/db.py` enforces this.
- **Resumability.** Backfill + catalogue use checkpoint tables.
- **Multi-rate-limit ceiling.** Per-provider semaphores (Polygon 80/s, Yahoo 2/s, yfinance 3/s, AV 20/day).
- **PII / secrets.** No API keys printed in logs. `.env` gitignored — verified.
- **Halt sentinel.** `data/.halt` written by `scripts/eval/halt.sh`; checked by backfill loop every iteration.
- **Disk monitoring.** Backfill checks `<10 GB free` every 1000 rows; auto-halts.
- **Per-builder timeouts.** 30s `asyncio.wait_for` wrap; on timeout, NULL the column.
- **WAL pragmas.** `journal_mode=WAL; busy_timeout=10000; synchronous=NORMAL`.
- **EPIC F serial after G pauses.** `main.py` edit must not happen during active backfill.

---

## Tying back to the agent (Phase D — original Phase D, runs after E + F land)

For each historical agent decision (Layer 1):
1. Look up snapshot in `universe_snapshots` for (symbol, decision_date, nearest_snapshot_time)
2. Compute *expected* decision from EPIC C factor model
3. Score the agent's decision two ways:
   - **Agent gap from optimal-given-its-context**: did it use what it had well?
   - **Information gap**: were there factors with high IC the agent never queried?

Becomes a follow-up plan once IC numbers are real.

---

## Phase 2 — Sidecar suites + cross-correlation (deferred)

- **Reddit suite** (next): use telegram-claude-code reddit jobs as ingestion source
- **Unusual Whales suite**: harvest UW data
- **Copy-trader suite**: same
- **Cross-correlation**: `alt_signal_correlations` table
- **`factor_clusters` (k-means)**: deferred from v1

---

## Known limitations (v1)

1. **Survivorship bias** — current Russell 3000 members only.
2. **News coverage gaps** — Yahoo decent but not exhaustive; AV 25/day cap; Polygon news endpoint = Phase B.
3. **Snapshot timing** — fixed 8:30 ET / 12:30 ET.
4. **No options historical** — Polygon options not in subscription; yfinance live-only.
5. **Forward-return horizon limits** — first 20 days can only score on `fwd_ret_5d`.
6. **Russell 3000 loader fragility** — iShares CSV → S&P 1500 → sp500 fallback chain.
7. **Analyst data** — STUB in v1.
8. **Look-ahead bias on news** — Yahoo `ticker.news` has no historical query; news columns NULL for snapshots > 7d old.
9. **`mtf_alignment_pct`, `trend_score`** — NULL until B.3a confirms `multi_timeframe.py` derivation.

---

## Open questions

1. **Sidecar suite ordering after Reddit:** UW or copy-trader next? Defer.
2. **Russell 3000 source if iShares CSV fails:** Documented fallback chain in B.1.

---

## Out of scope (defer)

- Intraday snapshot resolution finer than 2x/day
- Survivorship-bias-adjusted universe
- Full multi-year history
- Real-money execution
- Live IC streaming
- `factor_clusters` k-means
- Polygon news endpoint wiring (Phase B follow-on)
