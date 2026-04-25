# Trading Eval + Research Suite — Run Results

**Date:** 2026-04-25
**Run mode:** Autonomous (multi-epic, single session, frequent commits, no destructive ops)
**Plan v2:** [2026-04-25-trading-eval-and-research-suite.md](../2026-04-25-trading-eval-and-research-suite.md)

---

## Status

**Infrastructure: COMPLETE.** All 7 epics (A → H) shipped. Smoke gate passed.
Full Russell 3000 backfill is **runnable but not yet kicked off** (next user
decision — single command + nohup).

| EPIC | Status | Commit |
|---|---|---|
| PRE — backups + plan v2 | ✅ done | `00f3d69` (telegram-claude-code) |
| A — package skeleton + db init | ✅ done | `5999610` (trading-bot) |
| D — Layer 1 agent context catalogue (extractor v2) | ✅ done | `8d44525` + `8effff5` |
| B — snapshot builder smoke (SPY) | ✅ done | `9cd8ced` |
| C — synthetic IC unit smoke PASS | ✅ done | `54f2392` |
| E — 100-row smoke test PASS gate | ✅ done | `152e483` (results doc) |
| G — backfill scripts + resume/halt verified | ✅ done | `12fe725` |
| F — /agents/eval dashboard route | ✅ done | `c98f0cb` |

---

## Backups (PRE.1) — preserved + verified

```
~/db-backups/2026-04-25/
  app.db.bak-20260425-181733            144 MB  sha256: d86793d177b07bd685bc49f0e5e164c824aed411ec02ba7779dafed9481ec0ac
  trading_bot.db.bak-20260425-181733    2.4 GB  sha256: 22618a646ccabb712c113a8ddf2ae8deffa3726600a9e6dbffa82e8be3546018
  MANIFEST-20260425-181733.txt
~/db-backups/legacy-pre-2026-04-25/telegram-claude-code-data/
  7 legacy .bak files (~739 MB) MOVED here from data/ — preserved, not deleted
```

---

## Plan reviewer outcomes

Two parallel reviewer subagents (architecture rigor + risk/failure modes)
analyzed plan v1. Consensus surfaced:

- **3 blockers fixed**: Russell 3000 source (iShares IWV CSV; Wikipedia page does
  not exist), technical_analysis service column gap (per-column derivation
  enumerated), CLI framework lock to argparse (typer not in pyproject).
- **4 additional blockers fixed**: A.6 promoted to strict-serial (services_contract.md
  artifact required before B.7/B.8/B.9), disk-pressure precheck (PRE.6 + per-1000
  row check), Layer 1 scope corrected to 7,584 files (not 158) with
  Russell-3000-set-intersection + finance-keyword filter, Yahoo no-historical-news
  documented as known limitation.
- **12 risks mitigated**: per-provider rate semaphores, ResearchBase metadata
  isolation, pandas Spearman with min_periods, JSONL multi-source parser,
  idempotent INSERT ON CONFLICT, smoke gate with explicit pass/fail rules,
  asyncio.wait_for(30s) per builder, WAL pragmas, EPIC F serial after backfill
  quiesces, etc.
- **Suggestions adopted**: cut factor_clusters from v1, structured JSON logging,
  --dry-run mode, db.py safety asserter, EPIC D before B/C (highest insight
  per hour), halt sentinel.

---

## Layer 1 (agent context catalogue) findings — already real signal

500 sessions cataloged (158 trading-job-linked) before Layer 2 even ran:

- `mcp__trading-bot__market_scan`: 1,455 calls (most-used tool)
- `WebSearch`: 912 calls — **NOT** the prior "8 across all sessions" claim
- Symbol bias: healthcare (JNJ, MRK, ABBV, GILD) + energy (XOM, HAL, VLO) +
  dividend names (T, AMT) — confirms "stale playbook" hypothesis
- `REGIME.md` is the most-read knowledge file (65 reads); `JOURNAL.md` is read
  only 13 times in 500 sessions (lessons-not-consulted finding)
- Alpha Researcher (job 39) is the most active job; Strategy Reviewer (job 37)
  is the rarest (4 sessions in last 500)

Detail: [2026-04-25-layer1-findings.md](2026-04-25-layer1-findings.md)

---

## Layer 2 (universe snapshots) — 100-row smoke

10 tickers × 5 dates × 2 snapshots = 100 rows in 37s, 0 errors.

Top IC numbers (n=60, horizon=1d, regime=all):

| Feature | IC |
|---|---:|
| distance_to_support | 0.288 |
| ema_distance_50 | 0.231 |
| ema_distance_200 | 0.231 |
| macd_hist | 0.228 |
| gap_pct | -0.182 |
| rsi_14 | 0.175 |
| bb_pos | 0.151 |

Smoke gate: avg fill rate 84.7% (≥70% ✓), RSI ∈ [37.17, 88.94] (✓),
IC computation 24 rows no exception (✓), runtime 37s (≤30 min ✓).

Detail: [2026-04-25-smoke-test-results.md](2026-04-25-smoke-test-results.md)

---

## Dashboard route live

`https://trading-bot.localhost:1355/agents/eval` — sortable IC table with
horizon (1d/5d/20d) and regime (all/Risk-On/Mixed/Risk-Off) filter chips.
Shows Universe (2584 tickers, hash 0fd72e5b), 100 snapshots stored across
5 dates, 100 done checkpoints.

---

## What's NOT done (deferred / open for next session)

1. **Full Russell 3000 backfill** — runnable via:
   ```bash
   cd trading-bot/backend
   nohup bash scripts/eval/research_backfill.sh > data/backfill.log 2>&1 &
   tail -f data/backfill.log
   ```
   Estimated wall time 6–12 hours. Use `bash scripts/eval/halt.sh` to stop
   cleanly.

2. **Polygon news + analyst endpoints** (Phase B). Current news is current-day
   only via Yahoo + AV; analyst columns are STUB.

3. **Earnings provider** (yfinance.Ticker.earnings_dates wrapper) — needed
   for `earnings_in_n_days` and `earnings_surprise_last`.

4. **Macro VIX/DXY/TNX** — Polygon doesn't accept ^VIX/^TNX prefixes; needs
   either a yfinance-backed builder for these or a Polygon-equivalent ticker
   table.

5. **mtf_alignment_pct, trend_score** — `multi_timeframe.py` is hard-coded to
   "now"; needs an as_of_date param to backfill historical snapshots.

6. **factor_clusters (k-means)** — DEFERRED to Phase 2 by design.

7. **Phase D (agent eval)** — once Layer 2 has more data, scoring agent
   decisions against high-IC factors becomes meaningful. Replay harness with
   stub MCP server.

8. **Phase 2 sidecar suites** — Reddit, Unusual Whales, copy-trader. Each as
   its own corpus + eval. Cross-correlation table for leading/lagging analysis.

---

## Safety invariants — all upheld

- ✅ DBs backed up with sha256 manifest BEFORE any work
- ✅ No `git stash`, no `git reset --hard`, no destructive ops used
- ✅ No files deleted (legacy `.bak` files MOVED to `~/db-backups/legacy-pre-2026-04-25/`)
- ✅ research.db is the ONLY DB written by the new code
- ✅ Safety asserter in `app/research/db.py` refuses to open any URL not
  containing `research.db`
- ✅ Layer 1 reads `app.db` via `sqlite3:///?mode=ro` URI
- ✅ Halt sentinel + 30s per-builder timeouts + WAL pragmas + per-provider
  rate semaphores all implemented and verified
- ✅ Frequent commits (8 commits across 2 repos)
- ✅ Disk space monitored — ingest auto-halts if <10 GB free

---

## Quick commands for next session

```bash
# Universe + cataloging refresh
cd trading-bot/backend
uv run python -m app.research.cli universe-load
uv run python -m app.research.cli catalogue-traces --max-sessions 500

# Smoke (re-runnable)
uv run python -m app.research.cli backfill \
  --tickers SPY,QQQ,AAPL,NVDA,AMD,MRK,TSLA,GDX,USO,UVXY \
  --dates 2026-04-15,2026-04-17,2026-04-21,2026-04-23,2026-04-24
uv run python -m app.research.cli forward-returns --min-age-days 1 --horizons 1d 5d
uv run python -m app.research.cli compute-ic --min-periods 50

# Full backfill (background, 6-12 hours)
nohup bash scripts/eval/research_backfill.sh > data/backfill.log 2>&1 &

# Stop cleanly
bash scripts/eval/halt.sh

# Inspect
sqlite3 backend/data/research.db "SELECT * FROM factor_ic ORDER BY ABS(ic_spearman) DESC LIMIT 20;"

# View
open https://trading-bot.localhost:1355/agents/eval
```
