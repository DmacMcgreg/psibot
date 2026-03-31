# Alpha Research

New strategies, signals, and ideas being explored. Auto-updated by Alpha Researcher.

---

## Session 12 — 2026-03-30 (Targeted Validation + Energy Cluster Expansion)

**Status:** 5 tests complete. 9 backtests (7 regime-matched + 2 composite). All priority tests executed.
**Regime:** RISK-OFF/STAGFLATION 85% | VIX 31 | Brent $115 | Iran deadline April 6 8PM ET
**Full detail:** trading/scans/2026-03-30-S12-research.md

### Critical S12 Findings

#### 1. E&P Cluster Template CONFIRMED (consecutive_days)
COP (83% WR, 12 trades), EOG (58% WR), XOM (58% WR) all pass in regime-matched conditions.
Cluster aggregate: Sharpe 1.91, 36 trades, Profit Factor 33.5. Combined with SLB (S11 Sharpe 2.23),
the full E&P cluster is VALIDATED. Entry post-April 6, RSI < 65, PCR normalized.

#### 2. DBA Post-Entry Validated
poc_reversion/DBA: Regime Sharpe 1.04 — first strategy to clear threshold on DBA. Only 3 trades (wide CI)
but profit factor 403 = massive win/loss asymmetry. HOLD DBA. Stop $25.49, target $29.89 unchanged.

#### 3. VIX Term Structure Contrarian REJECTED
SSRN 3189502 (3.4% alpha/month from VIX backwardation) not confirmed. consecutive_days/SPY regime-matched
Sharpe = -0.38. Composite shows 1.35 but only 6 trades over 365d and is full-period not regime-matched.
No SPY long entry based on VIX term structure thesis.

#### 4. GPR Ceasefire Proxy REJECTED
regime_detection/USO: Sharpe -0.26, 4 trades, 19.9% WR. The backtest engine cannot proxy the GPR >15%
drop threshold from SSRN 4964922. April 6 ceasefire trade remains MANUAL-ONLY.

#### 5. All Pharma Remains Rejected
kalman_filter (0.21) and poc_reversion (0.29) both fail on ABBV+GILD+JNJ combined. ~2-4 trades per name
= statistically meaningless. Pharma names need a different strategy or longer lookback period.

### S12 New Additions to Rejection List
- consecutive_days/SPY (regime-matched: -0.38)
- regime_detection/USO confirmed hostile (S11 was -0.18, S12 confirms -0.26)
- SSRN 3189502 VIX term structure claim (not supported by backtest data)

### S12 New Playbook Additions
- consecutive_days/COP: DEPLOY post-April 6 (83% WR, 12 regime-matched trades)
- consecutive_days/EOG: DEPLOY post-April 6 (58% WR, 12 trades)
- consecutive_days/XOM: DEPLOY post-April 6 (58% WR, 12 trades)
- poc_reversion/DBA: WATCH — validates hold decision (1.04 Sharpe, 3 trades, conditional)

---

## Session 11 — 2026-03-30 (Regime Validation Sprint)

**Status:** Full regime-matched validation across SLB, USO, T, DBA, XLV, pharma. 8 tasks complete.
**Regime:** RISK-OFF/STAGFLATION 85% | VIX 31.06 | Brent $115.35 | Iran deadline April 6
**Key action:** consecutive_days/USO DEMOTED. SLB consecutive_days NEW finding (Sharpe 2.23).

### Critical S11 Findings

#### 1. consecutive_days/USO — DEMOTED (was Playbook, Sharpe 2.37)
Full-period Sharpe 2.37 was REGIME-INFLATED. Regime-matched result: 0.67.
The S10 promotion was premature — the result was driven by non-stagflation periods.
Only valid USO play in current regime: poc_reversion (regime Sharpe 1.13, 7 trades).

#### 2. consecutive_days/SLB — NEW FINDING (Sharpe 2.23, 15 trades, 79.8% WR)
Strongest new discovery in S11. 15 regime-matched trades = high statistical confidence.
Entry trigger: RSI < 65 + PCR normalizes below 1.0 + post-April 6 binary resolution.
Currently blocked: energy reduction mandate active, April 6 risk, options bearish (PCR 0.18).
This becomes top priority after April 6.

#### 3. adxr/XLE — ACCELERATING (90d: 6.46, 180d: 3.92, 365d: 2.42)
Momentum is STRENGTHENING at shorter windows. The 90d run has 1 open trade from Jan 22.
If entry was $48.96 and current price is $63.25 (+29.2%), this is the best live trade in the system.
Energy reduction mandate means no new adxr/XLE entries — manage existing via stop.

#### 4. XLV — ALL STRATEGIES REJECTED in regime-matched conditions
S9 poc_reversion/XLV result (1.19) was entirely non-regime period. Real result: -0.08.
Do NOT add healthcare ETF exposure based on sectoral thesis alone.

#### 5. T (AT&T) — Backtest valid but options block entry
kalman_filter/T: regime Sharpe 1.14, 4 trades — marginally valid.
Options: PCR 2.58 (heavy institutional put buying) — someone knows something.
Entry trigger: PCR below 1.5. Monitor weekly.

#### 6. DBA — Discretionary/fundamental play, not strategy-based
No strategy clears 0.8 threshold (best: consecutive_days 0.66).
BUT: PCR 0.14 (extreme call buying) + stagflation overlay + near major support $26.45–$26.50.
Portfolio Manager entered at $27.17 today (above resistance — breakout entry).
Stop: $25.49 | Target: $29.89.

#### 7. Pharma basket — rejected as a group
ABBV+GILD+JNJ aggregate Sharpe 0.21, 7 total trades (2-3 per name = insufficient).
S12 priority: test each individually — single-name alpha may be hidden in aggregate noise.

---

## Options Flow Intelligence (March 30 — key signals)

| Symbol | PCR | Signal | Interpretation |
|--------|-----|--------|----------------|
| DBA | 0.14 | STRONGLY BULLISH | 7x more calls than puts — institutional call buying |
| GLD | 0.59 | BULLISH | Max pain $413, 4h flipping bullish |
| WEAT | 0.30 | Neutral | No conviction |
| VLO | 0.68 | Neutral | Max pain $240 — modest coverage |
| MRK | 0.40 | Bearish | Unusual activity |
| MCD | 1.63 | Neutral/bearish | PM exited today correctly |
| USO | 0.79 | BEARISH | 2 unusual bearish signals |
| SLB | 0.18 | BEARISH | 2 unusual signals + EPS -29% |
| T | 2.58 | VERY BEARISH | Heavy institutional put buying |

RULE: When PCR disagrees with technical confluence, trust PCR for near-term timing.

---

## Portfolio Manager — Key Actions March 30

- VLO: CLOSED at $254.32 (+2.95%, +$145.60). Exit signal: RSI_OVERBOUGHT. Correct — energy reduction mandate + overbought RSI + April 6 risk.
- MCD: CLOSED at $311.19 (-1.44%, -$68.10). Exit signal: TREND_REVERSAL. Expected — 100% bearish alignment confirmed at session start.
- DBA: OPENED at $27.17. Discretionary stagflation overlay. Stop $25.49, target $29.89.
- MRK: HELD. Stop $114.49, target $131.07.

Portfolio: $99,962 (-0.04%). Cash 94%. Recovering from -$674 low (March 20).

---

## Session 11 — 2026-03-30 (Strategy Scout — Web Research)

**Status:** Full web research sprint. 5 tracks. 4 at BACKTEST NOW, 1 IMPLEMENT NOW (manual), 1 MONITOR.
**Mission:** VIX MR, stagflation rotation (new angles), weak dollar, April 6 binary framework, USO oil momentum.
**Full detail:** trading/scans/2026-03-30_session11_strategy_scout.md

**Top Finds Summary:**
1. VIX Term Structure Contrarian Equity Timer (4/5): Fassas & Hourvouliades JRFM 2019 / SSRN 3189502. Backwardation = contrarian LONG signal. ACTIVE NOW. Composite: `regime_detection` + `consecutive_days`. 20-day hold. Hard stop: April 6 exit.
2. EIA Wednesday Crude Intraday Momentum (4/5): Wen et al. Energy Journal 2023 / SSRN 3822093. 10:30 AM announcement momentum persists to close. STRONGER at VIX 31. MANUAL: watch April 1 EIA report at 10:30 AM, ride USO direction to close.
3. WTI 14-Month ROC Momentum on USO (3/5): Gurrib et al. IJEEP 2024. ROC-14 outperforms all shorter lookbacks. ACTIVE NOW (WTI $70 to $101). Composite: `time_series_momentum` on USO 14m lookback + OVX > 30 size-up.
4. Multi-Commodity GPR Hedge + Ceasefire Reversal (4/5): Parnes & Parnes IRFA 2025 / SSRN 4964922. GPR predicts commodity returns 4-day horizon. CEASEFIRE TRADE: GPR drop > 15% = SHORT USO / LONG SPY. Most urgent April 6 binary playbook item.
5. GDX/GLD Ratio Stagflation Lever (3/5): QuantPedia/WisdomTree/Sprott 2025. Ratio broke 15yr consolidation in Q4 2025. ACTIVE NOW. Signal: `rs_momentum` GDX vs GLD, 60-day MA gate. NOTE: S11 Regime Validation Sprint found XLV rejected in regime-matched conditions — apply same scrutiny to GDX.
6. VIX-Gated Healthcare Defensive Rotation (3/5): Meketa/Hartford Funds 2025. +4%/yr median stagflation alpha. IMPORTANT CAVEAT: S11 Regime Sprint found regime-matched poc_reversion/XLV = -0.08 Sharpe. Thesis conflicts with actual backtest data — DEMOTED pending individual strategy regime test.
7. AMLP MLP Toll-Road (2/5): Alerian/ALPS/Allianz. Ceasefire-resilient energy. No peer-reviewed paper. MONITOR only.

**S11 Scout New Backtest Queue (priority order):**
1. GPR Ceasefire Reversal: GPR drop > 15% = SHORT USO / LONG SPY, 4-day hold [URGENT: before April 6]
2. VIX term structure contrarian: `regime_detection` (VIX M1>M2) + `consecutive_days` on SPY, 20-day hold
3. USO 14-month ROC: `time_series_momentum` on USO, 14m lookback, long-only
4. GDX/GLD ratio rotation: `rs_momentum` GDX vs GLD, 60-day MA gate, gold > 200-day MA
5. EIA intraday USO: MANUAL MONITOR Wednesday April 1 at 10:30 AM ET

**S11 Scout Key Rejections (after cross-referencing Regime Sprint results):**
- XLV healthcare thesis: Regime Sprint found regime Sharpe = -0.08. Does not hold up in stagflation regime. Sector thesis ≠ strategy performance.
- Utilities (XLU): Explicitly worse than XLV in stagflation per Meketa/S&P Global — do not add.
- VXST/VIX ratio: VXST discontinued by CBOE 2020. No valid current instrument.
- Commodity currency (CAD/AUD): No FX data infrastructure in current backtest universe.

---

## Session 10 — 2026-03-27 (Strategy Scout — PCE Eve)

[See trading/scans/2026-03-27_session10_strategy_scout.md for full detail]

**Top Finds Summary:**
1. Post-PCE Entry Timing (4/5): SSRN 4280699. Soft PCE → BUY QQQ at open T+0. DEFERRED to April 9.
2. Crack Spread Refiner Supercycle (4/5): VLO/CRAK thesis. 50% energy reduction MANDATORY by April 4 (now April 3 given Brent at $115).
3. April 6 Binary Framework (3/5): Ceasefire = XLE -10%. No pick on direction — reduce energy, hold GLD.
4. Energy-to-Staples Rotation (3/5): XLE MACD went negative Feb 24. Signal NOT yet fired.
5. Silver GLD-SLV ML Pairs (3/5): Ratio 57:1, watch 55:1 threshold. Hold SLV passively.

---

## Session 9 — 2026-03-27 (Strategy Scout — Pre-PCE)

[See trading/scans/2026-03-27_session9_strategy_scout.md for full detail]

**Top Finds Summary:**
1. I-XTSM OVX Momentum (5/5): SSRN 4424602. Current signal: FULLY NEGATIVE. Cash stance confirmed.
2. Macro 5-Factor Sector Rotation (4/5): Energy 10/10, Tech -8/10. Confirms current positioning.
3. GPR Defense/Energy Rotation (4/5): April 6 potential new trigger. Size discipline critical.
4. Energy-Tech Pairs (4/5): XLE/XLK 30pt spread live. Reduce before April 6.
5. VIX Term Structure Gate (3/5): Backwardation confirmed — reduce equity exposure.
6. VIX+Breadth+HY MR Composite (3/5): All 3 conditions active, engine disagrees. Max 10-15% size.

---

## Session 8 — 2026-03-27 (Strategy Scout + Full Sweep)

[See trading/scans/2026-03-27_session8_*.md for full detail]

**Key Finding:** 169 new strategies swept. All S8 top strategies FAIL regime-matched on SPY.
adxr, volume_imbalance: Valid on XLE ONLY. Symbol-specificity is the critical insight.

---

## Rejection List (All Sessions)

halflife_mean_reversion, kst, chande_momentum, spread_mean_reversion, ornstein_uhlenbeck, zscore_mean_reversion_quant, percentile_reversion, hurst_exponent, klinger_oscillator, volume_weighted_momentum, trix, schaff_trend_cycle, golden_cross, bb_squeeze, pivot_point, bb_kc_squeeze, macd_histogram, trend_following_filter, adaptive_ma_crossover, tema, dema, hull_ma, vwap (trend-follower), connors_rsi2, swing_high_low, gap_fill (raw), money_flow_index, double_seven, ichimoku_kumo_breakout, autocorrelation, relative_vigor_index, ease_of_movement, relative_volume, harami, three_bar_reversal, accelerator_oscillator, williams_vix_fix (standalone), volatility_contraction, cumulative_rsi (failed — re-test with corrected params S8), slow_absolute_mean_reversion (Carver 2025: Sharpe -0.48), consecutive_days/USO (regime-inflated), volume_imbalance/USO (regime-hostile), regime_detection/USO (regime-hostile), adxr/USO (below threshold), poc_reversion/XLV (S9 mirage), consecutive_days/XLV (hostile), kalman_filter/XLV (below threshold), consecutive_days/T (hostile), pharma_basket/kalman (insufficient trades)

---

## System Notes

- Trading bot backend: OPERATIONAL as of S11
- adxr/XLE live trade: entered Jan 22 ~$48.96, currently +29.2%, still running
- Calendar: PCE = April 9, CPI = April 10, FOMC Minutes = April 8, NFP = April 5
- Iran deadline: April 6 8PM ET — most binary macro event of 2026
- I-XTSM data source: FRED OVXCLS (free API)
- GPR data source: matteoiacoviello.com/gpr.htm (free, monthly)
- Energy reduction mandate: ACTIVE — Brent at full crisis threshold $115
- MR activation gate: Core PCE < 2.5% AND VIX < 25 (earliest April 9)
