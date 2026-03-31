# Alpha Research Session 8 — Full Backtest Results
**Date:** 2026-03-27
**Regime:** RISK-OFF / STAGFLATION (VIX 25, Brent $108, 10yr 4.41%, US-Iran conflict)
**Backend status:** RESTORED after 3-day outage
**Total strategies tested this session:** 169 (sweep) + 3 composites + 3 regime-matched + 1 priority retest
**Total backtest runs:** ~1,600+
**Universe:** SPY, QQQ, AAPL, MSFT, NVDA, XLE, XLK, AMZN, TSLA (9 symbols, 365d)

---

## POSITION GUIDANCE
DO NOT enter new positions today or tomorrow.
- FOMC Minutes released today (2026-03-27, 8:30 AM ET)
- PCE data Friday March 28, 8:30 AM ET
- Wait for PCE before any new entries.

---

## 1. SWEEP RESULTS — ALL 169 NEWLY TESTED STRATEGIES

### 1A. TOP PERFORMERS (Avg Sharpe > 0.7 across 9 symbols)

| Rank | Strategy | Avg Sharpe | Max Sharpe | Avg Return% | Assessment |
|------|----------|-----------|-----------|-------------|------------|
| 1 | adxr | 1.087 | 1.82 | 1.85% | PLAYBOOK |
| 2 | vortex_indicator | 0.997 | 1.90 | 1.64% | WATCH |
| 3 | adaptive_trend | 0.983 | 1.53 | 1.87% | WATCH |
| 4 | mtf_momentum | 0.932 | 1.90 | 1.78% | WATCH |
| 5 | r_squared | 0.926 | 1.81 | 1.89% | WATCH |
| 6 | rainbow_ma | 0.896 | 1.79 | 1.70% | WATCH |
| 7 | standard_error_bands | 0.890 | 1.42 | 1.60% | WATCH |
| 8 | linear_regression_slope | 0.877 | 2.05 | 1.45% | WATCH |
| 9 | fibonacci_extension | 0.816 | 2.35 | 2.00% | WATCH |
| 10 | volume_imbalance | 0.813 | 2.40 | 1.68% | WATCH |
| 11 | risk_adjusted_momentum | 0.804 | 2.15 | 1.45% | WATCH |
| 12 | atr_channel_breakout | 0.799 | 1.89 | 1.38% | WATCH |
| 13 | atr_trailing_stop | 0.787 | 1.73 | 1.31% | WATCH |
| 14 | multi_period_breakout | 0.777 | 1.56 | 1.47% | WATCH |
| 15 | price_channel | 0.777 | 1.56 | 1.47% | WATCH |
| 16 | developing_value_area | 0.772 | 2.51 | 0.75% | WATCH |
| 17 | value_area | 0.764 | 1.88 | 1.03% | WATCH |
| 18 | keltner_channel | 0.739 | 1.83 | 1.25% | WATCH |
| 19 | linear_regression_channel | 0.708 | 1.58 | 1.26% | WATCH |
| 20 | fractal_breakout | 0.703 | 2.25 | 1.22% | WATCH |

### 1B. NOTABLE FLAGS — HIGH MAX SHARPE (spike performers on specific symbols)

These had low avg Sharpe but extremely high max on one symbol — potentially regime/asset specific:

| Strategy | Max Sharpe | Best Symbol | Note |
|----------|-----------|-------------|------|
| trend_following_filter | 3.15 | (one symbol) | Very inconsistent, avg -0.39 |
| shark_pattern | 2.93 | (one symbol) | Avg -0.47, pattern strategy |
| butterfly_pattern | 2.67 | (one symbol) | Avg +0.11 |
| overnight_bias | 2.72 | (one symbol) | Avg +0.31, 33% pos rate |
| cypher_pattern | 2.55 | (one symbol) | Avg +0.30, 22% pos rate |
| developing_value_area | 2.51 | (one symbol) | Avg +0.77 — worth further study |
| atr_squeeze_breakout | 2.62 | (one symbol) | Avg +0.06, very inconsistent |
| volatility_targeting | 2.65 | XLE | Avg +0.47, XLE specialist |

XLE is driving outsized Sharpe for many breakout/momentum strategies. Energy sector is reacting strongly to Brent $108 — this is regime-specific alpha.

### 1C. ZERO-SIGNAL STRATEGIES (effectively broken or insufficient data)

These returned Sharpe=0 across all symbols — likely require specific data not available or signal conditions never triggered:

- combined_signal, consolidation_breakout, dual_momentum, golden_cross
- hv_breakout, lvn_breakout, mass_index, ml_enhanced_technical, ml_prediction
- momentum_rank, rectangle_pattern, rs_momentum, sentiment_driven
- three_soldiers_crows, time_series_momentum, trend_intensity_index
- ultimate_oscillator (near-zero except AAPL), volatility_regime, vpin

### 1D. REJECT LIST (Avg Sharpe < -0.5)

| Strategy | Avg Sharpe | Note |
|----------|-----------|------|
| end_of_month | -1.45 | Strong negative: calendar bias inverted |
| pivot_point | -1.09 | Consistently negative all symbols |
| calendar_aware | -1.00 | Multi-signal, underperforms |
| santa_claus_rally | -0.92 | March regime wrong for this |
| accelerator_oscillator | -0.77 | Negative everywhere |
| quarter_end | -0.76 | Wrong timing |
| camarilla_pivot | -0.75 | Pivot strategies failing |
| macd_histogram | -0.84 | MACD derivative underperforms |
| halflife_mean_reversion | -0.70 | Mean reversion struggling in trend regime |
| spread_mean_reversion | -0.60 | Pairs-based, low signal count |

---

## 2. FULL STRATEGY SCOREBOARD (All Newly Tested, Ranked)

| Strategy | Avg Sharpe | Max Sharpe | Avg Ret% | Pos% | Assessment |
|----------|-----------|-----------|----------|------|------------|
| adxr | 1.087 | 1.82 | 1.85 | 89% | PLAYBOOK |
| vortex_indicator | 0.997 | 1.90 | 1.64 | 89% | WATCH |
| adaptive_trend | 0.983 | 1.53 | 1.87 | 100% | WATCH |
| mtf_momentum | 0.932 | 1.90 | 1.78 | 78% | WATCH |
| r_squared | 0.926 | 1.81 | 1.89 | 89% | WATCH |
| rainbow_ma | 0.896 | 1.79 | 1.70 | 89% | WATCH |
| standard_error_bands | 0.890 | 1.42 | 1.60 | 89% | WATCH |
| linear_regression_slope | 0.877 | 2.05 | 1.45 | 89% | WATCH |
| fibonacci_extension | 0.816 | 2.35 | 2.00 | 78% | WATCH |
| volume_imbalance | 0.813 | 2.40 | 1.68 | 89% | WATCH |
| risk_adjusted_momentum | 0.804 | 2.15 | 1.45 | 100% | WATCH |
| atr_channel_breakout | 0.799 | 1.89 | 1.38 | 78% | WATCH |
| atr_trailing_stop | 0.787 | 1.73 | 1.31 | 89% | WATCH |
| multi_period_breakout | 0.777 | 1.56 | 1.47 | 89% | WATCH |
| price_channel | 0.777 | 1.56 | 1.47 | 89% | WATCH |
| developing_value_area | 0.772 | 2.51 | 0.75 | 78% | WATCH |
| value_area | 0.764 | 1.88 | 1.03 | 89% | WATCH |
| keltner_channel | 0.739 | 1.83 | 1.25 | 78% | WATCH |
| linear_regression_channel | 0.708 | 1.58 | 1.26 | 78% | WATCH |
| fractal_breakout | 0.703 | 2.25 | 1.22 | 67% | WATCH |
| high_low_breakout | 0.687 | 1.77 | 1.36 | 89% | WATCH |
| raff_channel | 0.673 | 1.32 | 0.94 | 78% | WATCH |
| earnings_avoidance | 0.672 | 2.02 | 1.12 | 78% | WATCH |
| percentage_breakout | 0.668 | 1.56 | 1.27 | 89% | WATCH |
| donchian_breakout | 0.659 | 1.95 | 1.06 | 89% | WATCH |
| qstick | 0.651 | 1.38 | 1.34 | 89% | WATCH |
| overbought_oversold | 0.644 | 2.27 | 1.16 | 67% | WATCH |
| choppiness_index | 0.638 | 2.40 | 1.23 | 78% | WATCH |
| trend_alignment | 0.636 | 2.31 | 1.07 | 78% | WATCH |
| pin_bar | 0.626 | 1.31 | 1.16 | 89% | WATCH |
| trend_intensity | 0.626 | 2.31 | 1.31 | 78% | WATCH |
| momentum_breakout | 0.611 | 1.37 | 1.21 | 89% | WATCH |
| adx_dmi | 0.610 | 2.00 | 0.91 | 56% | WATCH |
| sr_channel_confluence | 0.607 | 1.50 | 0.76 | 89% | WATCH |
| rsi_mean_reversion | 0.597 | 1.04 | 1.64 | 89% | WATCH |
| sentiment_filter | 0.597 | 1.04 | 1.64 | 89% | WATCH |
| force_index | 0.592 | 1.53 | 1.20 | 78% | WATCH |
| ease_of_movement | 0.591 | 1.68 | 1.10 | 100% | WATCH |
| midpoint_reversion | 0.583 | 1.96 | 0.78 | 78% | WATCH |
| extreme_price_reversion | 0.582 | 1.55 | 1.39 | 78% | WATCH |
| momentum_crash_filter | 0.574 | 1.73 | 1.01 | 89% | WATCH |
| std_breakout | 0.566 | 1.69 | 0.78 | 78% | WATCH |
| tick_rule | 0.564 | 2.09 | 1.25 | 67% | WATCH |
| rs_phase | 0.559 | 1.50 | 1.05 | 78% | WATCH |
| polarized_fractal_efficiency | 0.556 | 1.54 | 1.36 | 78% | WATCH |
| holiday_effect | 0.546 | 1.68 | 0.25 | 67% | WATCH |
| ema_envelope | 0.527 | 1.37 | 1.48 | 78% | WATCH |
| support_resistance_bounce | 0.512 | 1.54 | 0.48 | 78% | WATCH |
| range_compression_breakout | 0.496 | 2.38 | 0.81 | 56% | WATCH |
| channel_squeeze_sr | 0.481 | 2.35 | 0.59 | 56% | WATCH |
| williams_vix_fix | 0.471 | 1.47 | 0.40 | 67% | WATCH |
| volatility_targeting | 0.469 | 2.65 | 0.59 | 56% | WATCH |
| chaikin_money_flow | 0.469 | 1.78 | 0.85 | 89% | WATCH |
| elder_ray | 0.468 | 1.59 | 1.32 | 67% | WATCH |
| day_of_week | 0.429 | 1.12 | 1.45 | 78% | WATCH |
| opening_range_breakout | 0.422 | 2.10 | 0.95 | 56% | WATCH |
| abcd_pattern | 0.402 | 2.22 | 0.85 | 67% | WATCH |
| multi_factor | 0.400 | 0.80 | 0.91 | 89% | WATCH |
| ma_pullback | 0.393 | 1.90 | 0.48 | 56% | WATCH |
| narrow_range | 0.384 | 1.56 | 0.78 | 78% | WATCH |
| ad_momentum | 0.378 | 1.82 | 1.30 | 67% | WATCH |
| adaptive_ma_crossover | 0.320 | 1.09 | 0.47 | 67% | WATCH |
| coppock_curve | 0.314 | 1.37 | 0.25 | 67% | WATCH |
| overnight_bias | 0.310 | 2.72 | 0.43 | 33% | WATCH |
| price_volume_rank | 0.308 | 1.55 | 0.46 | 44% | WATCH |
| cypher_pattern | 0.301 | 2.55 | 0.57 | 22% | WATCH |
| elder_ray_divergence | 0.283 | 1.84 | 0.56 | 56% | WATCH |
| darvas_box | 0.277 | 1.31 | 0.67 | 67% | WATCH |
| parabolic_sar | 0.257 | 0.75 | 0.55 | 78% | WATCH |
| obv_trend | 0.253 | 1.44 | 0.63 | 44% | WATCH |
| new_high_momentum | 0.241 | 1.09 | 0.40 | 78% | WATCH |
| ornstein_uhlenbeck | 0.234 | 1.25 | 0.25 | 78% | WATCH |
| price_acceleration | 0.224 | 1.06 | 0.46 | 56% | WATCH |
| doji | 0.197 | 1.84 | 0.45 | 67% | WATCH |
| cumulative_rsi | 0.189 | 0.90 | 0.14 | 67% | WATCH (weak) |
| inside_bar_breakout | 0.177 | 1.91 | 0.39 | 56% | WATCH |
| fisher_transform | 0.174 | 2.24 | 0.37 | 44% | WATCH |
| relative_volume | 0.162 | 2.22 | 0.28 | 33% | WATCH |
| turtle_system2 | 0.178 | 2.00 | 0.28 | 44% | WATCH |
| schaff_trend_cycle | 0.119 | 0.86 | 0.16 | 44% | REJECT |
| value_area_volume | -0.249 | 0.41 | -0.07 | 11% | REJECT |
| volume_profile_support | -0.237 | 0.98 | -0.05 | 33% | REJECT |
| volume_weighted_momentum | -0.184 | 0.98 | -0.03 | 22% | REJECT |
| ttm_squeeze | -0.546 | 0.84 | -0.01 | 33% | REJECT |
| vwap | -0.476 | 1.01 | -0.50 | 22% | REJECT |
| volatility_contraction | -0.357 | 1.35 | 0.12 | 22% | REJECT |
| end_of_month | -1.453 | -0.49 | -2.35 | 0% | REJECT |
| pivot_point | -1.088 | -0.38 | -1.06 | 0% | REJECT |
| calendar_aware | -0.999 | 0.58 | -1.19 | 22% | REJECT |
| santa_claus_rally | -0.917 | 1.44 | -0.11 | 11% | REJECT |
| macd_histogram | -0.839 | 0.87 | -0.97 | 22% | REJECT |
| accelerator_oscillator | -0.774 | 1.57 | -0.92 | 11% | REJECT |
| quarter_end | -0.764 | 0.43 | -0.33 | 22% | REJECT |
| camarilla_pivot | -0.747 | 1.10 | -0.61 | 11% | REJECT |
| halflife_mean_reversion | -0.696 | 0.18 | -0.41 | 22% | REJECT |
| spread_mean_reversion | -0.601 | 0.22 | -0.54 | 11% | REJECT |

---

## 3. PRIORITY 1 — COMPOSITE BACKTEST RESULTS

### Composite 1: poc_reversion + center_of_gravity (weighted)
| Metric | Value |
|--------|-------|
| Sharpe | 0.32 |
| Sortino | 0.26 |
| Total Return | 3.35% |
| Max Drawdown | 12.99% |
| Total Trades | 171 |
| Win Rate | 68.4% |
| Profit Factor | 2.03 |
| Avg Hold Days | 6.9 |

**Assessment:** WEAK SYNERGY. The combination dilutes both strategies. poc_reversion works best as standalone. High win rate (68%) and profit factor (2.03) show the signal quality is good, but the Sharpe of 0.32 means too much volatility relative to return. The individual components likely trade at different times, creating whipsaw in the combined signal. NOT PROMOTED.

### Composite 2: zscore_mean_reversion + obv_divergence (weighted)
| Metric | Value |
|--------|-------|
| Sharpe | -0.07 |
| Sortino | -0.05 |
| Total Return | -1.56% |
| Max Drawdown | 12.99% |
| Total Trades | 54 |
| Win Rate | 74.1% |
| Profit Factor | 2.33 |
| Avg Hold Days | 16.5 |

**Assessment:** NEGATIVE SYNERGY. Despite a very high win rate (74%) and strong profit factor (2.33), the overall return is negative. This is a case of high-conviction signals being too infrequent and then held too long (16.5 day avg hold). The strategies conflict on timing, creating a consensus filter that's too restrictive. NOT PROMOTED.

### Composite 3: bb_mean_reversion + williams_r (weighted)
| Metric | Value |
|--------|-------|
| Sharpe | -0.22 |
| Sortino | -0.15 |
| Total Return | -3.31% |
| Max Drawdown | 13.85% |
| Total Trades | 72 |
| Win Rate | 75.0% |
| Profit Factor | 1.91 |
| Avg Hold Days | 12.7 |

**Assessment:** NEGATIVE SYNERGY. Same pattern — high win rate, negative returns. Mean reversion strategies are suffering in the current trending/stagflation regime. Their composites amplify the trend drag. NOT PROMOTED.

**Key Insight from composites:** High win rate + negative/low Sharpe = the LOSSES are large relative to WINS. Mean reversion is being cut short on winners but holding losers in trending market conditions. The current RISK-OFF regime is hostile to mean reversion composites.

---

## 4. PRIORITY 2 — CUMULATIVE RSI RETEST

**cumulative_rsi** (default params, SPY/QQQ/AAPL/MSFT, 365d):
- Sharpe: 0.15 | Return: 0.18% | Trades: 16 | Max DD: 0.54% | Win Rate: 56.25%

**Assessment:** REJECT for now. The params specified (period=2, overbought=65, oversold=10 with 200d MA filter) were not tested with custom params — the default run shows near-zero signal generation (only 16 trades across 4 symbols in 1 year). This strategy requires precise parameter tuning. The 200d MA filter would be especially restrictive in current risk-off conditions where SPY is below key MAs. PARK — re-test in next session with explicit param overrides.

---

## 5. PRIORITY 3 — REGIME-MATCHED BACKTEST RESULTS

All three tested against 5 historical periods most similar to current conditions (96.87% similarity score), 90-day windows.

| Strategy | 1Y Avg Sharpe | Regime Sharpe | Regime Return | Regime Win% | Regime Max DD | Trades | Verdict |
|----------|-------------|--------------|--------------|------------|--------------|--------|---------|
| center_of_gravity | ~1.2* | -0.24 | -0.75% | 53.5% | 4.8% | 239 | REGIME-HOSTILE |
| consecutive_days | ~0.9* | +0.48 | +1.93% | 59.5% | 5.0% | 105 | REGIME-RESILIENT |
| island_reversal | ~0.4* | -0.19 | -0.97% | 32.2% | 6.1% | 62 | REJECT |

*1Y Sharpe estimates from prior sessions

### Analysis:
- **center_of_gravity:** Massive regime collapse. 1Y Sharpe ~1.2 drops to -0.24 in current conditions. This strategy is NOT suitable for the current risk-off/stagflation regime despite its impressive full-year numbers. SUSPEND from playbook until regime changes.

- **consecutive_days:** Regime-resilient. Holds positive Sharpe (0.48) in matched periods. 105 trades provide statistical confidence. Win rate drops slightly (to 59.5%) vs full year but remains positive. This is a RARE finding — a strategy that works in environments like the current one. ADD TO REGIME-AWARE PLAYBOOK.

- **island_reversal:** Double regime failure. Already weak in full-year backtest, now negative in regime-matched test AND has the lowest win rate of the three (32.2%). The strategy requires specific gap-up/gap-down island formation which is rare and unreliable in choppy stagflation conditions. REMOVE FROM WATCH LIST.

---

## 6. REGIME ANALYSIS — WHAT WORKS IN CURRENT CONDITIONS

**Current regime:** RISK-OFF / STAGFLATION
- VIX 25 (elevated)
- Brent $108 (energy bid)
- 10yr 4.41% (rising yields)
- US-Iran conflict (geopolitical premium)
- FOMC Minutes released today
- PCE tomorrow (March 28)

### Strategy Categories by Regime Compatibility:

**FAVORABLE (work in current regime):**
- Channel/band strategies: adxr, keltner_channel, atr_channel_breakout, linear_regression_channel, raff_channel — all outperform on XLE and trend-following assets
- ATR-based trend: atr_trailing_stop, volatility_targeting (especially XLE)
- Volume-based: volume_imbalance, volume_confirmed_breakout — picking up energy sector flows
- Price channel followers: price_channel, donchian_breakout, percentage_breakout — trending regime favors these
- consecutive_days — confirmed regime-resilient
- Regression strategies: linear_regression_slope, r_squared — detecting trends in trending market

**UNFAVORABLE (hostile in current regime):**
- Mean reversion composites: all three tested composites failed
- center_of_gravity — regime-hostile confirmed by matched test
- island_reversal — pattern requires conditions absent in volatility
- Calendar effects: end_of_month, quarter_end, santa_claus_rally, calendar_aware — wrong timing
- MACD derivatives: macd_histogram, calendar_aware — signals confused by volatility
- Pivot strategies: camarilla_pivot, pivot_point — intraday frameworks, unreliable in high-vol

### XLE ALPHA NOTE:
XLE is showing outsized Sharpe on nearly every breakout/momentum strategy in this session. With Brent at $108 (elevated from US-Iran conflict), energy is the "hot sector" of this regime. The following strategy/asset combinations are especially notable:
- volatility_targeting / XLE: Sharpe 2.65, Return 4.27%
- volume_imbalance / XLE: Sharpe 2.40, Return 4.46%
- volume_breakout / XLE: Sharpe 2.22, Return 4.05%
- fibonacci_extension / XLE: Sharpe 2.35, Return 4.65%
- developing_value_area / XLE: Sharpe 2.51

**This is regime-driven, not structural alpha.** XLE alpha will evaporate when Brent oil normalizes. Do NOT build playbook strategies around XLE concentration without regime filter.

---

## 7. CANDIDATE STRATEGIES FOR REGIME-MATCHED VALIDATION (Next Session)

Priority list for regime_matched_backtest in Session 9:

1. **adxr** — Top avg Sharpe (1.09), needs regime validation before promoting to playbook
2. **vortex_indicator** — Strong across 7/9 symbols, consistent, needs regime test
3. **adaptive_trend** — 100% positive rate, needs regime test
4. **linear_regression_slope** — High avg Sharpe, already has XLE Sharpe 2.05
5. **r_squared** — High consistency (89% positive), needs regime test
6. **risk_adjusted_momentum** — 100% positive rate, needs regime test
7. **volume_imbalance** — Good across tech + energy, needs regime test

---

## 8. COMPOSITE STRATEGY IDEAS FOR SESSION 9

Based on findings:

### Composite A: "Trend Channel + Volume Confirmation"
- adxr + volume_imbalance (majority voting)
- Rationale: ADXR detects trend strength, volume_imbalance confirms institutional flow direction

### Composite B: "Regression Trend + ATR Filter"
- linear_regression_slope + atr_trailing_stop (weighted)
- Rationale: Linear regression identifies slope direction, ATR trailing stop manages exits in volatile conditions

### Composite C: "Multi-Timeframe Momentum + Volatility Target"
- mtf_momentum + volatility_targeting (weighted)
- Rationale: MTF confirms trend across timeframes, vol targeting sizes appropriately for VIX 25 conditions

### Composite D: "Energy Regime Play"
- adxr + volume_imbalance + volatility_targeting (unanimous on XLE, XOM, CVX)
- Rationale: Three independent signal types all bullish on energy = high conviction in current regime

---

## 9. STRATEGIES PROMOTED / DEMOTED THIS SESSION

### PROMOTED TO WATCH:
- adxr (Sharpe 1.09, 89% positive)
- vortex_indicator (Sharpe 1.00, broad consistency)
- adaptive_trend (Sharpe 0.98, 100% positive)
- mtf_momentum (Sharpe 0.93)
- consecutive_days — REGIME-RESILIENT, confirmed by matched test

### DEMOTED / SUSPENDED:
- center_of_gravity — Suspend from active playbook (regime-hostile, Sharpe collapse in matched test)
- island_reversal — Remove from watch list (regime-hostile + low win rate 32%)
- cumulative_rsi — Park for parameter tuning
- All mean reversion composites (poc_reversion+COG, zscore+OBV, bb+williams_r) — Not viable in current regime

### CONFIRMED REJECT (do not revisit):
- end_of_month, pivot_point, calendar_aware, santa_claus_rally, macd_histogram
- accelerator_oscillator, quarter_end, camarilla_pivot, halflife_mean_reversion

---

## 10. SUMMARY STATISTICS

- Strategies tested this session: 169 sweep + 3 composite + 3 regime-matched + 1 retest = 176
- Total strategies now tested across all sessions: ~206 (full universe)
- Strategies with avg Sharpe > 1.0: adxr only (new); plus from prior sessions
- Strategies with avg Sharpe 0.7-1.0: ~19 new entries
- Strategies confirmed REJECT: ~30 (avg Sharpe < -0.5)
- Zero-signal strategies: ~17 (require special data or conditions never triggered)
- Regime-resilient confirmed: consecutive_days
- Regime-hostile confirmed: center_of_gravity, island_reversal

---

## 11. NEXT PRIORITIES (Session 9)

1. **Regime-matched backtests** on top 7 candidates above (adxr, vortex_indicator, adaptive_trend, etc.)
2. **Composite tests** (Composites A, B, C, D above)
3. **Cross-universe testing** — run top 5 new strategies on broader universes (S&P 500 sectors, sector ETFs)
4. **Parameter optimization** — cumulative_rsi with period=2, overbought=65, oversold=10
5. **90-day window backtests** on all top-10 to check recency bias

---
*Generated: 2026-03-27 | Session 8 | Backend restored after 3-day outage*
*Methodology: batch_backtest x7 parallel (225 runs each), composite_backtest x3, regime_matched_backtest x3*
