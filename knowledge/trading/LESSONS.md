# Trading Lessons

Extracted patterns from wins and losses. Auto-updated by Strategy Reviewer.

## Week of Apr 27 - May 3, 2026 — New Lessons

### Infrastructure Reliability is Critical (2026-05-03)
- **Signal Trader phantom position crisis**: trading_portfolio backend shows 64 phantom positions ($73,912, +4.85% P/L) while real portfolio has only 2 positions ($5,663, 0% P/L). Discrepancy = $68,249 phantom capital creating completely false performance data.
- **Evaluation loop broken**: 1,025 signals tracked, 0 evaluated (up from 830 last week). Cannot attribute P/L to signal sources, cannot improve weights, cannot validate ML predictions.
- **ML accuracy**: 0% win rate across all confidence buckets. Zero evaluated signals = flying blind.
- **Impact**: Tier B strategy cannot be evaluated, signal source performance unknown, all automated trading suspended.
- **RULE**: Infrastructure integrity checks MUST be automated. Weekly audit of: (1) portfolio consistency (trading_portfolio vs agent-tools), (2) evaluation loop progress, (3) ML accuracy trending, (4) signal source attribution. Trading system cannot operate reliably with broken feedback loops.

### Defensive Positioning Preserved Capital, Cost Opportunity (2026-05-03)
- **Week's posture**: 94.3% cash (only AAPL and QCOM opened May 1, both flat after 3 days)
- **Rationale**: CPI Monday May 5 = binary event risk, FOMC cluster, VIX 16.99 complacency
- **Result**: Zero losses, but also zero gains. SPY +6.36%, QQQ +8.16% over 180 days vs -0.70%
- **Benchmark underperformance**: -7.06% vs SPY, -8.86% vs QQQ
- **RULE**: Extreme defensive posture (>90% cash) is correct before known binary events AND when infrastructure is broken (can't evaluate new positions properly). BUT when indices are in clear uptrend (RSI >70, above all MAs) AND infrastructure is functional, consider 10-20% passive index exposure to capture upside while maintaining defensive core. The cost of being "too careful" is 7-9% annual underperformance.

### Pre-Binary Event Exit Discipline Validated (2026-04-28)
- **USO exit**: Closed flat at $89.61 (0% P/L) on Apr 28, 36 hours before FOMC
- **Reason**: PCR 1.88 extreme bearish (approaching 2.0 threshold), FOMC binary event within 48h (violates playbook rule), no momentum for 7 days, combined signal -51.5 bearish
- **Outcome**: Correct defensive move. Exited flat instead of holding through binary event risk.
- **RULE**: The "do not enter within 48h of binary events" rule should extend to EXITS. If holding a position 48h before major event (FOMC, CPI, earnings) and position shows: (1) no momentum toward target, (2) extreme options positioning against you (PCR >1.8 for longs), (3) conflicting signals, EXIT at breakeven rather than holding through event. Capital preservation > forcing a win.

## Week of Apr 20-26, 2026 — Prior Lessons

### Entry Zone Discipline (2026-04-24)
- **GDX -8.12%**: Entered at $100.34, just below stated entry zone of $99-101. Price quickly deteriorated to 100% bearish MTF alignment and stopped at $92.19. The "just below target" entry was a MISTAKE - market structure at $100.34 was different than at $99-101. RULE: Entry zones are NOT approximations. If zone is $99-101, do not enter at $100.34 thinking "close enough." Wait for pullback INTO the zone or skip the trade.

### Price Data Verification (2026-04-24)
- **GDX discrepancy**: Portfolio showed $100.34, scan showed $92.99 ($7.35 difference). Exit at $92.19 proved scan was accurate, portfolio was wrong. This 7.3% discrepancy affected entry decision - thought we were near entry zone when actually well above it. RULE: When portfolio price differs from scan/analysis by >5%, STOP and investigate. Do NOT enter until discrepancy resolved. Cross-reference with external sources (Yahoo Finance, TradingView).

### 100% MTF Alignment is THE Edge (2026-04-23)
- **AMT +2.23%**: Entered with 100% MTF alignment (all 4 timeframes bullish), confluence 62.5. Result: WIN, exited at profit on PCR warning. 
- **GDX -8.12%**: Entered without verifying 100% MTF alignment (assumed based on prior session data), price above entry zone. Result: LOSS, 100% bearish reversal within 3 days.
- **NEE -3.46% (prior week)**: Entered with only 75% MTF alignment. Result: LOSS.
- **Pattern confirmed**: 100% MTF alignment = 100% win rate so far (AMT). <100% MTF = 100% loss rate (NEE, GDX). RULE: The 100% MTF rule is NOT a guideline, it's THE FILTER. No exceptions, no approximations.

### Options Flow as Early Warning (2026-04-23)
- **AMT exit**: PCR 11.96 extreme bearish (heavy put accumulation) signaled deterioration while position was still profitable (+2.23%). Exited before reversal materialized. RULE: Monitor PCR daily on open positions. PCR >2.0 or rapid shift from bullish to bearish = EXIT signal, don't wait for stop loss.

### Signal Source Quality — Congressional Trades Are Noise (2026-04-23)
- **Research finding**: MU and NVDA congressional trades showed 26-day reporting lag. By the time signals captured, price had moved 13% AGAINST their position. This is not alpha, it's anti-alpha.
- **shadow-quiver (Quiver Quantitative congressional trades)**: NEGATIVE alpha confirmed. Should be DISABLED or weighted at 0.0.
- **wsb**: Momentum chasing, gain porn posted AFTER rallies. Weight reduced to 0.1x (lagging indicator only).
- **reddit-stocks**: Zero-score posts, pure noise. Weight to 0.0.
- RULE: Signal sources must be evaluated for lead vs lag. Lagging sources create losses, not gains.

## Data Validation Lessons

- **2026-03-24**: Scanner claimed GOOGL ($302) was "near 52-week low" and "UNDERVALUED." Root cause identified: the backend's 52-week range was $294-$349, so technically $302 is only 2.7% above the 52w low. But this is deeply misleading — GOOGL is up ~100% over 2 years in a strong uptrend. A tight 52-week range near all-time highs means even a small pullback looks like it's "near the low." RULE: Never call a stock "near 52w low" without checking the longer-term chart.

- **2026-04-16**: Portfolio integrity bug — 9 unauthorized positions appeared overnight, displacing MRK (our only legitimate position, +2.80% at the time). MRK lost to infrastructure failure, not strategy failure. ~$51 loss that should have been a ~$280 gain. RULE: Verify portfolio state at START of every session. If unauthorized positions exist, close them FIRST before any analysis.

- **2026-04-24**: Price data discrepancy — GDX portfolio $100.34 vs scan $92.99. Exit at $92.19 confirmed scan was accurate. 7.3% error in entry decision. RULE: Cross-reference prices before entry. >5% discrepancy = investigate, don't trade.

## Entry Lessons

- **2026-04-24**: GDX entered at $100.34, just below $99-101 zone. Price structure was different outside the zone. -8.12% loss. RULE: Entry zones are precise, not approximate.

- **2026-04-24**: GDX entered without verifying 100% MTF at entry time (used prior session data). Technical setup deteriorated. RULE: Verify 100% MTF alignment at moment of entry, not hours before.

- **2026-04-17**: AMT entered with 100% MTF alignment (4h/daily/weekly/monthly ALL bullish), confluence 62.5. GDX skipped because 4h was bearish (only 75% alignment). This is the 100% MTF rule in action — filter out entries that don't have full timeframe agreement. AMT is +2.23% after 2 days. RULE: 100% MTF alignment is MANDATORY. Do not override.

- **2026-04-17**: GDX was above the $96-97 entry zone from regime guidance ($100.05). Despite high conviction, the entry was correctly SKIPPED — waiting for pullback. OpEx max pain at $95 supported waiting. RULE: Respect entry zones even on highest-conviction setups. Chasing costs more than missing.

- **2026-04-17**: DBA skipped despite highest combined score (78.6) because MACD was bearish on ALL 4 timeframes. Scanner explicitly flagged the conflict. RULE: MACD all-timeframe bearish = hard veto, regardless of other signals.

- **2026-04-14**: JNJ stopped out at -2.73% — second POC Reversion loss on JNJ. Despite being #1 backtest symbol (Sharpe 2.43), live JNJ POC trades are 0/2. Backtest-to-live divergence this consistent = overfitting signal. RULE: If a specific ticker fails a strategy TWICE live, blacklist that ticker for that strategy. Backtest alpha does not guarantee live alpha.

- **2026-04-13**: NEE entered at $94.04 with only 75% MTF alignment (missing full agreement). Stopped at $90.79 (-3.46%) two days later. Compare to AMT (100% alignment, +2.23%). RULE: The 75% vs 100% MTF difference is the difference between losers and winners in Regime Detection.

- **2026-04-05 (Week Review)**: WEAT entered with combined score 18/100 and confluence 52.5. This was the weakest position and stopped out fastest. RULE: Minimum combined score 40/100 AND confluence >60 for any entry. Low-conviction entries waste capital.

- **2026-04-05**: T entered on PCR trigger (2.58→1.15 collapse) which was a valid Kalman signal. But by April 2, PCR had spiked to 2.39 (extreme bearish). The options flow WARNED us 1 day before the stop hit. RULE: If PCR reverses to >2.0 after entry, treat as an EXIT signal — don't wait for the stop.

- **2026-04-05**: ABBV and PG were entered and exited at breakeven within 1 day (Mar 26-27). Fundamental disqualifiers (P/E 89.5x, payout 277%) and extreme put buying (PCR 2.66) should have prevented entry entirely. RULE: Screen fundamentals BEFORE entry, not after.

- **2026-03-30**: VLO RSI exit at 71.37 was the best trade of the week (+2.95%). The RSI overbought exit rule worked perfectly — price declined after exit. RULE: Trust the RSI >70 exit signal. Don't hold for the full 10% target when RSI says exit.

## Exit Lessons

- **2026-04-23**: AMT exited at +2.23% on PCR warning (11.96 extreme bearish). Early exit preserved profit before reversal. RULE: PCR extreme moves (>10 or <0.1) are EXIT signals even if position is winning.

- **2026-04-23**: CF, NTR, SQQQ exited at flat (0 days profit). Not in playbook, no strategic rationale. RULE: Positions not in regime playbook should be exited immediately, don't wait for profit or loss.

- **2026-04-19 (Week Review)**: JNJ (-2.73%) and NEE (-3.46%) both hit stops within 48 hours of the Apr 21 triple binary event (Iran + HAL + Retail Sales). Holding positions into known binary events continues to be destructive. AMT survived because it was sized at 2.9% (well within 50% max rule). RULE: Positions approaching binary events either need to be closed or sized <3%.

- **2026-04-05**: All 4 positions (T, MRK, DBA, WEAT) stopped out on April 3 in a single session. This was a correlated drawdown — all were long positions in a risk-off selloff triggered by Iran deadline proximity + pharma tariffs. RULE: Max 4 correlated positions. Diversify across long/short or uncorrelated themes. When holding 4 longs into a binary event, you're not diversified — you have one big bet on "markets don't crash."

- **2026-04-05**: DBA had a -6.2% stop (2x ATR = $0.84 on a $27 stock). This was the widest stop percentage and the biggest single loss ($184.80). For commodity ETFs with high ATR, the standard 2x ATR stop can be too wide. RULE: Cap stop loss at 4% max for commodity ETFs, even if ATR suggests wider.

- **2026-04-05**: MRK stop was correctly tightened from $114.49 to $119.00 in Session 21, and it hit at ~$119. Without the tightening, the loss would have been ~-3.9% instead of ~-0.1%. RULE: Tightening stops as positions age is correct. Continue this practice.

- **2026-03-30**: MCD exited at -1.44% on TREND_REVERSAL signal. 100% bearish confluence + PCR 1.63. The trend reversal signal was correct — consumer discretionary doesn't belong in a risk-off portfolio. RULE: Sector-regime alignment is critical. Exit positions that don't fit the current regime, even at a small loss.

## Regime Lessons

- **2026-04-19**: The regime shifted from "Risk-Off/Stagflation 85%" to "Risk-On Surface / Stagflation Core 65%" — a transitional regime. SPY RSI 74, all indices OB. But PCE 3.0% = stagflation floor. The surface-level risk-on is a TRAP if you deploy MR strategies — PCE still binds the gate. RULE: Do not confuse surface price action (indices rallying, VIX dropping) with regime change. The macro fundamentals (PCE, Fed hawkish) must confirm.

- **2026-04-19**: 100% MTF alignment is the SINGLE BEST predictor of Regime Detection success. AMT (100% = +2.23%) vs NEE (75% = -3.46%). This is now a hard rule, not a guideline. RULE: MTF alignment is not optional for Regime Detection. It IS the edge.

- **2026-04-05**: The "all-weather" label on Kalman Filter was disproven this week. In an acute geopolitical risk-off (Iran deadline + pharma tariffs), Kalman went 0/3. It works in gradual regime transitions but NOT in binary event drawdowns. RULE: No strategy is truly all-weather. Before binary events, reduce Kalman weight and increase cash.

- **2026-04-05**: Regime Detection correctly identified VLO as an energy play for risk-off/stagflation, and VLO was the only winner. DBA (also Regime Detection) was correct in thesis (ag commodities for stagflation) but the stop was hit by a broad selloff, not thesis failure. RULE: Regime Detection picks the RIGHT sectors — the issue is position sizing and stop management around binary events, not sector selection.

- **2026-04-05**: The decision to NOT enter before April 6 (from Session 20 onwards) was correct. All existing positions stopped out. Any new entries would have added to losses. RULE: Cash preservation before known binary events is the highest-conviction trade. "No position" IS a position.

- **2026-04-05**: MR strategies remain gated (VIX <25 AND PCE <2.5% required). VIX broke below 25 on April 2 (23.90) for the first time, but all positions still stopped out April 3. The gate protected us from deploying MR capital into the selloff. RULE: The MR gate is working correctly. Do not override it.

## Portfolio Construction Lessons

- **2026-05-03**: Week of Apr 27-May 3: 94.3% cash, only 2 positions (AAPL, QCOM both flat). Portfolio P/L -0.70% vs SPY +6.36%, QQQ +8.16% (180-day). Underperformance: -7.06% vs SPY, -8.86% vs QQQ. The extreme defensive stance preserved capital but missed 6-8% gains. CONSIDERATION: When regime is Risk-On (91% confidence) AND indices at all-time highs AND infrastructure is functional, consider 10-20% passive SPY/QQQ allocation to capture systematic upside while maintaining defensive core. The cost of being >90% cash in a bull market is 7-9% annual underperformance.

- **2026-04-26**: Week's performance: 1W/1L (50% win rate), -$172.67 net (-0.17%). But portfolio 96.7% cash = actual return on invested capital much worse. The conservative stance preserved capital but cost opportunity. With SPY +3.86%, QQQ +4.42% over 180 days, our -0.70% return is 4-5% underperformance. CONSIDERATION: When regime is Mixed/Risk-On and cash >90%, consider 10-20% passive SPY/QQQ allocation to capture upside while maintaining defensive core.

- **2026-04-19**: Paper portfolio at -0.53% vs SPY +6.34%, QQQ +7.16%, DIA +6.11% over 180 days. The conservative stance (97% cash) has preserved capital but massively underperformed buy-and-hold. This is the cost of waiting for perfect entries in a rising market. CONSIDERATION: When indices are in clear uptrend (RSI >70, above all MAs), having SOME passive index exposure may outperform the pure active approach.

- **2026-04-19**: All-time record: 3W/11L (27% win rate). Winners: VLO +2.95%, XLE +9.46%, EOG +3.61% — ALL energy. Losers span healthcare, telecom, ag, consumer. PATTERN: The system only wins on energy trades in stagflation. Every other sector has lost. RULE: Until win rate improves, concentrate on proven winning sectors (energy, gold miners) and avoid "diversifying" into losers.

- **2026-04-05**: Week's P/L was -$281 (-0.28% of portfolio). With 88% cash, the actual drawdown on invested capital was much worse (~-12%). But the 88% cash reserve meant the portfolio-level damage was contained. RULE: The 25% minimum cash reserve rule saved us. In risk-off with binary events, 75-90% cash is appropriate.

- **2026-04-05**: ML accuracy report shows 0 evaluated signals across all 512 tracked — the ML system has generated predictions but never evaluated outcomes. This is a gap. RULE: ML predictions should not be weighted until the evaluation loop is closed.

## Infrastructure Lessons

- **2026-05-03**: Evaluation loop BROKEN for 2+ weeks — 1,025 signals tracked (up from 830), 0 evaluated. Cannot attribute P/L to strategies or signal sources. Cannot improve weights. Flying blind. PRIORITY: Fix evaluation loop before continuing trading. This is now a CRITICAL blocker.

- **2026-05-03**: Signal Trader phantom positions ESCALATED — now 64 phantom positions ($73,912, +4.85% P/L) vs 2 real positions ($5,663, 0% P/L). $68,249 phantom capital completely distorting performance reporting. PRIORITY: Clear phantom positions from trading_portfolio database, verify Signal Trader uses agent-tools portfolio system.

- **2026-04-26**: Evaluation loop BROKEN — 830 signals tracked, 0 evaluated. Cannot attribute P/L to strategies or signal sources. Cannot improve weights. Flying blind. PRIORITY: Fix evaluation loop before continuing trading.

- **2026-04-24**: Signal Trader creating phantom positions — 9 positions showed in trading_portfolio but didn't exist in actual portfolio. Tier B lane non-functional. RULE: Verify integration before deploying automated systems. Disable Signal Trader until fixed.

- **2026-04-16**: Portfolio integrity bug created 9 fake positions and displaced MRK. Root cause unknown but likely a race condition or unauthorized API call. Cost: ~$330 in lost MRK gains + $51 direct loss. RULE: Portfolio state must be validated at session start. Consider adding a portfolio checksum or position audit log.

## Signal Source Lessons (Week of Apr 20-26)

- **Congressional trades (shadow-quiver)**: 26-day reporting lag = NEGATIVE alpha. MU/NVDA congressional trades captured 1 month after execution, price moved 13% AGAINST position by the time we see it. WEIGHT: 0.0 (disable).

- **WSB (r/wallstreetbets)**: Gain porn posted AFTER rallies. Momentum chasing, not leading. WEIGHT: 0.1 (downweight to lagging indicator only).

- **reddit-stocks**: Zero-score posts, cross-posted noise. No filtering for quality. WEIGHT: 0.0 (disable).

- **reddit-options**: Neutral, useful for IV context only. WEIGHT: 0.3 (context, not signals).

- **OpenInsider, Finviz Analyst, TipRanks**: Still need evaluation data. Maintain existing weights until data available.

## Signal Source Lessons (Week of Apr 27-May 3) — BLOCKED

**CANNOT EVALUATE** — Signal Trader creating phantom positions, evaluation loop broken, no reliable trade_id associations.

Signal activity observed but P/L attribution IMPOSSIBLE:
- WSB: 140 signals, 50 acted (35.7% action rate)
- reddit-stocks: 114 signals, 42 acted (36.8% action rate)
- reddit-investing: 70 signals, 29 acted (41.4% action rate)
- shadow-quiver: 51 signals, 4 acted (7.8% action rate) — LOW engagement
- reddit-options: 44 signals, 12 acted (27.3% action rate)
- reddit-pennystocks: 81 signals, 0 acted (0% action rate) — ZERO engagement

**Action Required:** Fix Signal Trader integration + evaluation loop before any signal source lessons can be extracted.

## monthly additions (failures) — appended 2026-05-01
- NEE defensive utility long failed: distribution pattern at range rejection, stopped at $91.31 (2026-04-14 entered, 2026-04-15 exit at open)
- Mean Reversion gate never activated through April: PCE stayed >2.5% threshold despite repeated 'days away' forecasts (2026-03-31, 2026-04-02, 2026-04-05, 2026-04-15, 2026-04-26)
- XLE/USO energy long thesis reversed to short within 2 weeks as Hormuz war premium unwound — regime-recommended longs became technical/options bearish (2026-04-18, 2026-04-20, 2026-04-23, 2026-04-25, 2026-04-28)
- MRK stop tightening cascade ended in stop-out at $117.92 despite repeated 'institutional distribution' warnings (2026-04-14 distribution flag, 2026-04-15-1700 stopped)
- 'Hormuz Hope' / Iran ceasefire rallies repeatedly traded as false signals — cash-and-react on day-of resolution (2026-04-02-addendum false signal, 2026-04-15-1700 deal probability mispriced)
- Cash preservation posture (96.7%) missed SPY +3.86% rally — over-defensive ahead of binary events that resolved benignly (2026-04-25, 2026-04-28)
- Technical/fundamental conflict setups (WMT bullish technical vs -19% earnings; V bullish fundamentals vs bearish technicals) flagged as AVOID zones, never resolved cleanly (2026-04-24, 2026-04-25)
- ITA defense strategies failed regime-matched validation at >95% similarity threshold (2026-03-27 session10, then defense sector flipped to coordinated short 2026-04-23)
- GLD active strategies (kalman_filter, adxr) underperformed buy-and-hold +46.87% during momentum-driven gold bull run (2026-03-27 session10, 2026-04-15-1700 confirmed passive thesis)
- META short thesis on capex inflation persisted but conflicting catalysts (Corning deal, data centers) made stop management noisy (2026-04-02-0200-scan still short, 2026-04-30 still AVOID)
