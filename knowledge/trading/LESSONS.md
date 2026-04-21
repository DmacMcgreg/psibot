# Trading Lessons

Extracted patterns from wins and losses. Auto-updated by Strategy Reviewer.

## Data Validation Lessons

- **2026-03-24**: Scanner claimed GOOGL ($302) was "near 52-week low" and "UNDERVALUED." Root cause identified: the backend's 52-week range was $294-$349, so technically $302 is only 2.7% above the 52w low. But this is deeply misleading — GOOGL is up ~100% over 2 years in a strong uptrend. A tight 52-week range near all-time highs means even a small pullback looks like it's "near the low." RULE: Never call a stock "near 52w low" without checking the longer-term chart.

- **2026-04-16**: Portfolio integrity bug — 9 unauthorized positions appeared overnight, displacing MRK (our only legitimate position, +2.80% at the time). MRK lost to infrastructure failure, not strategy failure. ~$51 loss that should have been a ~$280 gain. RULE: Verify portfolio state at START of every session. If unauthorized positions exist, close them FIRST before any analysis.

## Entry Lessons

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

- **2026-04-19**: Paper portfolio at -0.53% vs SPY +6.34%, QQQ +7.16%, DIA +6.11% over 180 days. The conservative stance (97% cash) has preserved capital but massively underperformed buy-and-hold. This is the cost of waiting for perfect entries in a rising market. CONSIDERATION: When indices are in clear uptrend (RSI >70, above all MAs), having SOME passive index exposure may outperform the pure active approach.

- **2026-04-19**: All-time record: 3W/11L (27% win rate). Winners: VLO +2.95%, XLE +9.46%, EOG +3.61% — ALL energy. Losers span healthcare, telecom, ag, consumer. PATTERN: The system only wins on energy trades in stagflation. Every other sector has lost. RULE: Until win rate improves, concentrate on proven winning sectors (energy, gold miners) and avoid "diversifying" into losers.

- **2026-04-05**: Week's P/L was -$281 (-0.28% of portfolio). With 88% cash, the actual drawdown on invested capital was much worse (~-12%). But the 88% cash reserve meant the portfolio-level damage was contained. RULE: The 25% minimum cash reserve rule saved us. In risk-off with binary events, 75-90% cash is appropriate.

- **2026-04-05**: ML accuracy report shows 0 evaluated signals across all 512 tracked — the ML system has generated predictions but never evaluated outcomes. This is a gap. RULE: ML predictions should not be weighted until the evaluation loop is closed.

## Infrastructure Lessons

- **2026-04-16**: Portfolio integrity bug created 9 fake positions and displaced MRK. Root cause unknown but likely a race condition or unauthorized API call. Cost: ~$330 in lost MRK gains + $51 direct loss. RULE: Portfolio state must be validated at session start. Consider adding a portfolio checksum or position audit log.
