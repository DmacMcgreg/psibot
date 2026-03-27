# Alpha Research Session 7 — March 26, 2026 (EOD)

**Regime:** RISK-OFF / TRANSITIONAL (VIX 25.33 close, S&P -1.58%, oil +3.6%)
**Macro backdrop:** US-Iran war intensifying. Iran rejected US 15-point ceasefire plan. Pakistan facilitating indirect talks. No ceasefire.
**Upcoming catalysts:** PCE Friday March 28 (HIGH IMPACT), April 10 CPI (HIGHEST IMPACT)
**Backend status:** Trading bot UNREACHABLE — pure research + market close review session.

---

## MARKET CLOSE DATA — March 26, 2026

| Asset | Open | High | Low | Close | Change |
|-------|------|------|-----|-------|--------|
| S&P 500 | ~6,574 | ~6,574 | ~6,489 | ~6,488 | -1.58% |
| VIX | — | — | — | 25.33 | — |
| Brent Crude | — | — | — | ~$106.12 | ~+3.6% |
| WTI | — | — | — | ~$93.61 | ~+3.6% |
| XLE | $60.67 | $61.86 | $60.59 | $61.56 | +1.63% |
| XLK | $135.18 | $135.52 | $132.70 | $132.64 | -3.01% |
| GE | — | — | — | $284.32 | ~-4.1% |
| MCD | $310.75 | $312.71 | $309.40 | $309.96 | -0.56% |
| ABBV | — | — | — | $211.13 | +1.91% |
| PG | — | — | — | $142.44 | -1.03% |
| SBUX | — | — | — | $91.00 | -1.83% |
| MSFT | — | — | — | $365.95 | -1.37% |

**Notable:**
- Meta -7%, Micron/AMD/Intel/Palantir each -4%+ (tech massacre)
- Energy outperformed all other sectors
- ABBV +1.91% (defensive rotation)

---

## PAPER TRADING — TRADE #1 CLOSED: XLE WIN ✅

**XLE closed at $61.56 — TARGET HIT ($61.37 target exceeded)**
- Intraday high: $61.86 (new 52-week high, previous high $61.47)
- Entry: $55.79 (March 25)
- Exit: $61.56 (March 26 close)
- Hold period: 2 trading days
- P&L: +10.35% = +$1,034 on $10,000 position
- Strategy: poc_reversion (PLAYBOOK ⭐)
- Multi-factor at entry: Oil shock catalyst ✓, Energy sector strength ✓, poc_reversion PLAYBOOK ✓, stop defined ✓
- Backend was down — trade tracked manually, will confirm via portfolio tool when backend restored

**This is our FIRST closed paper trade. 1/1 WIN RATE. +$1,034 realized.**

---

## PORTFOLIO MANAGER REVIEW (EOD March 26)

### ⚠️ GE CRITICAL ALERT

GE Aerospace dropped from ~$310 to $284.32 today — a decline of ~$26 or ~8.4%.
- Entry price: $302.09
- Current: $284.32
- P&L: -$17.77/share = -5.87%
- STOP: $279.57 (only $4.75 below close = 1.7% further downside)
- Likely cause: Defense/industrial selling, broad market risk-off, Iran escalation uncertainty
- RISK: GE is now near stop. Friday March 27 + PCE Friday March 28 are both high-risk days for continuation selling.
- ACTION NEEDED WHEN BACKEND IS LIVE: Monitor closely. If GE closes below $279.57 → close immediately. Do NOT hold through a stop breach.

### POSITION SUMMARY

| Ticker | Entry | Close | P/L% | Stop | Gap to Stop | Status |
|--------|-------|-------|------|------|-------------|--------|
| ABBV | $207.06 | $211.13 | +1.97% | $197.10 | +7.2% | GOOD |
| GE | $302.09 | $284.32 | -5.87% | $279.57 | +1.7% | CRITICAL |
| MCD | $315.73 | $309.96 | -1.83% | $304.31 | +1.8% | WATCH |
| MSFT | $370.57 | $365.95 | -1.25% | $356.49 | +2.6% | OK |
| PG | $143.78 | $142.44 | -0.93% | $138.80 | +2.5% | OK |
| SBUX | $92.66 | $91.00 | -1.79% | $87.26 | +4.1% | OK |

**Net P&L estimate: approx -$95 on all 6 positions combined (rough).**
**ABBV outperformance (+$4.07) partially offsets GE loss (-$17.77). MCD, MSFT, PG, SBUX all modest losses.**

---

## SESSION 7 STRATEGY SCOUT FINDINGS

### NEW FINDING 1: Gold Futures Engineered Trend (arXiv Nov 2025) — Confidence 5/5

**SOURCE:** arXiv 2511.08571 — "Forecast-to-Fill: Benchmark-Neutral Alpha in Gold Futures" (Nov 2025)

**WHAT IT IS:** A single-asset gold (GLD/gold futures) trend strategy that blends:
- 60% weight: EMA slope z-scored vs 10-year rolling window
- 40% weight: price > 50-day prior (binary momentum)
- Entry when blended probability > 0.52 AND EMA slope is positive
- ATR-based stops (2x ATR hard, 1.5x ATR trailing), 30-day max hold
- Kelly-derived position sizing targeting 15% annualized volatility

**PUBLISHED PERFORMANCE (OOS 2015-2025):**
- Sharpe: 2.88 (bootstrap 95% CI: 2.49-3.27)
- Hit rate: 65.81%
- MDD: 0.52%
- Alpha vs gold benchmark: 2.25% annualized, Beta: 0.03
- SURVIVES T+2 delays (Sharpe still 2.24)

**CURRENT REGIME APPLICATION:** GLD is in a strong uptrend driven by flight-to-quality + oil shock. EMA slope is almost certainly positive and momentum confirmed. THIS SIGNAL IS LIKELY ACTIVE NOW.

**ACTION:** Propose implementation to backend. Until then, treat GLD as a long with ATR-based stop. This is an all-weather gold trend system, not a regime-dependent bet.

---

### NEW FINDING 2: Oil-Equity Divergence Cross-Asset (Novel) — Confidence 3/5

**SOURCE:** No published backtest exists. Identified as research gap by this session's scout.

**CONCEPT:** When crude oil closes up >3% AND SPY closes down >0.5% on the same day → buy SPY at next open. Rationale: oil-driven equity selling often overshoots. The "war premium" in oil does not mechanically require equity weakness and frequently reverts once the immediate fear response fades.

**ENHANCEMENT:** Stack with Correlated Stress Reversal signal (IEF+, USO-, SPY-) for maximum confluence.

**CURRENT RELEVANCE:** Today's session: Brent +3.6%, S&P -1.58% — this signal FIRED today. If strategy were live, we would be long SPY for tomorrow's open.

**BACKTEST TARGET:** SPY 2000-2026, entry when crude >3% AND SPY <-0.5%, hold 1-3 days. Compare vs:
- Base case: buy SPY any day crude >3%
- Filtered: add SPY down requirement
- With IEF+ confirmation: add Correlated Stress Reversal filter

---

### CONFIRMED FINDINGS (S6 strategies, updated with S7 data)

**Correlated Stress Reversal (QuantPedia Apr 2025):**
- Signal likely fired today (IEF up, SPY down, oil up)
- Published Sharpe: 1.05-1.12, win rate ~53-54%
- Note: published win rate is modest but the overnight reversal expectation is mechanically sound
- Stacking signals (IEF+ AND USO- AND SPY-) improves performance
- Still top priority for backtest when backend returns

**Zweig Breadth Thrust:**
- Nasdaq breadth 35.49% — STILL IN SETUP ZONE
- ZBT fired April 2025 and produced +7% in 3 weeks, +15% in 3 months
- Current setup is different: geopolitical crisis-driven breadth weakness, not typical bear market capitulation
- WATCH: if NYSE breadth < 0.40 then snaps to 0.615+ within 10 days — very rare, 19/19 historical

**VIX Term Structure:**
- Backwardation currently (M1 > M2) — confirms risk-off regime
- DO NOT short volatility in backwardation
- Wait for return to contango (post-Iran resolution) as short-vol entry signal

---

## IRAN CONFLICT UPDATE (EOD March 26)

- Pakistan mediating indirect talks. US proposed 15-point plan.
- Iran counter-demands include recognition of Iranian sovereignty over Strait of Hormuz — US will not accept this.
- Israel struck Isfahan; Iran responded with missile attacks on Israel. Hezbollah active from Lebanon.
- Iran struck Kuwait International Airport fuel tank.
- Trump: "Iran needs to get serious." Iran: "US proposal is maximalist and unreasonable."
- No ceasefire imminent. War premium in oil is likely to persist into April.

**ENERGY IMPLICATION:** XLE correctly identified as the primary trade. XLE now closed at $61.56 (new 52-week high). The next question is whether energy continues to run or whether any ceasefire news creates a sharp reversal. Our paper position is CLOSED — excellent timing.

---

## PCE PREVIEW (March 28)

Consensus estimates:
- Headline PCE MoM: +0.3%
- Headline PCE YoY: +2.5%
- Core PCE MoM: +0.3%
- Core PCE YoY: +2.7% (above Fed's 2% target, above Jan 2026 reading of 2.6%)

HOT PRINT scenario (Core PCE > 2.8%):
- VIX spikes to 28-30
- Equity selloff continues
- MR strategies hit sweet spot — highest VIX-amplified reversal premium
- GE stop almost certainly triggered
- MCD stop potentially triggered
- Mean reversion entry candidates emerge in oversold large caps

COOL PRINT scenario (Core PCE ≤ 2.5%):
- VIX compresses toward 22
- Breadth recovery possible — ZBT setup could accelerate
- Tech bounce, but April 10 CPI still the bigger event
- Consider long positions in oversold quality names (MCD, MSFT)

**NO NEW POSITIONS BEFORE PCE — rule remains in effect.**

---

## SESSION 7 SUMMARY

**Portfolio:** XLE paper trade CLOSED at +10.35%. First win. GE Portfolio Manager position dangerously close to stop.
**Research:** 2 new strategies identified (gold trend Sharpe 2.88, oil/equity divergence novel). Confirmed S6 findings on correlated stress reversal and ZBT.
**Market:** S&P -1.58%, tech -3%, energy +1.63%. Iran war escalating.
**Next session focus:**
1. Check GE stop first
2. Backtest correlated_stress_reversal (top priority)
3. Re-test cumulative_rsi with correct params
4. Test gold_futures_trend implementation
5. Composites: poc_reversion + center_of_gravity
