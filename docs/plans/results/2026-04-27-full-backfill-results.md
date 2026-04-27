# Full Russell 3000 Backfill — Results

**Run start:** 2026-04-26 22:18 EDT (resumed at 22:23 after lock-fix patch)
**Run end:** 2026-04-26 01:50 EDT (next day)
**Wall time:** 3h 26m elapsed
**Plan:** [2026-04-25-trading-eval-and-research-suite.md](../2026-04-25-trading-eval-and-research-suite.md) v2

---

## Run summary

| Metric | Value |
|---|---:|
| Rows planned | 335,920 |
| Rows processed (this run) | 331,072 |
| Rows already done (from smoke + 1st backfill attempt) | 4,848 |
| **Total `universe_snapshots` rows** | **335,970** |
| Errors (snapshot persist) | 0 |
| Sustained throughput | 26.7 / sec |
| Polygon API calls (estimated) | ~1.8 M |
| Tickers covered | 2,584 (iShares IWV CSV, hash `0fd72e5b4e2895bf`) |
| Trading days covered | 65 (2026-01-25 → 2026-04-25) |
| Snapshot times | premarket (12:30 UTC) + midday (16:30 UTC) |
| `research.db` size | 271 MB (well under the 2.3 GB estimate — analyst/options NULLs save space) |

---

## Issues encountered + fixes applied during the run

1. **SQLite `database is locked`** at ~2.7 k rows. Caused by 20 concurrent rows × 8 builders all writing to the same SQLite file under the prior 10 s `busy_timeout`.
   - Fix (committed, then resumed): bump `PRAGMA busy_timeout=10000 → 30000`; add 5-attempt exponential backoff (0.25/0.5/1/2/4 s, jittered) around the persist transaction in `snapshot_builder.py`. After the fix: **0 errors across the remaining 333 k rows.**
2. **NullPool connection-close race** (1 occurrence) — benign: data write itself succeeded, only the connection cleanup logged a traceback.
3. **`yahoo_news` curl_cffi fetch errors** (sporadic) — also benign: news columns NULL'd, snapshot continues.

No data was lost. Halt sentinel + resume worked exactly as designed (4,848 already-done rows skipped on resume).

---

## Forward-returns fill

Wall time: ~7.5 h (mostly stuck on the ~103 tickers Polygon doesn't cover, falling back to slow yfinance per-call).

| Column | Filled | % |
|---|---:|---:|
| `fwd_ret_1d` | 322,624 | 96.0 % |
| `fwd_ret_5d` | 291,825 | 86.9 % |
| `fwd_ret_20d` | 179,094 | 53.3 % (older snapshots only — by design, last 20d can't compute it yet) |

Aborted forward-returns at 96% rather than wait for the long tail of yfinance fallback. The 13,346 missing rows are concentrated on ~103 tickers with Polygon ticker-format mismatches (e.g. `BRK.B` exists at Polygon as `BRK.B` but our IWV CSV gave `BRKB`; futures contracts like `ESM6`; etc.). Easy to top up later with a ticker-symbol normalization pass.

---

## IC computation

**Wall time:** 9.1 seconds (pandas read_sql + Spearman corr in memory).

Output: **160 IC rows** in `factor_ic` table, across 4 regime buckets (`all`, `Risk-On`, `Mixed`, `Risk-Off`) × 3 horizons (`1d`, `5d`, `20d`) × ~13 features per slot.

### Top 20 by absolute IC magnitude (regime = all)

| Feature | Horizon | IC | n |
|---|---|---:|---:|
| `bb_pos` | 20d | -0.107 | 178,180 |
| `gap_pct` | 20d | -0.103 | 179,080 |
| `ret_5d` | 20d | -0.096 | 179,014 |
| `ret_5d` | 5d | **+0.096** | 291,733 |
| `rsi_14` | 20d | -0.088 | 178,180 |
| `bb_pos` | 5d | +0.086 | 290,480 |
| `ret_1d` | 20d | -0.075 | 179,080 |
| `ret_20d` | 20d | -0.053 | 178,666 |
| `ema_distance_50` | 20d | -0.053 | 178,180 |
| `macd_hist` | 20d | -0.053 | 178,180 |
| `gap_pct` | 5d | +0.049 | 291,809 |
| `news_7d_count` | 1d | +0.048 | **15,364** (small n — current-day only) |
| `bb_pos` | 1d | +0.041 | 321,187 |
| `ret_5d` | 1d | +0.035 | 322,518 |
| `macd_hist` | 5d | -0.034 | 290,480 |
| `ret_1d` | 5d | +0.033 | 291,809 |
| `rsi_14` | 5d | +0.030 | 290,480 |
| `dollar_volume` | 5d | -0.030 | 291,825 |
| `news_24h_count` | 1d | +0.028 | 15,364 |
| `dollar_volume` | 20d | -0.026 | 179,094 |

### Top 5 IC by regime, 5d horizon

**Risk-On (n=66k each):**
| Feature | IC |
|---|---:|
| `bb_pos` | +0.128 |
| `ret_5d` | +0.110 |
| `rsi_14` | +0.071 |
| `ret_20d` | +0.048 |
| `ema_distance_200` | -0.048 |

**Mixed (n=87k each):**
| Feature | IC |
|---|---:|
| `ret_5d` | +0.130 |
| `macd_hist` | -0.108 |
| `bb_pos` | +0.077 |
| `gap_pct` | -0.075 |
| `ema_distance_50` | -0.060 |

**Risk-Off (n=138k each):**
| Feature | IC |
|---|---:|
| `gap_pct` | **+0.127** |
| `ret_20d` | -0.058 |
| `macd_hist` | -0.050 |
| `ema_distance_200` | +0.047 |
| `ret_5d` | +0.035 |

---

## Headline insights

1. **5d-momentum / 20d-mean-revert split.** `ret_5d` predicts positive 5d returns (IC +0.096) but negative 20d returns (IC -0.096). Same feature, opposite signs by horizon. This is the classic short-momentum, long-reversion pattern from the quant literature, now confirmed in our universe.

2. **`bb_pos` flips sign with horizon.** +0.04 at 1d, +0.09 at 5d, -0.11 at 20d. Buy-the-strength works short-term, fades long-term.

3. **`gap_pct` flips sign with regime.** Risk-Off: gap-ups predict positive 5d returns (IC +0.13). Mixed: gap-downs do better (IC -0.075). If the agent treats gaps the same way across regimes, it's leaving money on the table in either direction.

4. **`bb_pos` is the strongest 5d predictor in Risk-On regimes** (IC +0.128). Combined with `ret_5d` (+0.11), Risk-On is a momentum-friendly environment.

5. **News features are weak but real on 1d horizon.** `news_7d_count` IC +0.048 and `news_24h_count` +0.028 (n only 15k because historical news is NULLed beyond the Yahoo 7-day window — this is a known v1 limitation).

6. **Dollar volume is mildly negative across horizons.** Bigger names underperform smaller ones in this 90-day window (-0.026 to -0.030). Consistent with small-cap outperformance.

7. **`ema_distance_50` and `ema_distance_200` collapse to identical IC** at 20d (both -0.053). Likely highly correlated columns in this 90-day window — should investigate whether to drop one in v2.

---

## What the agent should do differently (for Phase D feed-in)

These are tentative — Phase D (decision replay) will quantify the gap. From these numbers alone:

- **Add gap analysis to the regime playbook.** Right now scans don't condition gap behavior on regime; the `gap_pct` sign flip says they should.
- **Use `bb_pos` as a primary 5d signal in Risk-On** (highest IC of any feature in any regime/horizon slot).
- **Treat 5d momentum and 20d momentum as separate signals**, not the same "trend" concept. Short-trend continuation, long-trend reversion.
- **Currently the agent rarely scans for `news_7d_count` as a standalone feature** — Layer 1 catalogue showed knowledge-file reads but no targeted news-density queries. Add to scanner output template.

---

## What's NOT done (deferred)

1. **`fwd_ret_5d` / `fwd_ret_20d` for the 13 k missing rows** (~103 ticker-mismatch tickers). Easy follow-up: ticker normalization map (BRKB → BRK.B, etc.) + retry.
2. **Conditional IC by sector.** Sector column is mostly NULL because Polygon `ticker_info` returned empty `sector_description` for many tickers — needs a yfinance fallback for sector lookup.
3. **Phase D — agent decision replay.** See below.
4. **Polygon news + analyst endpoints.** Still using Yahoo + AV (current-day only).
5. **Earnings provider** for `earnings_in_n_days` / `earnings_surprise_last`.

---

## Reproducibility

```bash
cd trading-bot/backend
sqlite3 data/research.db "SELECT feature, horizon, regime, ic_spearman, n_observations
                          FROM factor_ic ORDER BY ABS(ic_spearman) DESC LIMIT 20"
open https://trading-bot.localhost:1355/agents/eval
```
