# Market Scan — Session 8 | March 27, 2026

**Generated:** 2026-03-27 17:00 ET
**Backend Status:** UNREACHABLE (Day 3) — all data via web research + subagents
**Regime:** RISK-OFF / TRANSITIONAL (65% confidence, upgraded from 62%)
**Active Strategy Weights:** Kalman Filter 50% | Regime Detection 50% | All MR/Trend strategies 0%

---

## MACRO UPDATE (March 27 Pre-Market)

### Key Regime Changes Since March 26 Close
- Iran extended US energy strike pause to April 6 — market read as BEARISH (SPX fell further, Brent +$2 to $108). This is the 2nd extension and the market has shifted interpretation: extensions = prolonged uncertainty, NOT de-escalation.
- S&P 500 futures pre-market: -0.40%
- VIX futures: ~24.98 (slight relief from 25.33 close, still elevated)
- Brent crude: ~$108/barrel (up from $106 on extension announcement)
- 10Y Treasury yield: ~4.35% (down 5 bps modest safe-haven bid)
- April 6 is now the single most binary macro event on the calendar

### Iran Situation
- Iran rejected US 15-point ceasefire plan March 25 ("maximalist and unreasonable")
- Pakistan confirmed indirect US-Iran talks underway (March 26)
- Iran's counter-demands include Strait of Hormuz sovereignty recognition — non-starter for US
- Strait: Not mined/blocked but insurance siege effectively closed to Western-linked shipping (war risk premiums up 300%)
- Tanker transit costs: $100K → $400K+; Lloyd's designated entire Arabian Gulf as conflict zone
- Next binary: April 6 at 8:00 PM ET (Iran strike pause expiration)

### New Sector: Defense Confirmed as Safe-Haven
Global X Defense Tech ETF: +20% YTD, $1B+ 2026 inflows
Consumer Staples (XLP): +13.2% YTD, $1B inflows in late March specifically
Gold (GLD): +20.26% YTD through Feb, currently correcting to ~$400 (below 50-day MA)
Energy (XLE): Leading sector, XOM/CVX near 52-week highs

### Tariff Overhang
Section 122 global 10% tariff (effective Feb 24, 2026) being challenged by 24 states. Stagflation risk compounds oil shock. No resolution before April 10 CPI.

---

## PHASE 2: DYNAMIC DISCOVERY

**Backend unreachable** — get_trending, get_opportunities, intelligence_scan all failed.
New discoveries from web research:
- TERN (Terns Pharma): Unusual options spike (160x avg volume, May $55 calls) — monitor only
- Defense cluster (RTX, LMT, NOC, ITA): Institutional inflows, new safe-haven categorization
- Maritime/shipping (FRO, DHT): Benefiting from Hormuz rerouting (Cape of Good Hope +15-20 day voyages)
- AEM/WPM: Gold miners with exceptional margins at current gold prices

---

## PHASE 3: PARALLEL SCAN RESULTS

### TECHNICAL SCAN — Top 15 Setups

**Critical Portfolio Checks:**

| Position | Entry | Close 3/26 | Stop | Gap | Status |
|----------|-------|------------|------|-----|--------|
| GE | $302.09 | $284.32 | $279.57 | $4.75 (1.7%) | CRITICAL |
| MCD | $315.73 | $309.96 | $304.31 | $5.65 (1.8%) | WATCH |
| ABBV | $207.06 | $211.13 | $197.10 | $14.03 (6.6%) | RAISE STOP |
| MSFT | $370.57 | $365.95 | $356.49 | $9.46 (2.6%) | OK |
| PG | $143.78 | $142.44 | $138.80 | $3.64 (2.6%) | OK |
| SBUX | $92.66 | $91.00 | $87.26 | $3.74 (4.1%) | OK |

**GE Note:** All MAs bearish. Forecasted range $282-$297 (low end $2.43 above stop). Lowest analyst PT $279 aligns with stop. Consider tightening stop to $281 or closing partial on any bounce above $290.

**Top 15 Setups by Signal Strength:**

1. **MSFT $365.97** — bb_mean_reversion + zscore_mean_reversion + williams_r
   - RSI 27.3 (extreme oversold), CCI -166
   - DISCREPANCY: 12/12 MAs = SELL (bearish structural). Half size only. PCE binary.
   - Entry: dip $358-362, Stop: $344.50, Target: $390-400

2. **AAPL $252.89** — bb_mean_reversion + zscore_mean_reversion
   - RSI 22.1 (extreme oversold, below 25)
   - 52-week range $169-$289, lower quartile but NOT near all-time low
   - Entry: confirmed bounce above $255, Stop: $244, Target: $270-275

3. **XOM $165.43** — kalman_filter + regime_detection
   - Within 1.2% of 52-week high ($167.48). Brent $108 fundamental tailwind
   - Entry: pullback $162-163, Stop: $158, Target: $172-175
   - EXIT TRIGGER: Iran ceasefire (not price target)

4. **CVX $207.79** — kalman_filter + regime_detection
   - Within 1% of 52-week high. 4% dividend yield. CEO: "markets aren't pricing supply shock"
   - Entry: dip $202-204, Stop: $197, Target: $215-220

5. **OXY $64.36** — kalman_filter + regime_detection
   - AT 52-week high ($64.44). +30% YTD. Berkshire implied support
   - Entry: pullback $60-61, Stop: $57.50, Target: $70-72

6. **COP $133.25** — kalman_filter + regime_detection
   - At 52-week high zone. +3.35% March 26. Best valuation in energy (Fwd P/E 19.5x)
   - Entry: dip $128-130, Stop: $124, Target: $140

7. **HAL $38.79** — kalman_filter + regime_detection
   - Within 3% of 52-week high. +51.8% market cap YTD. Oilfield services leverage
   - Entry: pullback $36-37, Stop: $34.50, Target: $43-45

8. **VLO $248.14** — regime_detection + kalman_filter ⭐ BEST ENERGY SETUP
   - Near ATH. +5.8% March 26. Crack spreads outperform in Hormuz scenario
   - KEY INSIGHT: Crack spread normalizes SLOWER than oil price on ceasefire — 4-6 week lag
   - Entry: pullback $238-240, Stop: $232, Target: $260-265

9. **GLD $400.64** — kalman_filter (HOLD ONLY — trend signal NOT active)
   - DISCREPANCY: gold_futures_trend signal requires price > 50-day MA. GLD is ~12-15% BELOW its 50-day MA (~$455-468). Signal NOT active.
   - 200-day MA support at $398-400 holding through 3 tests in March
   - Hold above $398-400, Stop: $392, Target: $425-435

10. **GDX $82.39** — kalman_filter
    - Down 30.79% from $117 February peak. Miners underperforming gold (-31% vs -21%)
    - IF GLD holds $398, GDX offers more leverage on recovery
    - Entry: GLD holds $398 AND GDX holds $80, Stop: $77, Target: $95-100

11. **ABBV $211.12** — kalman_filter ⭐ RAISE STOP
    - 50-day SMA $186.89, 200-day $187.09 — $24 above both MAs (strong structure)
    - RSI ~61 (healthy). Beta 0.33. Best defensive position
    - Raise stop from $197.10 to $202 to lock in gains

12. **MRK $118.93** — kalman_filter + regime_detection
    - Upper third of 52-week range. Beta 0.26. P/E 16.4x. 2.86% dividend
    - Entry: dip $115-117, Stop: $111, Target: $124-125

13. **KO $74.69** — regime_detection
    - Beta 0.33. 3% dividend yield. EPS growth +23.6%. 62-year streak
    - $1B XLP inflow confirmed. Classic safe-haven rotation
    - Entry: dip $73-74, Stop: $70, Target: $79-80

14. **WMT $122.18** — regime_detection
    - Consumer trade-down beneficiary. 31 analyst Strong Buy ratings
    - Concern: P/E 46.9x — no margin for error
    - Entry: dip $119-120, Stop: $115, Target: $130

15. **PFE $27.57** — bb_mean_reversion (LOW CONFIDENCE)
    - +1.06% March 26 (outperformed market). Near multi-year lows
    - Fundamental headwinds (post-COVID revenue trough) make this LOW conviction
    - Entry: RSI below 25 ONLY, Stop: $25.50, Target: $30-32

---

## PHASE 4: COMPOSITE SCORING

### Scoring Methodology
- Technical (40%): Confluence, multi-timeframe, volume
- Fundamental (20%): Valuation, growth, analyst consensus
- Sentiment (20%): News + social, unusual activity
- Options flow (10%): Backend down, limited data
- ML prediction (10%): Backend down, N/A

### Top Ranked Setups

| Rank | Symbol | Strategy | Tech | Fund | Sent | Composite | Regime Fit |
|------|--------|----------|------|------|------|-----------|------------|
| 1 | VLO | kalman + regime_det | 85 | 80 | 75 | 81 | STRONG |
| 2 | ABBV | kalman_filter | 85 | 95 | 85 | 88 | STRONG |
| 3 | KO | regime_detection | 75 | 85 | 80 | 79 | STRONG |
| 4 | PM | regime_detection | 70 | 85 | 65 | 74 | STRONG |
| 5 | AEM | kalman_filter | 75 | 80 | 70 | 75 | STRONG |
| 6 | XOM | kalman + regime_det | 80 | 65 | 80 | 75 | MODERATE (war premium priced) |
| 7 | CVX | kalman + regime_det | 80 | 65 | 80 | 75 | MODERATE (war premium priced) |
| 8 | MRK | kalman + regime_det | 70 | 65 | 65 | 67 | MODERATE |
| 9 | MSFT | bb_mr + zscore_mr | 75 | 80 | 60 | 73 | POST-PCE ONLY |
| 10 | AAPL | bb_mr + zscore_mr | 80 | 75 | 60 | 74 | POST-PCE ONLY |

### Defense Discovery (New Category)
| Symbol | Strategy | Rationale | Entry |
|--------|----------|-----------|-------|
| RTX | regime_detection | $1B+ inflows, +4.5% YTD, global rearmament | Pullback |
| LMT | regime_detection | +14.9% 2026, order backlog non-cyclical | Pullback |
| ITA (ETF) | regime_detection | +14% YTD, broadest defense exposure | Dip |

---

## PHASE 5: VALIDATION FLAGS

1. **GLD trend signal — CORRECTED:** Previous session notes said gold_futures_trend "likely active." Technical analyst confirmed this is INCORRECT — GLD is ~12-15% BELOW its 50-day MA. The signal requires price > 50-day prior AND positive EMA slope. Both conditions are NOT met. Do not trade gold_futures_trend until GLD recovers above 50-day MA. (Hold is valid; new aggressive long is not.)

2. **Energy analyst targets vs price — CONFIRMED DISCREPANCY:** XOM, CVX, OXY, COP, VLO all have analyst fundamental targets 10-22% BELOW current prices. These are pure geopolitical/regime momentum plays. Analyst PTs reflect fundamental value without war premium. EXIT TRIGGER should be Iran ceasefire news, not analyst PTs.

3. **MSFT CONFLICT — FLAGGED:** RSI 27.3 (oversold = BUY signal) vs 12/12 MAs = SELL. This is a genuine technical conflict. Resolution: treat as half-size MR setup valid only AFTER PCE Friday confirms direction. Do not enter before PCE.

4. **GE fundamental check — PASS:** The -8.4% drop is market-driven (Iran war civil aviation overhang + risk-off selling), NOT fundamental deterioration. Analyst consensus remains Buy/Strong Buy with $331-$425 targets. Insider sells ($11.5M Jan-Feb) are likely planned 10b5-1 sales. Stop discipline applies — close at $279.57 if hit, but not early.

5. **52-week high context on energy — NOTED:** XOM, CVX, OXY, COP are near or at 52-week highs after massive YTD runs. Per LESSONS.md, "near 52-week high" in a strong uptrend means the uptrend is intact, not that it's a sell. However, at THIS specific price with war premium baked in, the risk/reward for new entries is asymmetric. VLO is preferred because refiner thesis has slower reversal on ceasefire.

---

## PHASE 6: OUTPUT SUMMARY

### PCE Scenarios (March 28 8:30 AM ET)

| Scenario | Core PCE | Market Impact | Action |
|----------|----------|---------------|--------|
| HOT | >3.1% YoY | SPX -1.5 to -2.5%, VIX 28-30 | Tighten GE/MCD stops Thu EOD. Enter AAPL/MSFT post-print as MR |
| IN-LINE | 2.7-3.0% | SPX +0.5-1%, VIX 23-24 | Hold all. Add ABBV/MRK on dips |
| COOL | <2.5% YoY | SPX +1.5-2.5%, tech +4-6% | Trim energy, add AAPL/MSFT/META aggressively |

### Fundamental Top 5 for Risk-Off Regime
1. ABBV — 9.5/10 (45% EPS growth, 14.5x P/E, defensive)
2. KO — 8.5/10 (62-year dividend, $1B sector inflows)
3. PM — 8.0/10 (45% earnings growth, 11.5% upside, 3.1% yield)
4. AEM — 7.5/10 (95% gold margin capture, record FCF)
5. WPM — 7.0/10 (77% net margins, streaming model, 50% production growth)

### Earnings Calendar — No new buys within 5 days before
- JNJ: April 14 (avoid now)
- NEM: April 23
- LLY: April 30
- MRK: April 30
- AEM: April 30
- ABBV: Late April/Early May (confirm before adding)

---

## SESSION 8 NEXT STEPS

1. When backend live: IMMEDIATELY check GE position — close if below $279.57
2. When backend live: Raise ABBV stop from $197.10 to $202
3. Post-PCE Friday: Evaluate AAPL/MSFT/META mean reversion entries
4. Backtest correlated_stress_reversal (top priority — signal fired March 26: Brent +3.6%, SPX -1.58%)
5. Backtest oil_equity_divergence (signal fired March 26)
6. Test gold_futures_trend — confirm conditions for signal re-activation
7. Look at defense cluster: RTX, LMT, ITA for regime_detection entries
8. Monitor TERN options activity for catalyst announcement
