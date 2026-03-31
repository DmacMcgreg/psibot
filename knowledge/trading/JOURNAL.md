# Trade Journal

Auto-updated after each Portfolio Manager run.

## Format
Each entry: Date | Ticker | Action | Price | Signal | Reasoning | Outcome (filled on close)

---

## 2026-03-27 — Quant-Researcher Session 10 (End of Day)

### Research Summary

**Context:** PCE blackout in effect (March 28, 8:30 AM ET). No new positions.
**Total new runs:** ~45 (6 XLE regime-matched + 4 ITA regime-matched + 27 GLD/USO/SLV batch + 4 post-PCE MSFT/GOOGL + 4 composite voting modes)
**Reference universes:** XLE (98.73% regime similarity), ITA (96.07% regime similarity), GLD/USO/SLV batch

### Key Findings

#### XLE Regime-Matched (XLE as reference — 98.73% similarity)

Four strategies confirmed ACTIONABLE with Sharpe > 2.0 in matched conditions:
- volume_imbalance/XLE: Sharpe 2.74, 100% WR, MDD 0.3% — top XLE strategy
- adxr/XLE: Sharpe 2.42, 69.9% WR, MDD 0.4% — confirmed regime-fit
- consecutive_days/XLE: Sharpe 2.14, 65% WR, MDD 0.4%
- poc_reversion/XLE: Sharpe 2.02, 80% WR, MDD 0.1% — cleanest risk profile

These four are now the confirmed XLE playbook. All were showing strong full-period results in S9; the regime-matching at 98.73% similarity confirms these are not regime-sensitive artifacts.

#### ITA Regime-Matched — Critical Demotion

S9 ITA results (adxr: Sharpe 2.51, volume_imbalance: Sharpe 1.65) were full-period backtests.
When matched to ITA's own historical regime (96.07% similarity):
- adxr/ITA: Sharpe -1.15 — DEMOTED
- volume_imbalance/ITA: Sharpe -1.25 — DEMOTED
- kalman_filter/ITA: Sharpe -0.85 — FAIL
- consecutive_days/ITA: Sharpe +0.60 — too weak to act on

Lesson: ITA alpha in S9 was a full-period mirage driven by the recent defense sector bull run. Regime-matching exposes it.

#### USO — New Playbook Promotion

consecutive_days on USO: Sharpe 2.37, Return +4.69%, 11 trades, 81.8% WR, MDD 1.07%, PF 21.73.
This meets all criteria (Sharpe > 1.0, trades >= 10, MDD < 25%, PF > 1.3).
PROMOTED TO PLAYBOOK as energy/commodity universe strategy.

Additional USO strategies worth further testing: regime_detection (Sharpe 1.70, 6 trades — too few), volatility_targeting (Sharpe 1.67 — need trade count).

#### GLD/SLV Passive vs Active

GLD buy-and-hold: +46.87% in 1Y. SLV buy-and-hold: +101.56%.
Best active strategy on GLD: consecutive_days at Sharpe 1.12 — significantly underperforms passive.
Best active strategy on SLV: adxr at Sharpe 1.17 (3 trades only) — passive dominates.

Decision: GLD and SLV positions should be passive (direct ETF ownership), not active-strategy managed. No active strategy tested beats buy-and-hold in the current precious metals bull market.

#### Post-PCE Mean Reversion — Engine Verdict: No Activate

bb_mean_reversion/MSFT: Sharpe -1.55. zscore_mean_reversion/MSFT: Sharpe -0.93.
Both mean reversion strategies are destroying value on MSFT in the current regime.
S9-5 scout (VIX Backwardation + Breadth + HY) may argue for a bounce, but the engine disagrees.
Decision: If PCE soft, do NOT activate MSFT/GOOGL MR at standard size. 10-15% max if activating at all.

#### XLE Triple Composite Voting Mode Analysis

weighted = any = Sharpe 1.84, 9 trades, PF 3.99, MDD 1.25%
majority = 1 trade held 322 days = statistical artifact
2-leg (adxr + vol_imbalance) = Sharpe 1.73, 7 trades

Use weighted mode. Use composite as a position-sizing multiplier on XLE, not a standalone entry signal.

### Portfolio Status (No changes — PCE blackout)

Active positions: VLO (energy, strong hold), MRK (healthcare, hold), MCD (consumer, at stop)
Cash: ~87% — ready to deploy post-PCE if soft print

### Post-PCE Decision Tree

Soft (<2.5%): Add VLO to full 5%, add MRK to full 3%, consider USO via consecutive_days, evaluate XLE entry via adxr/vol_imbalance. Do NOT activate MSFT/GOOGL MR.
Hot (>2.8%): Hold VLO, tighten MCD stop, XLE strategies remain valid as inflation hedge.
In-line (2.5-2.8%): Hold all, wait for April 6 binary event.

---

## 2026-03-27 — Quant-Researcher Session 8 (Afternoon — Backend Restored)

### Backtest Session Summary

**Context:** Trading bot backend restored after 3-day outage. Full strategy sweep executed.
**Total runs:** ~1,600+ (169 strategies x 9 symbols + composites + regime-matched)
**Universe:** SPY, QQQ, AAPL, MSFT, NVDA, XLE, XLK, AMZN, TSLA | 365d lookback

### Key Findings

#### New Strategy Leaders (from sweep of 169 untested strategies)

Top 5 by avg Sharpe across all 9 symbols:
1. adxr — Avg Sharpe 1.09, Max 1.82, Avg Return +1.85%, 89% positive (PLAYBOOK CANDIDATE)
2. vortex_indicator — Avg Sharpe 1.00, Max 1.90, Avg Return +1.64%, 89% positive
3. adaptive_trend — Avg Sharpe 0.98, Max 1.53, Avg Return +1.87%, 100% positive
4. mtf_momentum — Avg Sharpe 0.93, Max 1.90, Avg Return +1.78%
5. r_squared — Avg Sharpe 0.93, Max 1.81, Avg Return +1.89%, 89% positive

#### Regime-Matched Test Results (96.87% match to current conditions)

- center_of_gravity: 1Y Sharpe ~1.58 → Regime Sharpe -0.24 — SUSPENDED
- consecutive_days: 1Y Sharpe ~1.53 → Regime Sharpe +0.48 — CONFIRMED REGIME-RESILIENT
- island_reversal: 1Y Sharpe ~1.65 → Regime Sharpe -0.19 — REJECTED

#### XLE Regime Alpha (Important — Temporary)
XLE is generating outsized Sharpe on nearly every breakout strategy (Brent $108, Iran conflict):
- volatility_targeting/XLE: Sharpe 2.65, Return +4.27%
- volume_imbalance/XLE: Sharpe 2.40, Return +4.46%
- fibonacci_extension/XLE: Sharpe 2.35, Return +4.65%

This is geopolitical premium, NOT structural alpha. Will evaporate when oil normalizes.

#### Confirmed Rejects (do not revisit)
end_of_month (-1.45), pivot_point (-1.09), calendar_aware (-1.00), santa_claus_rally (-0.92), macd_histogram (-0.84), accelerator_oscillator (-0.77), quarter_end (-0.76), camarilla_pivot (-0.75), halflife_mean_reversion (-0.70), spread_mean_reversion (-0.60)

---

## 2026-03-27 — Portfolio Manager Session (9:30 AM ET)

### Context
- Regime: RISK-OFF / STAGFLATION at 75% confidence (upgraded from 65%)
- FOMC Minutes released 8:30 AM ET today — watch for April hike language
- PCE Price Index tomorrow (March 28) — binary event for all mean-reversion names
- Iran: Extended strike pause to April 6 — market read as bearish (prolonged uncertainty)
- Brent $108, 10yr 4.41%, VIX 24.98, Nasdaq breadth 35.49%

### EXITS

#### GE | CLOSE | $293.67 | TREND_REVERSAL | -2.79% in 9 days
- P/L: -$75.78 (-2.79%) | Outcome: Correct — Industrials has no regime tailwind and support failed.

#### ABBV | CLOSE | $207.06 | MANUAL | +0.00% in 1 day
- P/L: $0.00 (breakeven) | Outcome: Correct — fundamental disqualifiers (P/E 89.5x, payout 277%).

#### PG | CLOSE | $143.78 | TREND_REVERSAL | +0.00% in 1 day
- P/L: $0.00 (breakeven) | Outcome: Correct — PCR 2.66 extreme put buying.

### ENTRIES

#### VLO | OPEN | $247.04 | STRONG_BUY | Position #14
- Shares: 20 | Stop: $241.10 (-2.4%) | Target: $271.74 (+10.0%)
- Strategy: Regime Detection — Energy refiner, RISK-OFF/Stagflation
- Rationale: Iran crack spread thesis. MACD/SMA 100% bullish, PCR 0.626 call-dominant.

#### MRK | OPEN | $119.15 | BUY | Position #15
- Shares: 25 | Stop: $114.49 (-3.9%) | Target: $131.07 (+10.0%)
- Strategy: Kalman Filter — Defensive healthcare
- Rationale: PCR 0.164 extremely call-dominant. P/E 16.3x — cheapest pharma.

---

## 2026-03-30 — Portfolio Manager Session (9:30 AM ET Open)

### Context
Regime: Risk-Off/Stagflation 85% (upgraded from 80% March 27). VIX 31.06 (broke 30). Brent $115.35 (crisis threshold breached). PCE delayed to April 9. Energy Reduction Protocol ACTIVE. April 6 Iran binary event = #1 macro risk.

### EXITS

#### MCD | CLOSE | $311.19 | TREND_REVERSAL | -1.44% in 11 days
- P/L: -$68.10 | Shares: 15 | Entry: $315.73
- Signal: 100% bearish confluence all timeframes (4h/daily/weekly/monthly). MACD+SMA bearish everywhere. Options PCR 1.63 (heavy put buying). Combined score -35/100.
- Reason: Consumer Discretionary not aligned with Risk-Off regime. Position entered pre-regime-upgrade. Exiting to redeploy into regime-appropriate names.
- Lesson: Sector alignment with regime is critical. MCD was a legacy entry from a less severe regime assessment.

#### VLO | CLOSE | $254.32 | RSI_OVERBOUGHT | +2.95% in 3 days
- P/L: +$145.60 | Shares: 20 | Entry: $247.04
- Signal: RSI 71.37 (crossed rsi_exit=70 threshold). BB_Position above upper band. Energy Reduction Protocol ACTIVE (Brent $115 = full crisis trigger).
- Reason: RSI exit rule triggered. April 6 binary event risk — energy could crash 10-15% on ceasefire. Crack spread thesis fundamentally intact but risk/reward favors exit. VLO was HOLD on scan (not trim list), but RSI trigger overrode.
- Outcome: Profitable trade. Net trade result for session: -$68.10 + $145.60 = +$77.50.

### ENTRIES

#### DBA | OPEN | $27.17 | BUY | Position #16
- Shares: 110 | Stop: $25.49 (-6.2%, 2x ATR $0.84) | Target: $29.89 (+10.0%)
- Strategy: Regime Detection — Ag commodities stagflation play
- Composite score: 77/100 (strong). Options PCR 0.14 = extreme call domination. Bullish confluence 75% (daily/weekly/monthly). MACD+SMA bullish daily/weekly/monthly.
- Thesis: VIX 31 + Brent $115 + food inflation overlay = stagflation forces commodity demand. USDA crop reports + Iran supply shock = ag price pressure. Key support cluster $26.45-$26.50 below entry.
- Risk: RSI 72.0 approaching overbought. 4h MACD slightly bearish (short-term pullback possible). Entry slightly above preferred $26.50 dip zone.

### SKIPPED ENTRIES

#### T — PCR 2.58 (heavy unusual put buying) — Kalman signal valid but options red flag triggered
#### SLB — 2 unusual activity signals on options, conflicting technical vs options direction
#### META SHORT — Not supported by paper portfolio (longs only)
#### BA SHORT — Not supported by paper portfolio (longs only)

### End of Session Status
- Portfolio: $99,962.11 (-0.04% from $100K start)
- Cash: $93,994.66 (94.0% — high cash position)
- Positions: 2 open (MRK, DBA)
- Day session P/L: +$77.50 (+0.15% on invested capital)

---

## 2026-03-26 — Portfolio Manager Session

### EXITS

#### EOG | CLOSE | $144.72 | RSI_OVERBOUGHT | +3.61% in 2 days
- P/L: +$176.40 | RSI 81.13, BB 0.93. Iran ceasefire rally locked in.

#### XLE | CLOSE | $61.07 | TAKE_PROFIT | +9.46% in 1 day
- Entry: $55.79 (poc_reversion) | P/L: +$464.64 | Best single-day return in portfolio history.

### ENTRIES

#### MSFT | OPEN | $370.57 | STRONG_BUY | Position #11
- Strategy: BB MR + Z-Score MR | RSI: 17.6 (extreme oversold) — closed same session

#### PG | OPEN | $143.78 | STRONG_BUY | Position #12
- Exited next day at breakeven (PCR 2.66 red flag)

#### ABBV | OPEN | $207.06 | STRONG_BUY | Position #13
- Exited next day at breakeven (fundamental disqualifiers)
