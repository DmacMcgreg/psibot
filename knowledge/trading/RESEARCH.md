# Alpha Research

New strategies, signals, and ideas being explored. Auto-updated by Alpha Researcher.

---

## Session 7 — 2026-03-26 (EOD)

**Status:** Trading bot backend STILL UNREACHABLE (localhost:8000). Web research + market close review.
**Market:** RISK-OFF. S&P -1.58%, VIX 25.33, Brent +3.6% to $106. Tech -3%. Energy +1.6%.
**PAPER TRADE WIN:** XLE closed at $61.56 — TARGET HIT. +10.35% realized.
**PORTFOLIO ALERT:** GE down to $284.32. Stop $279.57 only $4.75 away. CRITICAL.

---

### KEY S7 FINDINGS

#### 1. XLE Paper Trade — CLOSED, WIN ✅

XLE closed at $61.56 on March 26, exceeding the $61.37 target. Intraday high $61.86 (new 52-week high).
- Entry: $55.79 | Exit: $61.56 | Hold: 2 days
- P&L: +$1,034 (+10.35%) on $10,000 position
- Strategy: poc_reversion (PLAYBOOK)
- First closed paper trade. Win rate: 1/1.

#### 2. GE Portfolio Manager — CRITICAL ALERT

GE dropped from ~$310 to $284.32 on March 26 (~8.4% one-day decline). Stop at $279.57 is $4.75 away (1.7%).
- Cause: broad market selloff (-1.58%), defense/industrial rotation, Iran conflict uncertainty
- ACTION: Close position immediately when backend is live if close < $279.57

#### 3. New Strategy: Gold Futures Engineered Trend (arXiv Nov 2025)

Source: arXiv 2511.08571 — "Forecast-to-Fill: Benchmark-Neutral Alpha in Gold Futures"
- Sharpe 2.88 OOS (2015-2025), MDD 0.52%, hit rate 65.81%
- Entry: blend of EMA slope z-score (60%) + price > 50-day prior (40%), entry when > 0.52
- ATR-based stops, 30-day max hold, Kelly position sizing
- SIGNAL LIKELY ACTIVE NOW — GLD in strong uptrend, flight-to-quality
- Priority: implement when backend returns

#### 4. Oil-Equity Divergence Cross-Asset (Novel — Research Gap Identified)

No published backtest exists for: crude >3% AND SPY <-0.5% → buy SPY next open.
- Today's session was a live test case (Brent +3.6%, S&P -1.58%)
- If signal held, we'd be long SPY for March 27 open
- Stack with Correlated Stress Reversal for maximum confluence
- Custom backtest needed — propose to backend when live

#### 5. Market Structure Update

- Tech massacre: Meta -7%, semiconductors -4%+. XLK closed -3.01% at $132.64.
- Iran: rejected US 15-point plan. Pakistan mediating indirectly. No ceasefire.
- PCE consensus: Core +2.7% YoY (hot relative to Fed's 2% target). HIGH IMPACT March 28.
- ZBT setup zone remains active: Nasdaq breadth ~35%. Window still open.

---

## Session 6 — 2026-03-26 (PM)

[See session scan for full detail: trading/scans/2026-03-26_session6_alpha_research.md]

Key: 8 strategies discovered. XLE HOLD decision. PCE calendar correction (April 9, not March 28 as previously stated).

---

## Session 5 — 2026-03-26 (AM)

[See session scan for full detail: previously documented]

Key: 6 strategies discovered. Calendar correction (March 28 = PCE, not CPI). XLE approaching target.

---

## S8 Priority Queue — When Backend Returns

### IMMEDIATE
1. CONFIRM XLE close via portfolio tool (logged as WIN manually)
2. CHECK GE stop: if close < $279.57 → close immediately
3. Backtest correlated_stress_reversal (top priority, signal firing now)
4. Re-test cumulative_rsi: period=2, threshold<10, exit>65, 200-day MA
5. Composite: poc_reversion + center_of_gravity
6. Composite: island_reversal + consecutive_days
7. Test gold_futures_trend on GLD
8. Test oil_equity_divergence_crossasset (crude>3% + SPY<-0.5% → buy SPY)
9. regime_matched_backtest: 90-day validation on center_of_gravity, consecutive_days, island_reversal
10. Run ml_train — unlock 4 ML strategies

### POST-PCE (after March 28)
- Reassess regime. Hot PCE → VIX up → more MR opportunities.
- Consider entry in oversold quality names (MCD if bouncing, MSFT, XLK mean reversion)
- Check ZBT breadth progress

### MEDIUM TERM
- Sweep remaining ~58 untested strategies
- Investigate rs_momentum / time_series_momentum parameters
- Port Ehlers Cybernetic Oscillator (TASC June 2025)

---

## Rejection List (All Sessions)

halflife_mean_reversion, kst, chande_momentum, spread_mean_reversion, ornstein_uhlenbeck, zscore_mean_reversion_quant, percentile_reversion, hurst_exponent, klinger_oscillator, volume_weighted_momentum, trix, schaff_trend_cycle, golden_cross, bb_squeeze, pivot_point, bb_kc_squeeze, macd_histogram, trend_following_filter, adaptive_ma_crossover, tema, dema, hull_ma, vwap (as trend-follower), connors_rsi2, swing_high_low, gap_fill (raw), money_flow_index, double_seven, ichimoku_kumo_breakout, autocorrelation, relative_vigor_index, ease_of_movement, relative_volume, harami, three_bar_reversal, accelerator_oscillator, williams_vix_fix (standalone), volatility_contraction, cumulative_rsi (failed — re-test with corrected params S8), slow_absolute_mean_reversion (Carver 2025: Sharpe -0.48 — avoid all long-horizon MR)

---

## System Notes

- Trading bot backend: UNREACHABLE March 26 (all sessions)
- batch_backtest: FIXED S4
- composite_backtest: operational S4
- compare_strategies: broken server-side
- Calendar: PCE = April 9 AND March 28 (both high impact). CPI = April 10. FOMC = late April.
