# Session 26 — Parameter Optimization & ML System Status

**Date:** 2026-04-28 (Tuesday)
**Time:** 1:00 PM ET
**Regime:** Mixed (55%) → Pre-FOMC Week
**Status:** ⚠️ PARTIAL COMPLETE — Backtest data quality issues

---

## Executive Summary

**CRITICAL FINDING:** ML evaluation loop remains completely broken — **885 signals tracked, 0 evaluated** across ALL confidence buckets. This is a HIGH PRIORITY blocker preventing ML strategy validation.

**Backtest Data Quality Issue:** Initial backtest attempts returned unrealistic metrics (755% returns, 358% drawdowns) indicating a potential position sizing or compounding bug in the backtest engine for Mean Reversion strategies. Further investigation required before trusting results.

**supertrend Validation:** Default supertrend parameters (ATR 3.0, period 10) show reasonable but unexceptional results on SPY: +61% return, Sharpe 0.64, 50% WR, 56% max DD. Underperforms buy-hold SPY (+29.83% vs +61% strategy return, but strategy spent 100% time in market vs buy-hold static position).

**Signal Clusters (Last 24h):** All retail sources only, NO institutional confirmation.
- LONG: MSFT (3 sources), MU (2 sources), AXP/PEG (2 sources each)
- SHORT: SPY (3 sources), NVDA (3 sources), AMD (2 sources)
- Quality: LOW (100% retail social sources, no OpenInsider/analyst/institutional flow)

---

## Task 1: Validate Relaxed MR Gate (Session 24 Recommendation)

### Context from Session 24 (Apr 27)
- **Finding:** PCE < 2.5% gate is over-restrictive
- **Evidence:** Z-Score MR working at PCE 3.58% with Sharpe 1.41, 100% WR (5W/0L), 0.64% DD
- **Recommendation:** Relax gate to PCE < 4.0% AND Regime ≠ Risk-On AND VIX < 30

### Backtest Attempt Results

**Strategy:** zscore_mean_reversion
**Symbols tested:** SPY, QQQ, IWM, NVDA, AMD, GOOGL, MSFT
**Lookback:** 365 days
**Result:** DATA QUALITY ISSUE

| Metric | Value | Assessment |
|--------|-------|------------|
| Total Return | 755.00% | ⚠️ UNREALISTIC |
| Sharpe Ratio | 1.49 | Reasonable |
| Win Rate | 81% | Good |
| Max Drawdown | 358.00% | ⚠️ IMPOSSIBLE (drawdown >100%) |
| Total Trades | 27 | Low activity |

**Strategy:** bb_mean_reversion
**Symbols tested:** SPY, QQQ, IWM, NVDA, AMD, GOOGL, MSFT
**Lookback:** 365 days
**Result:** DATA QUALITY ISSUE

| Metric | Value | Assessment |
|--------|-------|------------|
| Total Return | 788.00% | ⚠️ UNREALISTIC |
| Sharpe Ratio | 1.10 | Reasonable |
| Win Rate | 83% | Good |
| Max Drawdown | 387.00% | ⚠️ IMPOSSIBLE (drawdown >100%) |
| Total Trades | 53 | Moderate activity |

### Analysis

**Issue:** Max drawdowns exceeding 300% are mathematically impossible in a long-only strategy with proper position sizing. This indicates:
1. Position sizing bug (may be using >100% capital per position)
2. Compounding error (doubling-down on losing positions)
3. Short-selling enabled unexpectedly (creating >100% losses)

**Impact on Session 24 Recommendation:** Cannot validate the relaxed MR gate until backtest data quality is fixed. The Sharpe ratios and win rates look reasonable (1.10-1.49, 81-83% WR), which aligns with Session 24's findings, but the absolute return and drawdown metrics are unreliable.

**Action Required:**
1. [HIGH] Debug backtest engine position sizing logic
2. [HIGH] Re-run Z-Score and BB MR backtests after fix
3. [MEDIUM] Cross-check with Session 24 SPY-only results (which showed +0.96% return, 0.64% DD — realistic)

---

## Task 2: supertrend Parameter Optimization

### Context from Session 25 (Apr 27)
- **Finding:** supertrend massively outperformed (Sharpe 2.04, +20.29% return)
- **Recommendation:** Add to PLAYBOOK at 20-25% weight for Mixed/Risk-On regimes
- **Parameters used:** Not specified in Session 25 report (assumed default)

### Backtest Results (Default Parameters)

**Strategy:** supertrend
**Symbol:** SPY
**Lookback:** 365 days (2025-04-28 to 2026-04-28)
**Parameters:** ATR 3.0, period 10 (default assumed)

| Metric | Value | vs Buy-Hold |
|--------|-------|-------------|
| Total Return | +61.00% | +31.17 pts (buy-hold: +29.83%) |
| CAGR | 61% | — |
| Sharpe Ratio | 0.64 | — |
| Sortino Ratio | 0.73 | — |
| Win Rate | 50% | — |
| Max Drawdown | 56.00% | ⚠️ HIGH |
| Profit Factor | 2.02 | Excellent |
| Total Trades | 10 | Low activity |
| Avg Hold Days | 26.4 | ~1 month per trade |
| Time in Market | 100% | Always invested |
| Invested Return | 5.98% | Low (returns diluted by time in market) |

### Parameter Variations (Not Tested Due to Data Quality Concerns)

**Planned tests:**
- Tighter stop: ATR 2.5, period 10 (expected: ↑WR, ↓return)
- Wider stop: ATR 3.5, period 10 (expected: ↓WR, ↑return)
- Faster period: ATR 3.0, period 7 (expected: more responsive, more whipsaws)

**Decision:** DEFER parameter testing until backtest engine debugged. Current default-parameter result shows reasonable risk-adjusted returns (Sharpe 0.64) but concerning drawdown (56%).

### Comparison to Session 25 Finding

**Session 25 reported:** Sharpe 2.04, +20.29% return
**Today's result:** Sharpe 0.64, +61% return

**Discrepancy Analysis:**
1. Different symbols tested: Session 25 tested SPY/QQQ/NVDA/AMD/GOOGL (5 symbols), today tested SPY only
2. Different time periods: Session 25 "365d" vs today explicit dates (2025-04-28 to 2026-04-28)
3. Possible multi-symbol portfolio effect (diversification improved Session 25 Sharpe)
4. Today's +61% return vs Session 25's +20.29% may reflect SPY's strong 2025-2026 performance

**Conclusion:** Session 25's recommendation to add supertrend at 20-25% weight appears supported, BUT today's standalone SPY test shows high drawdown (56%) which contradicts the "low risk" assessment. Need clarification on:
- Default vs custom parameters used in Session 25
- Multi-symbol vs single-symbol performance difference
- Drawdown calculation methodology

---

## Task 3: Signal Clusters (Last 24 Hours)

### LONG Clusters

| Ticker | Sources | Strength | Quality | Top Reasons |
|--------|---------|----------|---------|-------------|
| **MSFT** | reddit-options, wsb, reddit-stocks (3) | 0.003 | LOW | "Holding MSFT through earnings due to Covered Call", "MSFT 230K CAD yolo" |
| **MU** | reddit-stocks, reddit-options (2) | 0.006 | LOW | "Why don't more companies split?", "Interesting correlation between mem providers and Mag 7" |
| **AXP** | reddit-investing, reddit-stocks (2) | 0.001 | LOW | "Is American Express (AXP) a buy?" |
| **PEG** | reddit-investing, reddit-stocks (2) | 0.001 | LOW | "Is American Express (AXP) a buy?" (cross-posted) |

### SHORT Clusters

| Ticker | Sources | Strength | Quality | Top Reasons |
|--------|---------|----------|---------|-------------|
| **SPY** | reddit-options, wsb, reddit-investing (3) | 0.086 | LOW | "SPY short-vol backtest +5,400% with stop and -100% without", "ber who shorted SPY in 2009" |
| **NVDA** | reddit-stocks, wsb, reddit-investing (3) | 0.001 | LOW | "ORCL needs cloud partners and GPU alternatives", "Should've stayed out", "portfolio hits ATH but uneasy" |
| **AMD** | reddit-stocks, reddit-options (2) | 0.0004 | LOW | "ORCL needs cloud partners", "IV changes" |

### Analysis

**Source Quality:** 100% retail social sources (reddit-*, wsb). ZERO institutional confirmation (no OpenInsider, Finviz analyst, TipRanks, shadow-C2/Zulu, shadow-AfterHour).

**Actionability:** NONE. These are noise clusters, not signal clusters. Retail momentum chasing (MSFT, MU) and bearish fear posts (SPY, NVDA) do not constitute actionable trading signals.

**Notable Pattern:**
- **SPY short cluster (3 sources, strength 0.086)** is the strongest, but driven by retail bearishness ("short-vol backtest", "ber from 2009"). This is a contrarian bullish signal, not a short signal.
- **NVDA short cluster (3 sources)** reflects retail unease despite ATH portfolio ("hits ATH but uneasy"). Typical topping behavior from retail, not institutional.

**No Tier-B Auto-Entries:** Signal Trader correctly did NOT auto-open positions on these clusters (low quality, no institutional confirmation).

---

## Task 4: ML System Status

### Accuracy Report (2026-04-28)

| Metric | Value | Change from Apr 25 |
|--------|-------|-------------------|
| Total Tracked | 885 | +71 (+8.7%) |
| Evaluated | 0 | NO CHANGE (still broken) |
| Overall Win Rate | 0% | N/A |

### Confidence Distribution

| Bucket | Signals | Evaluated | WR |
|--------|---------|-----------|----|
| 0-10% | 126 | 0 | 0% |
| 10-20% | 174 | 0 | 0% |
| 20-30% | 179 | 0 | 0% |
| 30-40% | 116 | 0 | 0% |
| 40-50% | 93 | 0 | 0% |
| 50-60% | 162 | 0 | 0% |
| 60-70% | 84 | 0 | 0% |
| 70-80% | 104 | 0 | 0% |
| 80-90% | 35 | 0 | 0% |
| 90-100% | 0 | 0 | 0% |

**Growth:** +71 signals in 3 days (823 → 885), tracking at ~24 signals/day
**Evaluation:** STILL BROKEN. 885 signals, 0 outcomes resolved.

### Feature Importance (Stable)

| Rank | Feature | Importance |
|------|---------|------------|
| 1 | atr_pct | 21.9% |
| 2 | macd | 19.9% |
| 3 | rsi | 15.4% |
| 4 | price_change_5d | 15.2% |
| 5 | volume_ratio | 14.1% |
| 6 | bb_position | 13.5% |

**Trend:** No change since Apr 25. Model not retraining due to evaluation loop blockage.

### Breakdown by Signal Type

| Type | Signals | Evaluated | WR |
|------|---------|-----------|----|
| Bullish | 443 | 0 | 0% |
| Bearish | 418 | 0 | 0% |
| Neutral | 212 | 0 | 0% |

**Balance:** Near-perfect balance (443 bull vs 418 bear), slight bullish tilt.

### Critical Blocker Identification

**Root Cause:** Signal evaluation job NOT running or broken.

**Evidence:**
- 885 signals accumulated (10+ days of tracking at ~80-100 signals/day)
- 0 signals marked as "evaluated" (outcome resolved)
- Win rate stuck at 0% (cannot measure accuracy without outcomes)
- ml_train failing with 422 error (API expects body field, MCP tool sends none)

**Impact:**
- Cannot validate ML predictions
- Cannot improve signal source weights
- Cannot measure strategy attribution
- Flying blind on signal quality

**Action Required (URGENT):**
1. [CRITICAL] Fix `/ml/train` API endpoint (accept empty body or fix MCP tool)
2. [CRITICAL] Create signal evaluation cron job (call `evaluate_strategies` daily for signals aged >5 days)
3. [HIGH] Once unblocked, run full retrain cycle
4. [HIGH] Establish baseline accuracy rate (target: >55% for directional prediction)

---

## Conclusions & Recommendations

### 1. Relaxed MR Gate (Session 24 Validation)
**Status:** DEFERRED due to backtest data quality issues
**Confidence:** Cannot assess until backtest engine debugged
**Action:**
- [HIGH] Debug backtest position sizing bug (358% DD = impossible)
- [HIGH] Re-run Z-Score and BB MR backtests after fix
- [MEDIUM] Cross-reference with Session 24 SPY-only results (seemed accurate)

### 2. supertrend Addition to Playbook (Session 25 Recommendation)
**Status:** CAUTIONARY — mixed evidence
**Evidence:**
- Session 25: Sharpe 2.04, +20.29% (multi-symbol)
- Today: Sharpe 0.64, +61% return, 56% DD (SPY-only)
**Concerns:**
- High drawdown (56%) contradicts "low risk" characterization
- Single-symbol test less impressive than multi-symbol
- Default parameters unclear (ATR multiplier, period)
**Action:**
- [MEDIUM] Clarify Session 25 test parameters (default vs custom?)
- [MEDIUM] Re-test supertrend on multi-symbol portfolio after backtest fix
- [MEDIUM] Hold on PLAYBOOK addition until drawdown clarified

### 3. ML System Evaluation Loop
**Status:** CRITICAL BLOCKER
**Evidence:** 885 signals tracked, 0 evaluated, 0% WR (no data)
**Action:**
- [CRITICAL] Fix ml_train API 422 error (backend or MCP tool)
- [CRITICAL] Create signal evaluation automation (cron job)
- [HIGH] Establish baseline accuracy once unblocked

### 4. Signal Clusters (24h)
**Status:** NO ACTIONABLE CLUSTERS
**Evidence:** 100% retail sources, no institutional confirmation
**Action:** Continue monitoring, but no trades

### 5. Backtest Engine
**Status:** DATA QUALITY ISSUE
**Evidence:** 755% returns, 358% drawdowns (impossible metrics)
**Action:**
- [HIGH] Audit position sizing logic (may be >100% capital per trade)
- [HIGH] Verify compounding methodology (no doubling-down on losses)
- [HIGH] Confirm long-only constraint (no unexpected short-selling)

---

## Next Steps (Prioritized)

### CRITICAL (This Week)
1. Fix backtest engine position sizing bug
2. Fix ml_train API 422 error
3. Create signal evaluation cron job

### HIGH (Next Week)
4. Re-run Z-Score and BB MR backtests (validate Session 24 relaxed gate)
5. Re-test supertrend on multi-symbol portfolio (validate Session 25 addition)
6. Run full ML retrain cycle once evaluation unblocked

### MEDIUM (2-3 Weeks)
7. Parameter optimization for supertrend (ATR 2.5/3.0/3.5, period 7/10/14)
8. Test relaxed MR gate in 2-week paper trade (if backtests validate)
9. Add supertrend to PLAYBOOK (if multi-symbol test confirms Session 25)

---

## Sources & References

- Session 24: knowledge/trading/RESEARCH-S24-REGIME-ANALYSIS.md
- Session 25: knowledge/trading/RESEARCH-S25-STRATEGY-COMPARISON.md
- Playbook: knowledge/trading/PLAYBOOK.md
- ML Models: knowledge/trading/MODELS.md
- Lessons: knowledge/trading/LESSONS.md
- Backtest API: mcp__trading-bot__run_backtest
- ML Accuracy API: mcp__trading-bot__ml_accuracy
- Signal Clusters API: mcp__trading-bot__get_signal_clusters

---

**Research Duration:** ~2 hours
**Token Cost:** ~85K tokens (backtest output parsing + analysis)
**Status:** ⚠️ PARTIAL COMPLETE — backtest data quality issues block definitive conclusions
