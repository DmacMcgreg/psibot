# Strategy Scoreboard

Cumulative rankings across all Alpha Research sessions. Updated after each run.
Last updated: 2026-03-24 Session 3

---

## Master Rankings — All Tested Strategies (Top Tier)

Sorted by Sharpe ratio (descending). 1Y backtest unless noted. Regime: MIXED/TRANSITIONAL.

| Rank | Strategy | Sharpe (1Y) | Return | Win Rate | PF | Trades | MDD | Session | Verdict |
|------|----------|-------------|--------|----------|----|--------|-----|---------|---------|
| 1 | zscore_mean_reversion | 2.160 | +4.71% | 87.5% | 13.83 | 16 | 0.88% | S2 | PLAYBOOK ⭐ |
| 2 | rate_of_change | 1.970 | +10.77% | 55.6% | 6.01 | 9 | 3.22% | S3 | WATCH (low trades) |
| 3 | vwap_mean_reversion | 2.040 | +6.93% | 70.0% | 6.19 | 20 | 1.87% | S2 | PLAYBOOK ⭐ |
| 4 | bb_mean_reversion | 1.970 | +6.20% | 84.2% | 6.37 | 38 | 1.84% | S2 | PLAYBOOK ⭐ |
| 5 | williams_r | 1.960 | +5.32% | 77.3% | 5.69 | 22 | 1.42% | S2 | PLAYBOOK ⭐ |
| 6 | aroon | 1.770 | +9.63% | 43.8% | 3.59 | 16 | 4.90% | S3 | WATCH |
| 7 | price_volume_trend | 1.610 | +8.25% | 28.3% | 2.33 | 46 | 5.07% | S3 | BULL REGIME ONLY |
| 8 | detrended_price_oscillator | 1.590 | +6.66% | 61.7% | 1.73 | 107 | 4.41% | S3 | BULL REGIME ONLY |
| 9 | anchored_vwap | 1.540 | +7.91% | 30.0% | 2.19 | 50 | 5.85% | S3 | BULL REGIME ONLY |
| 10 | aroon_trend_strength | 1.480 | +8.18% | 70.0% | 5.04 | 10 | 3.81% | S3 | WATCH |
| 11 | obv_divergence | 1.690 | +5.78% | 76.5% | 8.09 | 17 | 1.87% | S2 | PLAYBOOK ⭐ |
| 12 | kalman_filter | 1.580 | +11.18% | 66.7% | 2.95 | 21 | 5.42% | S2 | PLAYBOOK ⭐ (all-weather) |
| 13 | regime_detection | 1.370 | +15.57% | 43.3% | 2.68 | 30 | 7.22% | S2 | PLAYBOOK ⭐ (all-weather) |
| 14 | volatility_breakout | 1.320 | +11.23% | 41.9% | 1.37 | 310 | 6.39% | S2 | WATCH (high freq) |
| 15 | hammer_shooting_star | 1.470 | +3.58% | 75.0% | 4.53 | 8 | 1.31% | S2 | WATCH (low trades) |
| 16 | stochastic_oscillator | 1.430 | +2.32% | 71.4% | 8.16 | 7 | 0.80% | S2 | WATCH (low trades) |
| 17 | stochastic_bb | 1.340 | +2.73% | 75.0% | 9.87 | 4 | 1.12% | S2 | WATCH (very low trades) |
| 18 | momentum | 1.260 | +5.91% | 80.0% | 80.01 | 5 | 3.12% | S2 | WATCH (very low trades) |
| 19 | poc_reversion | 1.200 | +4.88% | 68.4% | 2.50 | 19 | 2.25% | S3 | ⭐ REGIME RESILIENT |
| 20 | turtle_system1 | 1.140 | +5.88% | 33.3% | 1.95 | 21 | — | S1 | TRENDING ONLY |
| 21 | supertrend | 1.200 | +6.00% | 29.0% | 2.32 | 31 | 5.39% | S2 | WATCH |
| 22 | adx_dmi | 1.190 | +4.41% | 42.4% | 1.94 | 33 | 2.44% | S2 | WATCH |
| 23 | ad_momentum | 1.100 | +7.07% | 27.3% | 1.88 | 22 | 5.55% | S3 | BULL REGIME ONLY |
| 24 | price_acceleration | 1.050 | +3.53% | 44.7% | 1.52 | 85 | 2.90% | S3 | BULL REGIME ONLY |
| 25 | risk_adjusted_momentum | 1.030 | +5.01% | 66.7% | 4.45 | 6 | 4.10% | S3 | WATCH (low trades) |
| 26 | ultimate_oscillator | 1.030 | +2.36% | 100.0% | — | 1 | — | S3 | INSUFFICIENT DATA |
| 27 | atr_trailing_stop | 1.040 | +5.29% | 35.7% | 2.13 | 14 | 5.37% | S2 | WATCH |
| 28 | price_channel | 1.000 | +5.52% | 36.4% | 2.18 | 11 | 6.38% | S2 | WATCH |
| 29 | triple_ma | 0.980 | +6.50% | 41.7% | 2.68 | 12 | — | S1 | TRENDING ONLY |
| 30 | obv_trend | 1.250 | +6.12% | 34.7% | 1.87 | 72 | 4.62% | S2 | WATCH |

---

## ⭐ CRITICAL REGIME FINDING (Session 3)

**90-day validation reveals regime bifurcation:**

All strategies that scored Sharpe > 1.0 over 12 months COLLAPSE in the 90-day window (Feb-Mar 2026 drawdown):

| Strategy | 1Y Sharpe | 90d Sharpe | Δ |
|----------|-----------|-----------|---|
| Most trend/momentum strategies | +1.0 to +1.97 | -1.34 to -5.97 | COLLAPSE |
| poc_reversion | +1.20 | -0.55 | MILD DEGRADATION ONLY |
| cumulative_rsi | 0.58 | Not tested | (low DD, high WR = promising) |
| connors_rsi2_pullback | 0.48 | Not tested | (lowest MDD of session: 0.65%) |

**Implication for current playbook:** The 12-month Sharpe rankings are inflated by the 2025 bull run. In the current MIXED/TRANSITIONAL regime (VIX ~27, Feb-Mar 2026 drawdown), only poc_reversion is demonstrably regime-resilient. Weight toward poc_reversion + cumulative_rsi + connors_rsi2_pullback until VIX < 20.

---

## Session 3 — Watch List (Below Promotion Threshold but Notable)

| Strategy | Sharpe | Return | Win Rate | Trades | MDD | Notes |
|----------|--------|--------|----------|--------|-----|-------|
| center_of_gravity | 0.99 | +5.80% | 62.5% | 120 | — | Very active — just below threshold |
| consecutive_days | 0.72 | +5.13% | 64.1% | 39 | — | Solid all-around, needs wider test |
| midpoint_reversion | 0.74 | +2.32% | 68.4% | 19 | — | High WR, low return |
| cumulative_rsi | 0.58 | +0.87% | 70.6% | 17 | 0.85% | LOWEST DD in group A — current regime fit |
| extreme_price_reversion | 0.70 | +3.87% | 64.0% | 25 | — | Decent |
| force_index | 0.80 | +4.42% | 31.8% | 63 | — | Active signal generator |
| volume_imbalance | 0.67 | +3.12% | 41.7% | 12 | — | Needs more trades |
| connors_rsi2_pullback | 0.48 | +0.48% | 71.4% | 7 | 0.65% | LOWEST MDD of session — current regime |

---

## Session 3 — Confirmed Failures (Do Not Pursue)

| Strategy | Sharpe | Reason |
|----------|--------|--------|
| halflife_mean_reversion | -1.31 | Theoretical ≠ practical |
| kst | -1.46 | Net negative, 26 trades |
| chande_momentum | -1.36 | Zero signal (2 trades) |
| spread_mean_reversion | -0.80 | Low trades, negative |
| ornstein_uhlenbeck | -0.42 | Theoretical model doesn't translate |
| zscore_mean_reversion_quant | -0.16 | Weaker version of zscore_mean_reversion |
| percentile_reversion | -0.28 | Fails |
| hurst_exponent | -0.17 | Not actionable as trade signal |
| klinger_oscillator | -0.46 | Net negative, 67 trades |
| volume_weighted_momentum | -0.70 | Net negative |
| trix | -0.04 | Marginally negative |
| schaff_trend_cycle | -0.36 | Negative, 39 trades |

---

## Zero Signal — Cross-Sectional (Needs Multi-Symbol Universe)

| Strategy | Status | Fix |
|----------|--------|-----|
| rs_momentum | 0 trades on single symbols | Test on sector ETF universe (universe_id=4) |
| time_series_momentum | 0 trades on single symbols | Test on sector ETF universe (universe_id=4) |

---

## Pending ML Training (Cannot evaluate)

| Strategy | Status |
|----------|--------|
| ml_prediction | Needs ml_train |
| volatility_regime | Needs ml_train |
| combined_signal | Needs ml_train |
| ml_enhanced_technical | Needs ml_train |

---

## Coverage Tracking

| Session | Date | Strategies Tested | New Strategies | Cumulative Total | Universe |
|---------|------|-------------------|----------------|------------------|---------|
| S1 | ~2026-03-22 | ~7 | 7 | 7 | Mixed |
| S2 | 2026-03-24 AM | 52 | 52 | 59 | SPY/QQQ/AAPL/NVDA + adaptive set |
| S3 | 2026-03-24 PM | 42 | 42 | **101** | SPY/AAPL/NVDA/MSFT + 90d validation |

**Coverage: 101 / 194 = 52.1%** (majority tested!)
**Remaining: 93 strategies untested**

---

## PLAYBOOK-Promoted Strategies

| Strategy | Sharpe | PF | Trades | Regime Fit | Current Regime Weight |
|----------|--------|----|--------|------------|----------------------|
| zscore_mean_reversion | 2.16 | 13.83 | 16 | Mixed | HIGH |
| vwap_mean_reversion | 2.04 | 6.19 | 20 | Mixed | HIGH |
| bb_mean_reversion | 1.97 | 6.37 | 38 | Mixed | HIGH |
| williams_r | 1.96 | 5.69 | 22 | Mixed | HIGH |
| obv_divergence | 1.69 | 8.09 | 17 | Mixed | MEDIUM |
| kalman_filter | 1.58 | 2.95 | 21 | All | MEDIUM |
| regime_detection | 1.37 | 2.68 | 30 | All | MEDIUM |
| poc_reversion | 1.20 | 2.50 | 19 | All (resilient) | HIGH — regime-proven |

---

## Tool Bugs Logged

1. `batch_backtest` — broken (field mapping: sends `strategy_name` but API expects `name`). Workaround: use `run_backtest` per strategy.
2. `composite_backtest` — same 422 error as batch_backtest. Fix needed in `src/agent/trading-mcp.ts` line ~298: change `strategy_name: s.name` to `name: s.name`.
3. `compare_strategies` — broken server-side.

---

## Session 4 Priorities

1. Fix composite_backtest (code change to trading-mcp.ts line ~298)
2. Test rs_momentum + time_series_momentum on sector ETF universe (universe_id=4)
3. Validate poc_reversion + cumulative_rsi + connors_rsi2_pullback on expanded universe (QQQ, AMZN, TSLA, XLE, XLK)
4. Sweep remaining ~93 untested strategies: candle patterns (doji, morning_evening_star, three_soldiers_crows, harami, pin_bar, fakey), harmonic patterns (gartley, bat, butterfly, crab, shark, cypher), williams_vix_fix, alligator system, fractal_breakout, value_area, darvas_box, and ~30 breakout/statistical variants
5. Run ml_train to unlock 4 ML-dependent strategies
6. Build and test composites once tool is fixed
