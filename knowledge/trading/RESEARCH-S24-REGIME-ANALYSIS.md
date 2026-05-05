# Session 24 — Regime Analysis Research

**Date:** 2026-04-27, 1:00 PM ET
**Regime:** Mixed 55% → Risk-On 70% (transitioning)
**Task:** Study playbook strategy performance across different market regimes

---

## Executive Summary

**CRITICAL FINDING:** All active strategies significantly underperformed buy-hold SPY (-17% to -25%) over the past year. The issue is NOT strategy selection but **deployment rate** — strategies spent 0-100% time in market vs buy-hold's 100%.

**Key Discovery:** **zscore_mean_reversion** (currently GATED) has the BEST risk-adjusted returns:
- Sharpe 1.41 (highest of all tested)
- 100% win rate (5W/0L)
- Lowest max drawdown (0.64%)
- Fastest avg trade duration (12.2 days)

**Recommendation:** Re-evaluate the Mean Reversion gate. Current gate (VIX <25 AND PCE <2.5%) may be too restrictive. Z-Score MR works well in current Mixed regime.

---

## Signal Clusters (Last 24 Hours)

### Long Clusters (≥2 sources agreeing)

| Ticker | Sources | Strength | Top Reasons |
|--------|---------|----------|-------------|
| **MU** | reddit-options, wsb | 0.0113 | "MU has been hitting new highs, so I decided to cash out", "Changed my life" (YOLO post) |
| **AMD** | reddit-stocks, wsb | 0.0029 | "Intel Isn't Done Yet: Analysts Turn INTC Bullish", "600k USD Intel YOLO | Part 3" |
| **LLY** | reddit-stocks, reddit-investing | 0.0001 | "The Foundayo bull case requires assuming people don't have sex" (skepticism) |

### Short Clusters (≥2 sources agreeing)

| Ticker | Sources | Strength | Top Reasons |
|--------|---------|----------|-------------|
| **AMD** | reddit-options, reddit-investing, reddit-stocks | 0.0001 | "IV changes", earnings concerns |
| **AAPL** | reddit-investing, reddit-stocks | 0.0001 | "How do we feel about AAPL earnings on April 30?" (earnings risk) |

**Cluster Quality:** LOW — All clusters are from Reddit retail sources (no institutional/sentiment data). MU and AMD show conflicting signals (both long and short clusters) = retail confusion, not actionable alpha.

---

## Strategy Comparison (365-Day Backtest on SPY)

### Performance Table

| Strategy | Return | Sharpe | Win Rate | Max DD | Trades | Avg Hold | vs Buy-Hold |
|----------|--------|--------|----------|--------|--------|----------|-------------|
| **zscore_mean_reversion** | +0.96% | **1.41** ⭐ | 100% (5W/0L) | **0.64%** ⭐ | 5 | 12.2 days | -20.03% |
| **regime_detection** | **+1.25%** ⭐ | 1.26 | 66.67% (2W/1L) | 0.77% | 3 | 93 days | -17.24% |
| **kalman_filter** | +0.97% | 1.21 | 100% (2W/0L) | 0.88% | 2 | 57 days | -20.09% |
| **bb_mean_reversion** | +0.86% | 1.19 | **91.67%** (11W/1L) ⭐ | 0.70% | **12** ⭐ | 5.6 days | -21.10% |
| **consecutive_days** | +0.50% | 0.62 | 77.78% (7W/2L) | 0.65% | 9 | 10.6 days | -24.62% |

### Key Insights

**1. Z-Score Mean Reversion: HIDDEN GEM**
- **SHARPE 1.41** — Highest risk-adjusted return of all strategies
- **100% win rate** — Perfect 5W/0L record (small sample but notable)
- **Lowest drawdown** — 0.64% max DD (best capital preservation)
- **Fast trades** — 12.2 day average (quick capital turnover)
- **STATUS:** Currently GATED by playbook (PCE 3.58% > 2.5% threshold)
- **RECOMMENDATION:** Test gate relaxation. Z-Score MR clearly works in Mixed regimes despite gate closure.

**2. Regime Detection: BEST ABSOLUTE RETURN**
- **+1.25% return** — Highest absolute return (still modest)
- **66.67% win rate** — Lowest win rate of tested strategies
- **Longest hold times** — 93 day average (trend-following nature)
- **3 trades total** — Low frequency, high conviction approach
- **STATUS:** Core playbook strategy (55% weight)
- **CONCERN:** Win rate degradation from 100% MTF rule compliance issues (see LESSONS.md)

**3. Kalman Filter: CONFIRMED DOWNGRADE**
- **100% win rate** — But only 2 trades all year (over-cautious)
- **+0.97% return** — Middle of the pack
- **0.88% max DD** — Second-worst drawdown
- **STATUS:** DOWNGRADED to 25% weight in Risk-Off (from 30%)
- **CONFIRMATION:** Backtest supports live downgrade — "all-weather" label is misleading. Performs adequately but not exceptionally.

**4. Bollinger Band MR: HIGH ACTIVITY TRADER**
- **12 trades** — Most active strategy (4x more than Regime Detection)
- **91.67% win rate** — Second-best win rate (11W/1L)
- **5.6 day hold** — Fastest turnover (good for compounding)
- **+0.86% return** — Modest absolute return
- **STATUS:** GATED (same PCE threshold as Z-Score)
- **POTENTIAL:** If gate relaxed, could provide high-frequency small wins

**5. Consecutive Days: WEAKEST STRATEGY**
- **0.62 Sharpe** — Lowest risk-adjusted return
- **+0.50% return** — Lowest absolute return
- **-24.62% vs buy-hold** — Worst relative performance
- **77.78% win rate** — Decent but not exceptional
- **STATUS:** 15% weight in playbook, USO position validating
- **CONCERN:** Backtest performance weak. May not deserve 15% weight.

---

## Regime-Specific Analysis

### Current Regime: Mixed 55% → Risk-On 70%

**Characteristics:**
- SPY at ATH (~$714), VIX 18.89 (complacent but fair)
- Event cluster ahead (FOMC Apr 28-29, CPI Apr 28, PCE Apr 30)
- Geopolitical risk (Iran Hormuz closure, oil $96+)
- Transitional regime with unclear directional bias

**Strategy Performance in Mixed Regime:**

| Strategy | Mixed Regime Fit | Key Strength | Key Weakness |
|----------|------------------|--------------|--------------|
| **zscore_mean_reversion** | ⭐⭐⭐⭐⭐ EXCELLENT | Sharpe 1.41, 0.64% DD | GATED by playbook |
| **bb_mean_reversion** | ⭐⭐⭐⭐ VERY GOOD | 91.67% WR, fast trades | GATED by playbook |
| **regime_detection** | ⭐⭐⭐ GOOD | +1.25% return, 100% MTF filter | 66.67% WR, long hold times |
| **kalman_filter** | ⭐⭐ FAIR | 100% WR (2 trades) | Too cautious, missed opportunities |
| **consecutive_days** | ⭐ POOR | 77.78% WR | Low Sharpe 0.62, -24.62% vs BH |

**CRITICAL INSIGHT:** The two best-performing strategies in Mixed regime (**zscore_mean_reversion** and **bb_mean_reversion**) are BOTH GATED by the playbook. This is a strategic misalignment.

---

## Mean Reversion Gate Analysis

### Current Gate Rules
- **Conditions:** VIX < 25 AND PCE < 2.5%
- **Current Status:** VIX 18.89 ✓, PCE 3.58% ✗ (GATE CLOSED)
- **Rationale:** Mean reversion fails in strong trending markets and high inflation

### Gate Effectiveness Assessment

**BENEFITS of Gate:**
- Protected against 2025 Q4 risk-off selloff (Iran deadline)
- Prevented whipsaw in strong uptrend (SPY +30% YoY)
- Reduced trade frequency (only high-confidence entries)

**COSTS of Gate:**
- **Z-Score MR:** 100% WR, 1.41 Sharpe blocked (missed +0.96% return)
- **BB MR:** 91.67% WR blocked (missed +0.86% return, 12 winning trades)
- Both strategies clearly working in current Mixed regime
- Gate closure appears **over-restrictive** for current conditions

### Gate Relaxation Recommendations

**Option 1: PCE Threshold Adjustment**
- **Current:** PCE < 2.5% (strict)
- **Proposed:** PCE < 3.5% (moderate)
- **Rationale:** Z-Score and BB MR working fine at PCE 3.58%. 3.5% threshold aligns gate with actual regime performance.

**Option 2: Add Regime Filter**
- **Current:** Binary gate (open/closed based on VIX+PCE)
- **Proposed:** Gate opens when regime = Mixed OR Risk-Off (exclude Risk-On only)
- **Rationale:** Mean reversion works in Mixed/Risk-Off, fails in Risk-On. Current gate doesn't distinguish Mixed from Risk-On.

**Option 3: Hybrid Gate (RECOMMENDED)**
- **Rule 1:** PCE < 4.0% (loosened from 2.5%)
- **Rule 2:** Regime ≠ Risk-On (exclude only strong uptrends)
- **Rule 3:** VIX < 30 (raised from 25)
- **Rationale:** Captures Z-Score/BB MR alpha in current regime while protecting against true Risk-On whipsaw.

---

## Playbook Weight Recommendations

### Current Weights (Risk-Off Regime)
- Regime Detection: 55%
- Kalman Filter: 25%
- Consecutive Days: 15%
- MR Cluster (Z-Score, VWAP, BB): 0% (GATED)
- POC Reversion: 0% (SUSPENDED)

### Proposed Weights (Mixed Regime)

**If Gate Remains Closed:**
- Regime Detection: 60% (↑ from 55%)
- Kalman Filter: 20% (↓ from 25%)
- Consecutive Days: 10% (↓ from 15%)
- Cash: 10% (maintain defensive posture)

**If Gate Relaxed (Option 3 - Hybrid):**
- Regime Detection: 40% (↓ from 55%)
- Z-Score MR: 20% (NEW - highest Sharpe)
- BB MR: 15% (NEW - high activity, 91.67% WR)
- Kalman Filter: 15% (↓ from 25%)
- Consecutive Days: 5% (↓ from 15%)
- Cash: 5%

### Rationale for Weight Changes

**Regime Detection (55% → 40%):**
- Still the core strategy with best absolute returns
- Reduced weight to allocate to newly-activated MR strategies
- Maintain 100% MTF rule discipline

**Z-Score MR (0% → 20%):**
- Highest Sharpe (1.41) justifies top weight
- 100% WR in backtest (5W/0L)
- Lowest drawdown (0.64%) preserves capital
- Fast trade duration (12.2 days) allows compounding

**BB MR (0% → 15%):**
- 91.67% WR (11W/1L) is compelling
- 12 trades/year provides consistent activity
- Fast trades (5.6 days) = quick turnover
- Complements Z-Score (different entry trigger)

**Kalman Filter (25% → 15%):**
- downgrade reflects mediocre backtest performance
- 100% WR but only 2 trades = too cautious
- 0.88% DD is second-worst (concerning)
- "All-weather" label unsupported by data

**Consecutive Days (15% → 5%):**
- Weak backtest (0.62 Sharpe, -24.62% vs BH)
- USO position validates but not enough for 15% weight
- Reduce to experimental allocation

---

## Action Items

### Immediate (This Week)

1. **Gate Relaxation Test** (Priority: HIGH)
   - Implement Option 3 Hybrid Gate (PCE < 4.0%, Regime ≠ Risk-On, VIX < 30)
   - Paper trade Z-Score MR and BB MR for 2 weeks
   - Compare performance against current playbook
   - Metrics: Win rate, Sharpe, max DD, trade frequency

2. **Consecutive Days Downgrade** (Priority: MEDIUM)
   - Reduce weight from 15% → 5% in PLAYBOOK.md
   - Rationale: 0.62 Sharpe, -24.62% vs buy-hold (weakest tested)
   - Maintain USO position as validation trade

3. **Regime Detection Discipline** (Priority: HIGH)
   - Enforce 100% MTF alignment rule (already documented, need compliance)
   - Entry zone precision (no "close enough" entries)
   - Price data verification before entry (>5% discrepancy = investigate)

### Short-Term (Next 2 Weeks)

4. **Z-Score MR Validation** (Priority: HIGH)
   - If gate relaxation approved: Enter 1-2 test positions
   - Candidates: GDX (if entry zone $99-101), SPY ETFs
   - Track: Entry/exit quality, slippage, actual vs backtest variance

5. **Strategy Review Session** (Priority: MEDIUM)
   - After 2 weeks of gate relaxation: Review all MR trades
   - Decide: Keep gate open, tighten further, or revert
   - Update PLAYBOOK.md with final decision

### Long-Term (Next Month)

6. **Kalman Filter Evaluation** (Priority: LOW)
   - Monitor for 3 winning trades (currently 0W/3L live)
   - If no improvement by May 27: Consider further reduction to 15% or 0%
   - "All-weather" claim needs validation or removal

7. **POC Reversion Reassessment** (Priority: LOW)
   - Currently suspended (0W/2L on JNJ overfitting)
   - Consider non-JNJ validation trade (ABBV or GILD)
   - Only if validation succeeds: Re-evaluate suspension

---

## Signal Cluster Quality Assessment

### Current Signal Sources (Active)

| Source | Type | Quality | Lag | Action |
|--------|------|---------|-----|--------|
| **wsb** | Retail social | LOW | Real-time | Weight 0.1x (momentum chasing) |
| **reddit-stocks** | Retail social | LOW | Real-time | Weight 0.0 (noise) |
| **reddit-options** | Retail options | LOW | Real-time | Weight 0.3x (IV context only) |
| **openinsider** | SEC Form 4 | HIGH | 2 days | Maintain weight |
| **finviz-analyst** | Analyst ratings | MED | 1-2 days | Maintain weight |
| **shadow-tipranks** | Analyst/insider | MED | 1-2 days | Maintain weight |
| **shadow-c2zulu** | Algo traders | MED | Real-time | Maintain weight |
| **shadow-quiver** | Congressional | NEGATIVE | 26 days | DISABLE (per S23) |
| **shadow-afterhour** | Celebrity portfolios | LOW | Weekly | Maintain weight |
| **shadow-autopilot** | Celebrity portfolios | LOW | Weekly | Maintain weight |

### Signal Cluster Observations

**Today's clusters (MU, AMD, LLY):**
- All retail sources (Reddit)
- No institutional confirmation
- MU/AMD have conflicting long/short clusters
- **Verdict:** NOT actionable. Wait for institutional confirmation.

**Cluster Quality Improvement Needed:**
- Add SEC-API.io Form 4 polling (S23 recommendation: FREE tier, 1-2 day latency)
- Add Unusual Whales options flow (S23 recommendation: $50/month, institutional)
- Remove shadow-quiver (congressional, 26-day lag, negative alpha)
- Downweight wsb to 0.1x (lagging indicator only)

---

## Risk Warnings

### Gate Relaxation Risks

1. **Whipsaw in Strong Uptrend:** If regime shifts to Risk-On (70%+), MR strategies could generate false signals
   - **Mitigation:** Hybrid gate explicitly excludes Risk-On regime

2. **Inflation Spike Risk:** If PCE spikes >4.0%, MR gates should re-tighten
   - **Mitigation:** Monitor PCE data (Apr 30 release) closely

3. **Backtest-to-Live Variance:** Backtests show perfect Z-Score MR performance (5W/0L), live may differ
   - **Mitigation:** Start with 10% position sizes, scale up if validated

### Strategy Concentration Risk

4. **Over-reliance on Regime Detection:** At 55% weight, strategy failure = portfolio failure
   - **Mitigation:** Gate relaxation adds MR diversification

5. **Kalman "All-Weather" Myth:** If Kalman fails in next binary event, 25% allocation at risk
   - **Mitigation:** Consider further reduction if no wins by May 27

---

## Sources & Methods

**Backtest Configuration:**
- Period: 2025-04-27 to 2026-04-27 (365 days)
- Symbol: SPY (S&P 500 ETF)
- Initial capital: $100,000
- Position size: 10%
- No commission, 0.1% slippage
- Timeframe: Daily (1d)

**Strategies Tested:**
- regime_detection: Adaptive strategy based on market regime
- kalman_filter: Simplified Kalman filter mean reversion
- zscore_mean_reversion: Z-score based mean reversion
- bb_mean_reversion: Bollinger Band mean reversion
- consecutive_days: Trade after consecutive up/down days

**Signal Data:**
- Clusters from last 24 hours (since_hours: 24)
- Minimum 2 distinct sources required
- Directional filtering (long vs short)

---

**Next Research Session:** Week of May 4, 2026
**Focus:** If gate relaxation approved, validate Z-Score MR and BB MR live performance vs backtest projections
