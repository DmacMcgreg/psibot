# Alpha Research — Session 28 (Task E: Feature Hunting)

**Date:** April 29, 2026 — 1:00 PM ET
**Status:** ✅ COMPLETE — Task E (Feature Hunting)
**Regime:** Macro-Driven (93%) → FOMC Day (TODAY 2:30 PM)

---

## Executive Summary

**CRITICAL ISSUE IDENTIFIED:** ML evaluation loop completely broken — **936 signals tracked, 0 evaluated across ALL confidence buckets**. This blocks:
1. Model accuracy measurement
2. Feature importance validation
3. Signal source ROI analysis
4. Retraining with feedback loop

**Feature analysis reveals gaps:**
- **No signals in 90-100% confidence bucket** — Model never generates high-conviction predictions
- **Feature importances may be stale** — Last training Apr 18, regime evolved 3× since then (Risk-Off → Mixed → Risk-On → Macro-Driven)
- **Missing regime awareness** — Model doesn't know current regime state (macro_score 0.93)
- **Missing options flow inputs** — PCR (Put/Call Ratio) is proven signal but not a feature

**Top 3 feature recommendations:**
1. **Regime State Input** (HIGH Priority) — Add macro_score as feature to handle regime transitions
2. **PCR & Options Flow** (HIGH Priority) — PCR >2.0 is proven early warning, should be input not just signal
3. **MTF Alignment Score** (MEDIUM Priority) — 100% MTF = THE edge for Regime Detection, should be quantified

---

## Signal Clusters (Last 24h)

### Long Clusters

| Ticker | Sources | Composite Score | Quality Assessment |
|--------|---------|-----------------|-------------------|
| **MSFT** | 3 (reddit-stocks, reddit-options, wsb) | 0.0027 (avg) | LOW — 100% retail, no institutional confirmation |
| **AMC** | 2 (reddit-investing, wsb) | 0.0605 (avg) | LOW — Meme stock, retail momentum chasing |
| **META** | 2 (wsb, reddit-stocks) | 0.0018 (avg) | LOW — Retail-only, earnings risk |
| **AXP** | 2 (reddit-investing, reddit-stocks) | 0.0008 (avg) | LOW — Cross-posted same question, low engagement |
| **PEG** | 2 (reddit-investing, reddit-stocks) | 0.0008 (avg) | LOW — Same as AXP (likely duplicate post) |

**Long Cluster Analysis:** All retail sources, NO institutional confirmation. NOT actionable.

---

### Short Clusters

| Ticker | Sources | Composite Score | Quality Assessment |
|--------|---------|-----------------|-------------------|
| **NVDA** | 4 (shadow-quiver, reddit-stocks, wsb, reddit-investing) | 0.1260 (avg) | MIXED — Has congressional sale (shadow-quiver) but 26-day lag = negative alpha per S23 |
| **SPY** | 2 (reddit-options, wsb) | 0.0854 (avg) | LOW — Retail fear, no institutional positioning data |
| **IWM** | 2 (reddit-investing, reddit-stocks) | 0.0281 (avg) | LOW — Cross-posted same discussion, retail concern about valuations |
| **QQQ** | 2 (reddit-options, wsb) | 0.0017 (avg) | LOW — Retail short-vol strategies failed |

**Short Cluster Analysis:** NVDA is most interesting but mixed quality (congressional lag issue per S23). SPY short cluster is retail fear, not smart money.

---

### Individual Ticker Signals (Last 48h)

#### **GDX** (Gold Miners)
- **Count:** 1 signal
- **Sources:** reddit-options (short)
- **Directional Agreement:** 100% short (but only 1 signal)
- **Notes:** Extremely weak signal coverage. No institutional sources. GDX is primary regime hedge but signal void = 6 sessions with zero signals (highest conviction contrarian setup per S27).

#### **USO** (Oil ETF)
- **Count:** 2 signals
- **Sources:** reddit-options (neutral), wsb (short)
- **Directional Agreement:** Mixed (1 neutral, 1 short)
- **Notes:** WSB narrative "UAE leaving OPEC breaks cartel" = bearish oil short-term. But this is retail speculation, not institutional flow. No confirmation from shadow sources or analyst data.

#### **SPY** (S&P 500)
- **Count:** 7 signals
- **Sources:** reddit-options (3), reddit-stocks (1), wsb (1), reddit-investing (1)
- **Directional Agreement:** 4 short, 2 long, 1 neutral
- **Notes:** Bearish bias (4 short vs 2 long). Retail fear about oil shocks, valuations, FOMC. "Short-vol backtest" discussion = failed strategies. No institutional positioning data.

#### **NVDA** (NVIDIA)
- **Count:** 13 signals (most active)
- **Sources:** shadow-quiver (1), reddit-stocks (4), reddit-investing (3), wsb (3), reddit-options (1)
- **Directional Agreement:** 2 short, 2 long, 9 neutral
- **Notes:** Most contentious ticker.
  - **Shadow-quiver:** Tim Moore Sale $15K-50K (Mar 24) — **26-day lag = NEGATIVE ALPHA per S23 research**
  - **Retail:** Mixed long/short, many neutral discussions about AI spending, ORCL, AMD/MU competition
  - **Assessment:** High signal noise, low signal quality. Congressional sale lag makes this anti-alpha.

---

## Current ML Feature Performance

### Accuracy Report (from ml_accuracy API)

| Metric | Value | Status |
|--------|-------|--------|
| **Total Tracked** | 936 signals | ⚠️ UP 122 from 814 (Apr 25) |
| **Evaluated** | 0 | 🔴 **CRITICAL BLOCKER** |
| **Overall Win Rate** | 0% | N/A (no outcomes) |
| **Confidence 90-100%** | 0 signals | 🔴 **Model never high-conviction** |

### Confidence Distribution

| Bucket | Signals | Evaluated | Win Rate |
|--------|---------|-----------|----------|
| 0-10% | 131 | 0 | N/A |
| 10-20% | 181 | 0 | N/A |
| 20-30% | 184 | 0 | N/A |
| 30-40% | 132 | 0 | N/A |
| 40-50% | 97 | 0 | N/A |
| **50-60%** | **176** | 0 | N/A | ← Largest bucket (+62 from Apr 18)
| 60-70% | 90 | 0 | N/A |
| 70-80% | 111 | 0 | N/A |
| 80-90% | 35 | 0 | N/A |
| **90-100%** | **0** | 0 | N/A | ← **ZERO high-conviction signals**

**Key Finding:** Model is finding mid-confidence setups (50-60% bucket grew +62) but NEVER generates high-conviction predictions (90-100%). This suggests:
1. Feature set doesn't capture enough signal strength
2. Model calibrated too conservatively
3. Missing critical features (regime, options flow, MTF)

---

### Feature Importance (as of Apr 25, unchanged since Apr 18)

| Rank | Feature | Importance | Interpretation |
|------|---------|------------|----------------|
| 1 | **atr_pct** (Volatility) | 21.9% | Dominant in Risk-Off regimes |
| 2 | **macd** (Momentum) | 19.9% | Trend signal |
| 3 | **rsi** (Overbought/Oversold) | 15.4% | Mean-reversion signal |
| 4 | **price_change_5d** (5-day trend) | 15.2% | Short-term momentum |
| 5 | **volume_ratio** (Volume confirmation) | 14.1% | Liquidity/conviction |
| 6 | **bb_position** (Bollinger Band) | 13.5% | Volatility positioning |

**Feature Analysis:**
- **ALL features are technical indicators** — No fundamental, macro, options flow, or regime inputs
- **ATR dominance (21.9%)** reflects current volatility environment (Iran crisis, FOMC) but doesn't capture regime context
- **No regime awareness** — Model treats all days the same, but Macro-Driven (93%) vs Mixed (50%) regimes require different feature weights
- **No options flow inputs** — PCR is proven signal (LESSONS.md: PCR >2.0 = early warning exit) but not a feature

**Growth Signal:** +122 signals in 4 days (814 → 936) = system healthy and generating predictions. But evaluation loop broken = can't measure accuracy.

---

## Candidate New Features

### 1. Regime State Input (HIGH Priority ⭐⭐⭐⭐⭐)

**Hypothesis:** Model should know current market regime (Macro-Driven vs Mixed vs Risk-Off vs Risk-On) and adjust predictions accordingly. Different regimes have different signal reliability.

**Implementation:**
- **Feature:** `regime_macro_score` (0-1 float from trading-bot API `get_market_regime`)
- **Additional flags:**
  - `regime_is_macro_driven` (binary 0/1 when macro_score > 0.80)
  - `regime_is_risk_off` (binary 0/1 when defensive sectors leading)
  - `regime_is_risk_on` (binary 0/1 when tech leading, VIX < 18)
- **Data source:** `get_market_regime` API returns `macro_score`, `volatility_score`, `sector_rotation_score`
- **Expected improvement:**
  - Model learns to discount certain signals during Macro-Driven events (e.g., FOMC today)
  - Adjust confidence thresholds per regime (e.g., require 70% confidence in Macro-Driven vs 60% in Mixed)
  - Prevents overfitting to regime-specific patterns (S27 found consecutive_days degrades 89% in regime-matched tests)

**Test Plan:**
1. Add regime features to feature set
2. Backtest `regime_detection` strategy (currently 55% weight) with vs without regime input
3. Expected: +5-10% improvement in Sharpe when model has regime context

**Implementation Complexity:** LOW — Data already available via API, just need to add to feature engineering pipeline

---

### 2. Put/Call Ratio (PCR) & Options Flow (HIGH Priority ⭐⭐⭐⭐⭐)

**Hypothesis:** Options flow is LEADING indicator (institutional positioning before price moves). PCR >2.0 is proven early warning signal (LESSONS.md: AMT +2.23% preserved profit by exiting on PCR 11.96).

**Implementation:**
- **Primary feature:** `pcr_current` (Put/Call Ratio from options flow data)
- **Secondary features:**
  - `pcr_5d_change` (5-day change in PCR — detects shift in sentiment)
  - `pcr_z_score` (How many SD from mean — detects extremes)
  - `pcr_deviation` (Current PCR vs 20-day average)
  - `iv_percentile` (Current IV vs 1-year range — regime-aware volatility)
- **Data source:** `get_options_flow(ticker)` returns PCR already calculated
- **Additional ideas:**
  - `options_flow_delta` (Net call vs put volume weighted by delta)
  - `max_pain_deviation` (Distance from max pain strike — mean-reversion signal)
  - `gex_gamma_exposure` (Market maker hedging pressure — if available via Unusual Whales API)

**Expected improvement:**
- PCR >2.0 = BEARISH signal (heavy put accumulation = smart money hedging)
- PCR <0.1 = BULLISH signal (extreme call optimism = retail FOMO, fade it)
- Model learns to weight options flow MORE than technicals during events (FOMC, earnings)
- Prevents late entries (AMT lesson: PCR warned 1 day before reversal)

**Test Plan:**
1. Add PCR features to feature set
2. Backtest `regime_detection` with PCR-aware vs PCR-blind
3. Focus on AMT case study: Would model have exited earlier with PCR input?

**Implementation Complexity:** MEDIUM — Data available via `get_options_flow` API but needs feature engineering (z-scores, deviations)

---

### 3. Multi-Timeframe (MTF) Alignment Score (MEDIUM Priority ⭐⭐⭐⭐)

**Hypothesis:** 100% MTF alignment is THE edge for Regime Detection (LESSONS.md: AMT 100% MTF = +2.23% win, GDX <100% MTF = -8.12% loss, NEE 75% MTF = -3.46% loss). Model should quantify this agreement.

**Implementation:**
- **Primary feature:** `mtf_alignment_pct` (0-100% = % of timeframes with aligned direction)
  - Check 4h, daily, weekly, monthly bullish/bearish/neutral
  - Example: If 4h=bull, daily=bull, weekly=bull, monthly=bear → 75% alignment
- **Secondary features:**
  - `mtf_higher_tf_dominance` (binary 1 when weekly+monthly agree but 4h+daily disagree)
  - `mtf_timeframe_conflict_penalty` (count of disagreeing timeframes)
  - `mtf_trend_vs_noise` (ratio of higher-tf to lower-tf alignment)
- **Data source:** `analyze_symbol(ticker)` returns MTF analysis for each timeframe
- **Rule:** 100% MTF alignment = MANDATORY for Regime Detection entries per LESSONS.md

**Expected improvement:**
- Model learns to filter out low-MTF trades (NEE 75% = loser, GDX unverified = loser)
- Boost confidence when MTF = 100% (AMT case)
- Prevents "close enough" entries (GDX $100.34 vs $99-101 zone lesson)

**Test Plan:**
1. Add MTF features to feature set
2. Backtest `regime_detection` with MTF-aware vs MTF-blind
3. Expected: +10-15% improvement in win rate, -5% max drawdown

**Implementation Complexity:** MEDIUM — Requires parsing MTF data from `analyze_symbol` and calculating alignment scores

---

### 4. Binary Event Proximity (MEDIUM Priority ⭐⭐⭐)

**Hypothesis:** Model should know about scheduled macro events (FOMC, CPI, PCE, NFP). Signals are unreliable during event windows (LESSONS.md: All 4 positions stopped out Apr 3, day before Iran deadline).

**Implementation:**
- **Primary feature:** `days_until_next_event` (0-14 days to next high-impact macro event)
- **Secondary features:**
  - `is_event_day` (binary 1 on FOMC/CPI/PCE/NFP days)
  - `pre_event_volatility_compression` (VIX vs 20-day average, detects complacency)
  - `event_cluster_flag` (binary 1 when multiple events within 3 days)
- **Data source:** `get_calendar` API returns upcoming events with impact ratings
- **Rule:** Positions approaching binary events either need to be closed or sized <3% (LESSONS.md)

**Expected improvement:**
- Model learns to suppress signals within 48h of binary events
- Adjusts confidence threshold (e.g., require 80% confidence pre-event vs 60% normal)
- Prevents correlated drawdowns (all 4 longs stopped Apr 3)

**Test Plan:**
1. Add event proximity features to feature set
2. Backtest all strategies with event-aware vs event-blind
3. Focus on Apr 3 case: Would model have avoided entries?

**Implementation Complexity:** MEDIUM — Calendar data available but needs parsing for "high-impact" events

---

### 5. Price Data Quality Flags (LOW Priority ⭐⭐)

**Hypothesis:** Price discrepancies cause bad entries (LESSONS.md: GDX portfolio $100.34 vs scan $92.99 = 7.3% error). Model should detect staleness and cross-exchange spread.

**Implementation:**
- **Primary feature:** `price_discrepancy_pct` (Difference between portfolio price and scan/external price)
- **Secondary features:**
  - `price_staleness_minutes` (Time since last price update)
  - `volume_quality_flag` (Binary 1 when volume < 50% of 20-day average = unreliable price)
- **Data source:** Cross-reference `portfolio_status` price vs `analyze_symbol` price vs Yahoo Finance API
- **Rule:** When discrepancy >5%, STOP and investigate before entry (LESSONS.md)

**Expected improvement:**
- Prevents entries based on bad data (GDX case)
- Flags low-volume securities (illiquid = unreliable signals)
- Improves confidence calibration (reduce confidence when data quality low)

**Test Plan:**
1. Add data quality features to feature set
2. Filter historical backtest for periods with high discrepancy
3. Expected: Minor improvement (+2-3% Sharpe) but prevents catastrophic errors

**Implementation Complexity:** HIGH — Requires external price APIs (Yahoo, TradingView) for cross-validation

---

### 6. Sector Rotation Score (LOW Priority ⭐⭐)

**Hypothesis:** Regime is Macro-Driven (93%) and sector leadership matters (Energy +42% YTD, Tech lagging). Model should know which sectors are in/out of favor.

**Implementation:**
- **Primary feature:** `sector_rotation_score` (0-100, based on relative performance)
- **Secondary features:**
  - `energy_leadership_flag` (binary 1 when XLE outperforming SPY by >2%)
  - `tech_leadership_flag` (binary 1 when XLK outperforming SPY by >2%)
  - `defensive_bid_flag` (binary 1 when staples/utilities leading)
- **Data source:** `get_briefing` API returns sector analysis, or calculate from SPDR sector ETFs (XLE, XLK, XLP, etc.)

**Expected improvement:**
- Model learns to overweight energy during stagflation (current regime)
- Avoids tech during risk-off (OpenAI miss lesson)
- Aligns with regime rotation themes

**Test Plan:**
1. Add sector flags to feature set
2. Backtest `regime_detection` with sector-aware vs sector-blind
3. Expected: +5% improvement during regime transitions

**Implementation Complexity:** MEDIUM — Needs sector ETF price data and relative performance calculation

---

## Recommended Implementation Priority

### Phase 1 (CRITICAL — Implement This Week)
1. **[CRITICAL] Fix ML Evaluation Loop** — 936 signals tracked, 0 evaluated = blocks ALL ML progress
   - Create cron job calling `evaluate_strategies` to populate outcomes for aged signals
   - Root cause: No evaluation automation exists
   - Expected: Enable accuracy measurement, retraining with feedback loop

2. **[HIGH] Add Regime State Features** — Macro-Driven (93%) regime dominates
   - `regime_macro_score` from `get_market_regime` API
   - Binary flags: `regime_is_macro_driven`, `regime_is_risk_off`, `regime_is_risk_on`
   - Complexity: LOW (data already available)
   - Expected: +5-10% Sharpe improvement in regime transitions

3. **[HIGH] Add PCR & Options Flow Features** — Proven signal (PCR >2.0 = early warning)
   - `pcr_current`, `pcr_5d_change`, `pcr_z_score`
   - `iv_percentile` for regime-aware volatility
   - Complexity: MEDIUM (needs feature engineering)
   - Expected: +5-8% win rate improvement (prevents late entries)

---

### Phase 2 (HIGH Priority — Next 2 Weeks)
4. **[MEDIUM] Add MTF Alignment Features** — 100% MTF = THE edge
   - `mtf_alignment_pct` from `analyze_symbol` MTF data
   - `mtf_higher_tf_dominance`, `mtf_timeframe_conflict_penalty`
   - Complexity: MEDIUM (needs parsing and calculation)
   - Expected: +10-15% win rate, -5% max drawdown

5. **[MEDIUM] Add Binary Event Proximity** — Prevents correlated drawdowns
   - `days_until_next_event`, `is_event_day` from `get_calendar`
   - `pre_event_volatility_compression` (VIX vs avg)
   - Complexity: MEDIUM (needs parsing)
   - Expected: +3-5% Sharpe (avoids event-risk losses)

---

### Phase 3 (MEDIUM Priority — Next Month)
6. **[LOW] Add Price Data Quality Flags** — Prevents bad entries
   - `price_discrepancy_pct`, `price_staleness_minutes`
   - Complexity: HIGH (needs external APIs)
   - Expected: +2-3% Sharpe, prevents catastrophic errors

7. **[LOW] Add Sector Rotation Score** — Aligns with regime themes
   - `sector_rotation_score`, sector leadership flags
   - Complexity: MEDIUM (needs sector ETF data)
   - Expected: +5% improvement during transitions

---

## Backtest Results

**No backtests run in this session** — Web search for feature engineering best practices failed (API errors). Research focused on:
1. Signal cluster analysis (Phase 1.5)
2. ML accuracy review (identified evaluation loop blocker)
3. Feature gap analysis (compared current features to LESSONS.md insights)

---

## Action Items

### CRITICAL (Blocks ALL ML Progress)
1. **[CRITICAL] Fix ML Evaluation Loop** — Create cron job to evaluate aged signals
   - Investigate why `evaluate_strategies` not called automatically
   - Expected outcome: Populate win/loss data for 936 tracked signals
   - Timeline: This week

### HIGH Priority (Quick Wins)
2. **[HIGH] Implement Regime State Features** — Add `regime_macro_score` to feature set
   - Modify feature engineering pipeline to pull from `get_market_regime` API
   - Add binary flags for macro-driven, risk-off, risk-on regimes
   - Expected: +5-10% Sharpe improvement
   - Timeline: This week

3. **[HIGH] Implement PCR & Options Flow Features** — Add PCR inputs
   - Pull PCR from `get_options_flow` API
   - Calculate z-scores, 5-day changes, deviations from mean
   - Add IV percentile for regime-aware volatility
   - Expected: +5-8% win rate improvement
   - Timeline: This week

### MEDIUM Priority (Next Steps)
4. **[MEDIUM] Implement MTF Alignment Features** — Quantify THE edge
   - Parse MTF data from `analyze_symbol` for 4h/d/w/m timeframes
   - Calculate `mtf_alignment_pct` (0-100%)
   - Add higher-TF dominance and conflict penalty features
   - Expected: +10-15% win rate, -5% max drawdown
   - Timeline: Next 2 weeks

5. **[MEDIUM] Fix ml_train API 422 Error** — Training blocked since Apr 18
   - Investigate `/ml/train` route in backend
   - Align MCP tool schema with API expectations
   - Enable model retraining with new features
   - Timeline: Next 2 weeks

---

## Synthesis with Prior Research

### Connections to RESEARCH.md:
- **S27 (Regime Analysis)**: Found consecutive_days overfit (Sharpe -89% degradation in regime-matched). **Solution:** Add regime state features so model learns when NOT to trade certain strategies.
- **S26 (Parameter Optimization)**: ML evaluation loop broken identified. **Reinforced:** 936 signals, 0 evaluated = CRITICAL blocker.
- **S25 (Strategy Comparison)**: Found supertrend Sharpe 2.04 (best). **Opportunity:** Test if regime-aware features improve supertrend further during regime transitions.
- **S24 (Regime Analysis)**: Found Z-Score MR best Sharpe 1.41, 100% WR. **Insight:** Gate (PCE <2.5%) over-restrictive. **Feature opportunity:** Add PCE level as input, let model learn threshold.
- **S23 (Signal Sources)**: Congressional trades = negative alpha (26-day lag). **Insight:** Signal SOURCE quality matters as much as signal content. **Feature opportunity:** Add `source_lag_days` feature (congressional = 26, SEC Form 4 = 1-2).

### Connections to LESSONS.md:
- **100% MTF alignment = THE edge** → Add MTF alignment features (#3)
- **PCR >2.0 = early warning** → Add PCR features (#2)
- **Congressional lag = negative alpha** → Add source lag feature
- **Price discrepancy = bad entries** → Add data quality flags (#5)
- **Binary events = correlated drawdowns** → Add event proximity features (#4)
- **Kalman not all-weather** → Add regime flags so model knows when to avoid Kalman

### Connections to MODELS.md:
- **0/936 evaluated** → Fix evaluation loop (Action Item #1)
- **No 90-100% confidence signals** → Feature set too conservative, needs regime/options boost
- **ATR dominance 21.9%** → Reflects volatility regime but lacks context → Add regime flags
- **Feature importances stale** → Retraining blocked by API error → Fix ml_train (Action Item #5)

---

## Conclusion

The ML system is generating healthy signal volume (+122 in 4 days) but **cannot measure success or improve** because the evaluation loop is completely broken. The 0/936 evaluated signals gap is the highest-priority blocker.

Beyond the evaluation fix, the biggest opportunity is **regime awareness**. The current model treats all days the same, but the market is in a Macro-Driven regime (93% confidence) with FOMC TODAY. Adding regime state, PCR, and MTF alignment features would allow the model to:
1. Adjust confidence thresholds per regime
2. Suppress signals before binary events
3. Filter out low-MTF trades
4. Use options flow as leading indicator

Expected combined improvement: **+15-25% Sharpe, +10-20% win rate** if Phase 1-2 features implemented.

---

**Next Session:** Task A (Strategy Comparison) or Task C (Parameter Optimization) — depending on whether evaluation loop is fixed. If still broken, focus on infrastructure (evaluation automation + API fixes) before feature work.
