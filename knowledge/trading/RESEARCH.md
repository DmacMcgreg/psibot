# Alpha Research

New strategies, signals, and ideas being explored. Auto-updated by Alpha Researcher.

---

## Under Investigation

### 2026-03-24 — Session 3

**Market regime:** Mixed (confidence 0.5, VIX ~27). Feb-Mar 2026 drawdown has neutralized most trend/momentum alpha.
**Total strategies tested this session:** 42 (Groups A-D: mean reversion variants, oscillators, volume-based, breakout/momentum)
**Cumulative unique strategies tested (all sessions):** 101 / 194 = 52%

---

#### CRITICAL REGIME FINDING (Session 3)

**90-day validation reveals the 12-month Sharpe rankings are inflated by the 2025 bull run.**

Every strategy showing Sharpe > 1.0 over 12 months COLLAPSED on 90-day validation (range: -1.34 to -5.97 Sharpe). This is the Feb-Mar 2026 drawdown erasing all prior gains. The only exception:

- **poc_reversion**: 1Y Sharpe 1.20 → 90d Sharpe -0.55. MILD degradation only — best regime resilience of all 42 strategies tested.
- **cumulative_rsi**: Not 90d validated, but extremely low drawdown (0.85%), high WR (70.6%), 17 trades — highly selective, likely avoiding regime traps.
- **connors_rsi2_pullback**: LOWEST MDD of entire session (0.65%), 71.4% WR — being very selective in uncertain environment.

**Takeaway:** Current MIXED regime (VIX ~27) demands capital preservation over maximizing returns. poc_reversion + cumulative_rsi + connors_rsi2_pullback are the regime-appropriate picks until VIX < 20.

---

#### TASK 1: Group A — Mean Reversion Variants (SPY, AAPL, NVDA, MSFT — 365d)

| Strategy | Avg Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|----------|-----------|--------|----------|--------|-----|---------|
| anchored_vwap | 1.54 | +7.91% | 30.0% | 50 | 5.85% | BULL REGIME ONLY |
| poc_reversion | 1.20 | +4.88% | 68.4% | 19 | 2.25% | ⭐ REGIME RESILIENT |
| midpoint_reversion | 0.74 | +2.32% | 68.4% | 19 | — | Watch |
| extreme_price_reversion | 0.70 | +3.87% | 64.0% | 25 | — | Watch |
| cumulative_rsi | 0.58 | +0.87% | 70.6% | 17 | 0.85% | ⭐ Low DD |
| connors_rsi2_pullback | 0.48 | +0.48% | 71.4% | 7 | 0.65% | ⭐ Lowest MDD |
| percent_b | 0.38 | +0.82% | 80.0% | 5 | — | Low trades |
| overbought_oversold | 0.34 | +1.15% | 76.9% | 13 | — | Marginal |
| autocorrelation | 0.16 | +0.59% | 58.3% | 48 | — | Near zero |
| zscore_mean_reversion_quant | -0.16 | -0.52% | 44.4% | 9 | — | Fail |
| percentile_reversion | -0.28 | -0.85% | 50.0% | 8 | — | Fail |
| hurst_exponent | -0.17 | -0.66% | 42.9% | 7 | — | Fail (as trade signal) |
| ornstein_uhlenbeck | -0.42 | -1.14% | 57.1% | 7 | — | Fail |
| spread_mean_reversion | -0.80 | -2.34% | 50.0% | 4 | — | Fail |
| halflife_mean_reversion | -1.31 | -2.61% | 25.0% | 4 | — | Fail |

**Key insight:** Theoretical sophistication (OU, Hurst, halflife) does NOT translate to practical alpha. Simple price-action mean reversion (poc_reversion, midpoint_reversion) works better. Hurst exponent failed as a standalone trade signal but may have value as a FILTER/GATE (see Ideas to Test).

---

#### TASK 2: Group B — Oscillators (SPY, AAPL, NVDA, MSFT — 365d)

| Strategy | Avg Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|----------|-----------|--------|----------|--------|-----|---------|
| aroon | 1.77 | +9.63% | 43.8% | 16 | 4.90% | BULL REGIME ONLY |
| detrended_price_oscillator | 1.59 | +6.66% | 61.7% | 107 | 4.41% | BULL REGIME ONLY |
| aroon_trend_strength | 1.48 | +8.18% | 70.0% | 10 | 3.81% | Watch |
| center_of_gravity | 0.99 | +5.80% | 62.5% | 120 | — | Watch (120 trades!) |
| fisher_transform | 0.74 | +4.46% | 41.2% | 136 | — | Watch |
| relative_vigor_index | 0.06 | +0.24% | 44.9% | 138 | — | Marginal |
| trix | -0.04 | -0.21% | 30.8% | 26 | — | Fail |
| schaff_trend_cycle | -0.36 | -1.29% | 23.1% | 39 | — | Fail |
| chande_momentum | -1.36 | -2.59% | 0.0% | 2 | — | Zero signal |
| kst | -1.46 | -3.77% | 38.5% | 26 | — | Fail |
| ultimate_oscillator | 1.03 | +2.36% | 100% | 1 | — | Insufficient data |

---

#### TASK 3: Group C — Volume-Based (SPY, AAPL, NVDA, MSFT — 365d)

| Strategy | Avg Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|----------|-----------|--------|----------|--------|-----|---------|
| price_volume_trend | 1.61 | +8.25% | 28.3% | 46 | 5.07% | BULL REGIME ONLY |
| ad_momentum | 1.10 | +7.07% | 27.3% | 22 | 5.55% | BULL REGIME ONLY |
| force_index | 0.80 | +4.42% | 31.8% | 63 | — | Watch |
| volume_imbalance | 0.67 | +3.12% | 41.7% | 12 | — | Watch |
| ease_of_movement | 0.39 | +1.86% | 34.4% | 61 | — | Marginal |
| relative_volume | 0.15 | +0.41% | 100% | 2 | — | Insufficient |
| volume_weighted_momentum | -0.70 | -2.53% | 27.3% | 11 | — | Fail |
| klinger_oscillator | -0.46 | -3.64% | 35.8% | 67 | — | Fail |

---

#### TASK 4: Group D — Breakout/Momentum Variants (SPY, AAPL, NVDA, MSFT — 365d)

| Strategy | Avg Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|----------|-----------|--------|----------|--------|-----|---------|
| rate_of_change | 1.97 | +10.77% | 55.6% | 9 | 3.22% | BULL REGIME ONLY |
| price_acceleration | 1.05 | +3.53% | 44.7% | 85 | 2.90% | BULL REGIME ONLY |
| risk_adjusted_momentum | 1.03 | +5.01% | 66.7% | 6 | 4.10% | Watch (low trades) |
| consecutive_days | 0.72 | +5.13% | 64.1% | 39 | — | Watch |
| new_high_momentum | 0.54 | +2.13% | 40.0% | 10 | — | Marginal |
| trend_intensity | 0.79 | +4.53% | 75.0% | 4 | — | Low trades |
| rs_momentum | 0.00 | 0% | — | 0 | — | Cross-sectional — needs sector universe |
| time_series_momentum | 0.00 | 0% | — | 0 | — | Cross-sectional — needs sector universe |

---

#### MASTER STRATEGY RANKINGS — ALL SESSIONS COMBINED (Top 15 by Sharpe)

| Rank | Strategy | Sharpe | Return | Win Rate | PF | Trades | Session |
|------|----------|--------|--------|----------|----|--------|---------|
| 1 | zscore_mean_reversion | 2.160 | +4.71% | 87.5% | 13.83 | 16 | S2 |
| 2 | rate_of_change | 1.970 | +10.77% | 55.6% | 6.01 | 9 | S3 |
| 3 | vwap_mean_reversion | 2.040 | +6.93% | 70.0% | 6.19 | 20 | S2 |
| 4 | bb_mean_reversion | 1.970 | +6.20% | 84.2% | 6.37 | 38 | S2 |
| 5 | williams_r | 1.960 | +5.32% | 77.3% | 5.69 | 22 | S2 |
| 6 | aroon | 1.770 | +9.63% | 43.8% | 3.59 | 16 | S3 |
| 7 | price_volume_trend | 1.610 | +8.25% | 28.3% | 2.33 | 46 | S3 |
| 8 | detrended_price_oscillator | 1.590 | +6.66% | 61.7% | 1.73 | 107 | S3 |
| 9 | anchored_vwap | 1.540 | +7.91% | 30.0% | 2.19 | 50 | S3 |
| 10 | obv_divergence | 1.690 | +5.78% | 76.5% | 8.09 | 17 | S2 |
| 11 | kalman_filter | 1.580 | +11.18% | 66.7% | 2.95 | 21 | S2 |
| 12 | regime_detection | 1.370 | +15.57% | 43.3% | 2.68 | 30 | S2 |
| 13 | aroon_trend_strength | 1.480 | +8.18% | 70.0% | 5.04 | 10 | S3 |
| 14 | volatility_breakout | 1.320 | +11.23% | 41.9% | 1.37 | 310 | S2 |
| 15 | poc_reversion | 1.200 | +4.88% | 68.4% | 2.50 | 19 | S3 |

---

## Tested & Approved

### zscore_mean_reversion — ⭐ PLAYBOOK (mixed regime)
### vwap_mean_reversion — ⭐ PLAYBOOK (mixed regime)
### bb_mean_reversion — ⭐ PLAYBOOK (mixed regime)
### williams_r — ⭐ PLAYBOOK (mixed regime)
### obv_divergence — ⭐ PLAYBOOK (mixed regime)
### kalman_filter — ⭐ PLAYBOOK (all regimes)
### regime_detection — ⭐ PLAYBOOK (all regimes)
### poc_reversion — ⭐ PLAYBOOK (regime resilient — promoted S3)
  - Only strategy showing mild (not catastrophic) 90d degradation
  - Sharpe 1.20, WR 68.4%, MDD 2.25%, 19 trades
  - RECOMMENDED: Increase weight in current mixed/volatile regime

### turtle_system1 — PLAYBOOK (trending regime only)
### triple_ma — PLAYBOOK (trending regime only)

---

## Tested & Rejected

### Session 3 New Rejections
- **halflife_mean_reversion** — Theoretical ≠ practical. Sharpe -1.31.
- **kst** — Fail. Sharpe -1.46.
- **chande_momentum** — Zero signal (2 trades). Sharpe -1.36.
- **klinger_oscillator** — Net negative 67 trades. Sharpe -0.46.
- **volume_weighted_momentum** — Negative. Sharpe -0.70.
- **trix** — Marginally negative. Sharpe -0.04.
- **schaff_trend_cycle** — Negative 39 trades. Sharpe -0.36.
- **ornstein_uhlenbeck** (as standalone) — Fail as trade signal. See "Ideas to Test" for use as parameter source.
- **zscore_mean_reversion_quant** — Weaker quant version. Negative. Use base zscore_mean_reversion.
- **hurst_exponent** (as standalone) — Fail as trade signal. Value is as a FILTER, not entry generator.
- **percentile_reversion** — Fail.
- **spread_mean_reversion** — Insufficient trades + negative.
- **autocorrelation** — Near-zero alpha despite 48 trades.

### Sessions 1-2 Previously Rejected
(See previous sessions for full list: golden_cross, bb_squeeze, pivot_point, bb_kc_squeeze, macd_histogram, trend_following_filter, adaptive_ma_crossover, tema, dema, hull_ma, vwap, connors_rsi2, swing_high_low, gap_fill, money_flow_index, double_seven, ichimoku_kumo_breakout)

---

## Ideas to Test (Web Research — Session 3 Findings)

### PRIORITY 1: VIX-Conditioned Z-Score (IMMEDIATE)
**Source:** Nielsen & Posselt 2024 (SSRN), practitioner validation
**Concept:** Gate zscore_mean_reversion entries by VIX z-score. When VIX z-score > 1.5 from 252-day mean, price deviations are larger and revert more reliably. 70.7% return in 2024 practitioner test.
**Implementation:** zscore_mean_reversion entry only when VIX > 22 AND price z-score < -2.0
**Combo:** regime_detection (VIX gate) → zscore_mean_reversion → williams_r < -80 confirmation
**Expected:** Higher win rate than 87.5%, fewer trades. Current VIX ~27 = IDEAL CONDITIONS NOW.
**Confidence:** 4/5 — peer-reviewed 2024.

### PRIORITY 2: Cross-Sectional StatArb on Sector ETFs (HIGH URGENCY)
**Source:** Industry data ($24.8B Q2 2025 inflows), SSRN Velissaris
**Concept:** Apply zscore_mean_reversion to sector ETF PAIRS where cross-sectional spread is at z-score > 2.5. Current Energy/Tech divergence (+25% vs -5%) is a perfect real-world pair.
**Target pairs now:** XLE/XLK (energy vs. tech), XLI/XLK (industrials vs. tech), XLV/XLY (healthcare vs. consumer)
**Implementation:** Run zscore_mean_reversion on spread (XLE 20d return - XLK 20d return). Use kalman_filter for hedge ratio.
**Confidence:** 5/5 — Confirmed by record industry inflows, maps to live regime divergence.

### PRIORITY 3: Statistical Jump Model Regime Gate (MEDIUM TERM)
**Source:** arXiv 2402.05272 (peer-reviewed 2024)
**Concept:** Use SJM (Sortino-ratio features + jump penalty) instead of HMM for regime detection. Halves max drawdown vs buy-and-hold. 44% turnover vs 141% for HMM.
**Performance:** S&P 500 1990–2023: Sharpe 0.68 (vs 0.48 B&H), MDD -26.6% (vs -55.2%)
**Implementation:** Upstream regime gate for all playbook strategies. SJM detected bear = all off + kalman only.
**Confidence:** 5/5 — peer-reviewed, rigorous methodology.

### PRIORITY 4: Hurst Exponent as Mean Reversion FILTER
**Source:** MDPI Mathematics 2024 (peer-reviewed)
**Concept:** Gate bb_mean_reversion or zscore entries: only enter when rolling Hurst (60-day) < 0.48. H < 0.45 = strong reversion candidate. H > 0.55 = trending (avoid).
**Note:** hurst_exponent FAILED as a standalone strategy (Sharpe -0.17) but theory suggests it has value as a filter/gate. This is a different use case.
**Implementation:** Compute rolling 60-day Hurst before any mean reversion entry. Gate entry: H < 0.48.
**Confidence:** 4/5 — peer-reviewed 2024 publication, directly composable.

### PRIORITY 5: ATR-Adaptive Entry Thresholds
**Source:** FMZ Medium 2025 practitioner
**Concept:** When ATR > 1.3x rolling mean ATR, widen williams_r entry threshold from -80 to -88 (deeper oversold required). Prevents premature mean reversion entries during genuine trending moves.
**Applicable to:** williams_r, connors_rsi2_pullback, cumulative_rsi
**Note:** Current VIX 27 environment makes this directly relevant — ATR is elevated.
**Confidence:** 4/5 — logical, low-cost to implement.

### PRIORITY 6: VWAP + OBV-RSI Volume Quality Filter
**Source:** FMZ Strategy Library 2025
**Concept:** Enhance vwap_mean_reversion by adding OBV-RSI confirmation: enter only when OBV-RSI > 45 for longs (accumulation on price weakness = high quality entry).
**Expected improvement:** Win rate from 70% → 78-82%
**Confidence:** 3/5 — practitioner-derived, needs backtest validation.

### PRIORITY 7: OU Half-Life Time Stop
**Source:** arXiv 2412.12458 (December 2024), Hudson & Thames
**Concept:** Use OU model to estimate reversion half-life (ln(2)/theta). Set maximum holding period = 2x estimated half-life. Forces exit on slow-to-revert positions before they become losers.
**Enhancement to:** zscore_mean_reversion, vwap_mean_reversion, bb_mean_reversion
**Note:** OU FAILED as a standalone strategy but has value as a timing/risk constraint mechanism.
**Confidence:** 4/5 — strong mathematical grounding.

### PRIORITY 8: Hybrid AI Ensemble (Longer-Term)
**Source:** arXiv 2601.19504 (January 2026)
**Concept:** Regime gate (EMA 50/200) → conditional strategy (mean reversion in neutral, momentum in bull) + XGBoost confirmation + FinBERT sentiment veto (suppress entries when sentiment < -0.7).
**Performance:** 135.49% return on 100 S&P 500 equities (2023–2025), Sharpe 1.68, MDD -15.6%
**Implementation complexity:** High — requires NLP infrastructure for sentiment filtering. Start with the regime gate + XGBoost layers.
**Confidence:** 4/5 — very recent arXiv (Jan 2026), large test universe.

### PRIORITY 9: HMM Ensemble Regime Upgrade
**Source:** AIMS Press 2025 (peer-reviewed)
**Concept:** Replace single regime_detection with ensemble of 3 regime classifiers (HMM + Random Forest + Gradient Boosting). Require 2/3 agreement before switching regime allocation. Prevents whipsawing at transitions.
**Performance:** NIFTY 50 (2018–2024): Sharpe 1.05, Sortino 1.51, cumulative return 44.83%
**Enhancement to:** Current regime_detection strategy
**Confidence:** 4/5 — multiple peer-reviewed 2025 publications.

---

## Rob Carver Caveat (Important Counter-Signal)

Rob Carver's March 2025 blog: slow mean reversion (3-year lookback) showed Sharpe -0.48 across futures. His prior book's mean reversion backtest contained a forward-fill error — corrected results show "no statistically significant return."

**Implication:** Mean reversion works at SHORT horizons (intraday to 5-day) where zscore and vwap strategies operate. Avoid extending mean reversion logic to multi-week/multi-month lookbacks. The strong Sharpe 2.0+ results from zscore/vwap/bb strategies are likely operating at the right short-horizon window.

---

## Next Research Priorities (Session 4)

### URGENT: Tool Fix
1. **Fix composite_backtest** — Change `strategy_name: s.name` to `name: s.name` in `src/agent/trading-mcp.ts` ~line 298. This unlocks composite testing and cuts testing time 80%.

### IMMEDIATE BACKTESTS
2. **Test poc_reversion + cumulative_rsi + connors_rsi2_pullback** on expanded universe (QQQ, AMZN, TSLA, XLE, XLK) — these are the current regime's best candidates.
3. **Test rs_momentum + time_series_momentum** on sector ETF universe (universe_id=4) — cross-sectional strategies need multi-symbol universe.
4. **Test VIX-gated zscore_mean_reversion** — zscore entry only when VIX > 22. Hypothesis: win rate improves from 87.5%.
5. **Test cross-sectional StatArb pair** — XLE/XLK spread zscore. Direct exploitation of Energy+25%/Tech-5% regime.

### CONTINUE SWEEP
6. **~93 strategies remain untested:** Candle patterns (doji, morning_evening_star, three_soldiers_crows, harami, pin_bar, fakey_pattern, three_bar_reversal, two_bar_reversal, outside_bar, key_reversal, island_reversal), harmonic patterns (abcd, gartley, bat, butterfly, crab, shark, cypher), alligator system (alligator, awesome_oscillator, ao_saucer, accelerator_oscillator, alligator_ao, gator_oscillator), williams_vix_fix, darvas_box, value_area series (value_area, value_area_breakout, developing_value_area, previous_day_va), and ~30 breakout/statistical variants.

### ML STRATEGIES
7. **Run ml_train** to unlock ml_prediction, volatility_regime, combined_signal, ml_enhanced_technical.

---

## System Notes

- `compare_strategies` tool is broken server-side. Do not use.
- `batch_backtest` tool broken (field `strategy_name` vs `name` mismatch). Use `run_backtest` for all backtesting.
- `composite_backtest` broken with same 422 error — fix in `src/agent/trading-mcp.ts` ~line 298.
- ML strategies (ml_prediction, volatility_regime, combined_signal, ml_enhanced_technical) require `ml_train` first — currently produce zero trades.
- 90-day validation is critical: strategies performing well over 12 months may be inflated by 2025 bull run. Always test 90d window to see current-regime performance.
