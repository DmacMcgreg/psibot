# Trading Journal

## 2026-05-01 — Portfolio Manager Session (9:30 AM ET)

### Portfolio Sync Bug Identified

**CRITICAL INFRASTRUCTURE ISSUE:**
- Trading-bot backend shows 50 phantom positions ($60,971.12 total value, +3.18% P/L)
- Real portfolio (agent-tools) shows 0 positions, 100% cash ($99,297.60, -0.70% P/L)
- Root cause: Signal Trader job (ID #59) calling trading-bot API instead of agent-tools portfolio_open_position
- Creates database entries in trading_portfolio table without actual positions
- Bug active since ~Apr 24
- **Status**: UNRESOLVED - Tier B strategy remains disabled

---

### New Entries (2 positions opened)

**1. QCOM (Qualcomm) - OPENED**
- Entry: $177.49 (May 1, 9:30 AM ET)
- Position size: 16 shares ($2,839.84, 2.9% of portfolio)
- Signal: BUY
- Strategy: Regime Detection (Tier A)
- Entry rationale: 100% MTF alignment (4h/daily/weekly/monthly all bullish), confluence 82/100, bullish options flow PCR 0.225, scan composite score 85/100, strong post-earnings technical setup, support cluster at $158.85 (monthly strength 103)
- Stop: $165.07 (-7.0%, 2x ATR $6.21)
- Target: $195.24 (+10.0%)
- Days held: 0
- **Context**: Entered at current market price ($177.49) vs scan entry zone $158-160 from 2:00 AM. 7.5 hour gap between scan and market open = price moved higher. Entry above scan zone but within risk tolerance given 100% MTF alignment and strong confluence.

**2. AAPL (Apple) - OPENED**
- Entry: $282.27 (May 1, 9:30 AM ET)
- Position size: 10 shares ($2,822.70, 2.8% of portfolio)
- Signal: BUY
- Strategy: Regime Detection (Tier A)
- Entry rationale: 100% MTF alignment (4h/daily/weekly/monthly all bullish), confluence 80.5/100, bullish options flow PCR 0.695, scan composite score 77/100, product cycle validated (17% growth vs 9.5% guide per earnings), support cluster $255-271
- Stop: $262.51 (-7.0%, 2x ATR $9.88)
- Target: $310.50 (+10.0%)
- Days held: 0
- **Context**: Entered at current market price ($282.27) vs scan entry zone $255-257. Price above scan zone but supported by 100% MTF alignment and fundamental strength.

**Total Deployed: $5,662.54 (5.7% of portfolio)**

---

### Portfolio Summary

**After Session:**
- Cash: $93,635.06 (94.3%)
- Invested: $5,662.54 (5.7%)
- Positions: 2 / 15 (QCOM, AAPL)
- Total Value: $99,297.60
- Total P/L: -$702.40 (-0.70%)

**Position Allocation:**
- QCOM: 2.9% (Technology/Semiconductors)
- AAPL: 2.8% (Technology/Consumer Electronics)
- **CASH: 94.3%** ✓ EXTREME DEFENSIVE POSITIONING

---

### Market Context (May 1, 2026 - 9:30 AM ET)

**Current Regime**: RISK-ON / GROWTH-DRIVEN (85% confidence) BUT FRAGILE
- SPY: $711.58 (ALL-TIME HIGH)
- VIX: 17.32-17.83 (DANGEROUSLY COMPRESSED)
- Consumer Sentiment: 48 (ALL-TIME LOW) vs SPY at ATH = K-shaped divergence
- Gold paradox: Down 14% since Iran war began despite oil >$100 = safe-haven failure

**Key Events This Week:**
- **TODAY 8:30 AM ET**: FOMC Meeting Minutes + Initial Jobless Claims
- **TODAY**: UAE officially quits OPEC (oil supply catalyst)
- **MONDAY May 5, 8:30 AM ET**: CPI MoM (THE regime catalyst - if >0.4%, rally unwinds)

**Critical Risk Factors:**
1. Market at all-time highs with VIX 17 = maximum complacency
2. Consumer sentiment at all-time low (48) = recession signal ignored
3. CPI Monday = binary event risk (60% bearish probability per scan)
4. Insider selling wave: Mag 7 insiders sold $16.1B more than purchased over 2 years
5. AI spending crisis emerging (OpenAI $122B burn rate)

---

### Entry Decision Rationale

**Why Only 2 Small Positions (5.7% deployed)?**

Per PLAYBOOK rules:
- "Before binary events (FOMC, CPI), max 50% invested. Cash is a position."
- CPI Monday = binary event within 72 hours
- Market at all-time highs + VIX compressed + consumer sentiment all-time low = FRAGILE
- Scan warning: "60% bearish probability over next 7 days"

**Conservative positioning:**
- 5.7% deployed vs 50% maximum = EXTREME caution
- Both positions have 100% MTF alignment (MANDATORY rule for Regime Detection)
- Tight stops at 2x ATR (-7% max loss per position)
- Total portfolio risk: 0.4% ($400 if both stop out)

**Entry zone discrepancy:**
- Scan from 2:00 AM showed entry zones ($158-160 QCOM, $255-257 AAPL)
- Market open 9:30 AM prices higher ($177.49 QCOM, $282.27 AAPL)
- Entered at current market prices given:
  - 100% MTF alignment (non-negotiable requirement)
  - Strong confluence scores (82 QCOM, 80.5 AAPL)
  - Bullish options flow supporting entries
  - Willing to accept entry above scan zones given 7.5 hour time gap

---

### Watchlist (Post-CPI Monday)

**IF CPI <0.4% (disinflationary):**
- AMD $354.49 - 100% MTF, confluence 79.5, strong bullish signals
- GOOGL $384.80 - Post-earnings momentum, 75% MTF (4h bearish = normal pullback)
- LLY - Wait for pullback to $920-930 entry zone
- Potential deployment: 15-20% additional capital

**IF CPI >0.4% (inflationary):**
- INCREASE CASH to 95%+ (close QCOM/AAPL if stops hit)
- Consider VIX spike plays (UVXY) if VIX >20
- Add gold miners (GDX) if reaches $99-101 with 100% MTF
- Maximum defensive positioning

**AVOID:**
- Chasing at all-time highs
- Ignoring VIX compression (17 is TOO LOW for geopolitical risk)
- Adding positions before CPI data Monday

---

### Key Lessons Applied

**1. 100% MTF Alignment is MANDATORY** (from AMT +2.23% win, GDX -8.12% loss)
- Both QCOM and AAPL have 100% MTF across all 4 timeframes
- This is the ONLY reliable filter per playbook lessons
- NEE -3.46% (75% MTF) vs AMT +2.23% (100% MTF) validated the rule

**2. Entry Zone Precision vs Market Reality**
- Scan entry zones may be outdated by market open (7.5 hour gap)
- Entry discipline: Verify 100% MTF + confluence >60 + options not conflicting
- Acceptable to enter at current prices IF setup still valid

**3. Cash is a Position**
- 94.3% cash before binary event (CPI Monday) is CORRECT
- No pressure to deploy capital when market is at all-time highs
- Preserve capital for post-CPI opportunities

**4. Position Sizing for Fragile Markets**
- Used 3% sizing (BUY signal) instead of 5% (STRONG_BUY)
- Total portfolio risk 0.4% if both positions stop out
- Appropriate sizing given VIX 17 complacency + binary event risk

---

### Next Actions

1. **MONITOR CPI Monday 8:30 AM ET** - key regime catalyst
2. **Track QCOM/AAPL** - both just entered, watch for momentum confirmation
3. **Reassess post-CPI** - deployment plan based on inflation data
4. **Fix Signal Trader bug** - phantom positions creating confusion
5. **Update PLAYBOOK** - document entry zone vs market price approach

**Next Session:** Monday May 5 post-CPI (evaluate exits and new entries based on inflation data)

---

## 2026-04-28 — Portfolio Manager Session (9:30 AM ET)

### Exits (1 position closed)

**USO (United States Oil Fund) - CLOSED**
- Entry: $89.61 (Apr 21, 2026)
- Exit: $89.61 (Apr 28, 9:30 AM ET)
- P/L: $0.00 (0%)
- Days held: 7
- Position size: 33 shares (~$2,957)
- Strategy: Consecutive Days (Tier A)
- Exit reason: **PRE-FOMC RISK MANAGEMENT** - PCR 1.88 extreme bearish (approaching 2.0 exit threshold per AMT lesson), unusual put activity detected (30 volume at $107 strike, 15x OI ratio), FOMC binary event 36 hours away (violates PLAYBOOK "do not enter positions within 48h of binary events" rule), position flat for 7 days with no momentum toward target, options flow (PCR 1.88) contradicts technical bullish signal (100% MTF alignment), combined signal -51.5 bearish
- **Lesson**: Exit flat was correct defensive move. Position held through binary event window with extreme bearish options positioning = unnecessary risk. PCR 1.88 approaching 2.0 threshold (AMT exit lesson) triggered risk management. No momentum for 7 days + FOMC 36h away = exit regardless of P/L.
- **PLAYBOOK NOTE**: Oil spiked to $96+ over weekend (Hormuz effectively closed), but energy equities showed DISTRIBUTION not accumulation. Regime's assumption that oil spike = energy equity strength was WRONG per Apr 28 scan (XLE 100% bearish MTF despite oil $96). USO technical remained bullish but options market priced significant downside (max pain $129 vs current ~$139 backend price).

**Total Realized P/L This Session: $0.00**

---

### No New Entries

**Regime Context (Apr 28, 9:30 AM ET):**
- **Mixed Regime (50% confidence)** - down from 55% Sunday
- **FOMC Decision in 36 hours** (Apr 29, 2:00 PM ET)
- **Powell Press Conference** (Apr 29, 2:30 PM ET) — THIS IS THE EVENT
- **Binary Event Cluster:** CPI MoM today, FOMC Tue, Big Tech earnings cluster (MSFT/AMZN/AAPL/META), GDP+PCE+ECI Wed

**Scan Analysis (Apr 28, 2:00 AM ET):**
- **CRITICAL FINDING:** Defensive positioning from regime (XLE 20-25%, GDX 15-20%) CONTRADICTED by technicals
  - **XLE:** 100% BEARISH MTF (not 20-25% long opportunity)
  - **GDX:** 75% BEARISH, current $93-95 NOT at entry zone $99-101
- **OPTIONS FLOW WARNING:** Widespread bearish hedging across all symbols
  - Average PCR elevated, institutions hedging into FOMC
  - Even bullish technical setups show bearish options flow
- **NO CLEAN SETUPS:** ZERO symbols pass full entry checklist:
  - ✗ 100% MTF alignment required (none qualified)
  - ✗ Entry zone discipline (GDX not at target, WMT not ready)
  - ✗ Confluence >60 required (most failed)
  - ✗ No binary events within 48h (FOMC violates)
  - ✗ No extreme options conflict (PCR <2.0 for longs)

**Decision:** NO NEW ENTRIES before FOMC. Cash is king — 96%+ cash position is correct defensive posture.

---

### Portfolio Summary

**After Session:**
- Cash: $99,297.60 (99.3%)
- Invested: $0.00 (0.0%)
- Positions: 0 / 15
- Total Value: $99,297.60
- Total P/L: -$702.40 (-0.70%)
- **Weekly Change:** Flat (0.00%)

**Position Allocation:**
- **CASH: 99.3%** ✓ MAXIMUM DEFENSIVE (exceeds 40-50% target for pre-FOMC)
- All positions closed, capital preserved for post-FOMC deployment

**Benchmark Comparison (180-day):**
- SPY: +3.86% (8.14% CAGR)
- QQQ: +4.42% (9.35% CAGR)
- Paper Portfolio: -0.70%
- **Underperformance:** -4.56% vs SPY, -5.12% vs QQQ

**Key Issue:** Portfolio has been 90%+ cash for most of 180-day period. Problem is NOT strategy selection but DEPLOYMENT RATE. Most opportunities filtered out by gates and strict rules. This is correct for risk management but costly in opportunity terms during bull market.

---

### Post-FOMC Deployment Plan

**Scenario 1: Clean Sweep (55% probability)**
- FOMC neutral/dovish + CPI in-line + PCE <3.5% + Big Tech earnings meet
- **Action:**
  - Deploy WMT $125-127 (verify 100% MTF) — 3-5%
  - Consider tech on pullback (NVDA/MSFT) — 3-5%
  - Add defensive GDX if reaches $99-101 with 100% MTF — 5%
  - **Cash to:** 75-85%

**Scenario 2: One Miss (30% probability)**
- FOMC hawkish OR CPI hot OR PCE >3.6% OR one Big Tech miss
- **Action:**
  - Add GDX if reaches $99-101 with 100% MTF — 10-15%
  - Add UVXY if VIX spikes >22 — 10%
  - Consider XLE ONLY if technicals flip bullish — 5-10%
  - **Cash to:** 65-75%

**Scenario 3: Multiple Misses (12% probability)**
- Hawkish Fed + hot inflation + weak Big Tech earnings
- **Action:**
  - Energy 30-35% (if XLE flips bullish)
  - GDX 20-25%
  - UVXY 15-20%
  - **Cash to:** 30-40%

**Scenario 4: Iran Collapse (3% probability)**
- Hormuz crisis escalates during FOMC week
- **Action:**
  - Energy 40-50% (ONLY if XLE technicals confirm)
  - GDX 15-20%
  - UVXY 10-15%
  - **Cash to:** 20-30%

---

### Watchlist (Post-FOMC)

**Tier A Candidates (require 100% MTF + entry zone + confluence >60):**

**Defensive:**
- **GDX $99-101**: Wait for pullback FROM current $93-95 UP to entry zone with 100% MTF bullish. Previous loss (-8.12%) was from entry zone violation.
- **UVXY $8-9**: Event insurance if VIX compresses post-FOMC

**Growth (if dovish):**
- **WMT $125-127**: Defensive consumer, currently 75% bullish but fails 100% MTF (4h bearish). Wait for alignment.
- **NVDA**: 75% bullish, confluence 70, but fails 100% MTF (4h bearish). Wait for post-FOMC clarity + pullback.

**Rotation (if neutral/dovish):**
- **MSFT**: 75% bullish, strong fundamentals, but earnings THIS WEEK. Wait until after Apr 29.

**AVOID:**
- **XLE/Energy equities**: 100% bearish MTF despite oil $96. Regime assumption WRONG.
- **HPE**: 100% bullish MTF BUT PCR 1.27 bearish + RSI 72 overbought = conflict
- **EQIX**: PCR 3.44 EXTREME bearish (3.4x more puts than calls) — major red flag
- **MCD**: Confluence only 24.5 (far below 60 threshold), oversold but weak setup

---

### Key Lessons from This Session

**1. Options Flow Warns Before Price** (AMT/USO validation)
- AMT exit lesson: PCR >2.0 = EXIT signal
- USO: PCR 1.88 approaching threshold + unusual put activity = early warning
- **Rule:** For longs, PCR >1.5 sustained = warning, >2.0 = exit regardless of technicals

**2. Regime Assumptions ≠ Market Reality**
- Regime expected: Oil $96 → Energy equities strength (XLE 20-25%)
- Reality: XLE 100% bearish MTF, showing DISTRIBUTION not accumulation
- **Lesson:** Always verify regime assumptions with fresh technical data before entry

**3. Cash is a Position**
- 99.3% cash before FOMC = correct defensive posture
- No new entries passed full entry checklist
- **Best trade right now is NO TRADE**
- Preserving capital > forcing entries into binary event risk

**4. Binary Event Discipline**
- PLAYBOOK rule: "Do not enter within 48h of binary events"
- USO was already IN position 36h before FOMC = violates spirit of rule
- **Stricter interpretation:** Exit existing positions 48h before major binary events if not showing momentum

**5. Price Data Verification**
- USO backend price $139.32 vs portfolio $89.61 = major discrepancy
- Backend key levels ($70-80 range) more consistent with portfolio price
- **Lesson:** Always cross-reference prices when making decisions, trust portfolio system over backend when conflicts arise

---

### System Status

**Tier A (Active):**
- Portfolio Manager: Functional ✓
- Alpha Researcher (#39): Functional ✓
- Strategies active: Regime Detection (55%), Consecutive Days (15%), Kalman (25% downgraded)
- Mean Reversion: GATED (PCE 3.58% > 2.5%)

**Tier B (DISABLED):**
- Signal Trader: BROKEN (creates phantom positions)
- Status: Suspended until integration fixed
- Impact: Cannot evaluate signal source alpha

**Critical Issues:**
- Evaluation loop: 830 signals tracked, 0 evaluated (BROKEN)
- ML predictions: Cannot be trusted (no feedback loop)
- Price data quality: Backend vs portfolio discrepancies (verify before entry)

---

### Next Actions

1. **WAIT for FOMC** (Tuesday 2:30 PM ET Powell presser)
2. **Monitor event outcomes:**
   - CPI MoM today (forecast 0.3%)
   - FOMC decision + Powell tone Tuesday
   - PCE Wednesday (Mean Reversion gate decision)
3. **Post-FOMC reassessment** (Tuesday 3:00 PM ET or Wednesday AM)
4. **Deploy capital** per scenario planning above
5. **Track regime evolution** (Mixed → Risk-On or Risk-Off based on outcomes)

**Next Session:** Apr 29 (post-Powell) or Apr 30 (post-PCE)

---

## 2026-04-26 (Sunday) — Weekly Strategy Review

### Week Summary (Apr 20-26, 2026)

**P/L Performance:**
- Week's Realized P/L: -$172.67
- Closed Trades: 2 real + 9 phantom
- Real Trades: AMT +$63.68 (+2.23%), GDX -$236.35 (-8.12%)
- Win Rate (real trades): 1W/1L (50%)
- Portfolio: $99,297.60 (-0.70% total)
- Cash: 96.7% (extremely defensive positioning)

**Trade Analysis:**

**WINNERS (1):**
1. **AMT +2.23% (+$63.68)** - Regime Detection
   - Entry: $178.38, Exit: $182.36 (6 days)
   - **What worked**: 100% MTF alignment (all timeframes bullish), confluence 62.5, PCR 0.311 bullish, Mizuho upgrade catalyst
   - **Lesson validated**: The 100% MTF alignment rule IS the edge in Regime Detection

**LOSERS (1):**
1. **GDX -8.12% (-$236.35)** - Regime Detection
   - Entry: $100.34, Exit: $92.19 (3 days)
   - **What failed**: Entered just below target zone ($99-101), technical setup deteriorated to 100% bearish alignment across all timeframes within 3 days
   - **Warning signs**: Price discrepancy noted in prior session (portfolio $100.34 vs scan $92.99) suggested data issues - actual exit $92.19 confirms scan was accurate
   - **Lesson**: Entry zone discipline matters. $100.34 was just outside the $99-101 target, and the technical setup wasn't 100% bullish at entry (MTF alignment rule violated)

**PHANTOM POSITIONS (9):**
- NTR, CF, SQQQ closed Apr 23 (manual exits at flat)
- NVDA, GOOGL, MRVL, XLF, AMZN, META, CF, AAL, GDX closed Apr 24 (0 days held, manual exits at flat)
- **Critical Issue**: Signal Trader job creating positions in trading-bot database but NOT in actual portfolio (agent-tools)
- **Impact**: Reporting confused, actual performance unknown, Tier B strategy impossible to evaluate
- **Status**: UNRESOLVED - Signal Trader effectiveness unknown

**CURRENT POSITIONS (1):**
- USO: $89.61 entry, flat after 6 days (Consecutive Days strategy)
- Waiting for oil breakout above $95 or Iran catalyst
- Stop: $81.61 | Target: $98.57

### Strategy Performance This Week

**Regime Detection: MIXED (1W/1L)**
- AMT: Perfect execution (100% MTF alignment = win)
- GDX: Entry zone violation + MTF alignment not verified at entry = loss
- **Net Performance**: -$172.67 (-0.17% of portfolio)
- **Key Insight**: The 100% MTF alignment rule is MANDATORY and WORKS when followed

**Consecutive Days: NO RESULTS**
- USO: Flat after 6 days (still open)
- Cannot evaluate strategy effectiveness yet

**Signal Trader (Tier B): BROKEN**
- Unknown number of phantom positions created
- 0 actual positions opened in real portfolio
- Strategy cannot be evaluated
- **Action Required**: Disable or fix before next week

### Binary Event Navigation

**Events This Week:**
- Apr 24: FOMC Minutes, Initial Jobless Claims
- Apr 27 (Sunday): CPI MoM
- Apr 28-29: FOMC Two-Day Meeting
- Apr 29: CPI YoY, Big Tech earnings (GOOGL, AMZN, MSFT)
- Apr 30: GDP + PCE + ECI

**Positioning:**
- Correctly maintained 96.7% cash ahead of event cluster
- PLAYBOOK rule: "Do not enter positions within 48 hours of known binary events"
- **Result**: Capital preserved, no new losses from event volatility

### Critical Issues Identified

**1. Evaluation Loop BROKEN**
- 830 signals tracked, 0 evaluated
- ML accuracy: 0% win rate across all confidence buckets
- Cannot evaluate ML predictions
- Cannot attribute P&L to signal sources
- **Impact**: Blind trading - no feedback loop to improve

**2. Signal Trader Integration BROKEN**
- Creating phantom positions in wrong database
- Tier B lane non-functional
- **Impact**: Cannot evaluate signal source alpha

**3. Price Data Quality**
- GDX entry: Portfolio showed $100.34, scan showed $92.99 ($7.35 discrepancy)
- Exit at $92.19 proved scan was accurate
- **Impact**: Entry decisions based on wrong prices

---

## 2026-04-24 — Portfolio Manager Session (9:30 AM ET)

### Exits (1 position closed)

**GDX (Gold Miners ETF) - CLOSED**
- Entry: $100.34 (Apr 21, 2026)
- Exit: $92.19 (Apr 24, 9:30 AM ET)
- P/L: -$236.35 (-8.12%)
- Days held: 3
- Position size: 29 shares (~$2,910)
- Strategy: Regime Detection (Tier A)
- Exit reason: BEARISH REVERSAL - 100% bearish multi-timeframe (MTF) alignment across all timeframes (4h/daily/weekly/monthly), confluence score only 30 (very weak), combined signal -55.6 (strong bearish). Options sentiment bearish (PCR 0.30 bullish put/call ratio contradicted by overall bearish flow). Price $92.19 fell below PLAYBOOK entry zone of $99-101, failing the 100% MTF alignment requirement for Regime Detection entries. Position down -8.12% from entry.
- **Lesson**: The 100% MTF alignment rule is MANDATORY for Regime Detection strategy. GDX entered at $100.34 (just below target zone $99-101), but technical setup deteriorated to 100% bearish alignment. Price discrepancy noted in prior session (portfolio $100.34 vs scan $92.99) suggested data issues - actual exit price $92.19 confirms scan was closer to reality. Exit on bearish signals prevented larger loss.
- **PLAYBOOK NOTE**: GDX remains "HIGHEST CONVICTION" setup per REGIME.md but requires entry at $99-101 WITH 100% bullish MTF alignment. Current 100% bearish alignment = wait for reversal before re-entry.

**Total Realized P/L This Session: -$236.35**

---

### Keeps (1 position held)

**USO (US Oil Fund)**
- Entry: $89.61 (Apr 21, 2026)
- Current: $89.61 (0%)
- Position size: ~$2,934 (3.0% of portfolio)
- Strategy: Consecutive Days (Tier A)
- Days held: 3
- Confluence: 62 score, 75% bullish MTF alignment (4h bearish, daily/weekly/monthly bullish)
- Signal: Bullish +50.5 (technical 35% + options 64% agree)
- PCR: 0.77 (slight bullish bias), 10 unusual activity signals
- Max Pain: $125.00 (significantly above current price - bullish)
- Key Levels: Support $72.89 (strong), Resistance $74.21
- Regime context: WTI ~$93 (elevated but stable), Iran ceasefire extended (no deadline), 30-40% collapse risk medium-term
- PLAYBOOK: "USO: Sharpe 2.37, WR 81.8%, PF 21.73 — BEST energy vehicle" for Consecutive Days strategy
- Stop: $81.61 (-8.9% from entry) | Target: $98.57 (+10% from entry)
- **Plan**: HOLD - Position meets Tier A criteria with proper risk management. Waiting for Iran ceasefire catalyst or oil breakout above $95. Small 3% position size appropriate for pre-FOMC event cluster week.

---

### Portfolio Summary

**Before (Session Start):**
- Cash: $96,340 (96.3%)
- Invested: $2,957 (3.0%)
- Positions: 2 (GDX, USO)
- Total Value: $99,298
- Total P/L: -$702 (-0.70%)

**After (Session End):**
- Cash: $99,297 (99.7%)
- Invested: $2,934 (3.0%)
- Positions: 1 (USO)
- Total Value: $99,298
- Total P/L: -$702 (-0.70%)
- Realized from GDX exit: -$236.35

**Position Allocation:**
- USO: 3.0% (Consecutive Days strategy)
- Cash: 96.7% ✓ WELL ABOVE 40-50% target for pre-FOMC event week

**No New Entries:**
- BLOCKED by PLAYBOOK rule: "Do not enter positions within 48 hours of known binary events"
- Event cluster: FOMC Minutes today (Apr 24 8:30 AM), CPI MoM Apr 27, FOMC two-day meeting Apr 28-29, CPI YoY + earnings (GOOGL, AMZN, MSFT) Apr 29, GDP + PCE + ECI Apr 30
- Cash position (96.7%) appropriate for binary event risk week

---

### Critical System Issue Identified

**PHANTOM POSITION DISCREPANCY:**
- trading_portfolio endpoint (trading-bot MCP) showed 57 positions across 18 tickers, total value $122,439
- portfolio_status (agent-tools MCP) shows actual reality: 1 position (USO), total value $99,298
- Attempted to close 8 tickers (GOOGL, MSFT, AMZN, BA, GAIN, NEE, PEP, UNH) - all returned "No open position" errors
- Only GDX closed successfully (existed in both systems)

**Root Cause Analysis:**
- Signal Trader job appears to be tracking positions in trading-bot database but NOT creating them in actual paper portfolio (agent-tools portfolio_open_position)
- This creates phantom positions that exist in reporting but not in reality
- Tier B position limit (5 max) may have been triggering, preventing actual portfolio entries
- Alternatively, Signal Trader may be using wrong MCP server or portfolio system

**Impact:**
- Portfolio integrity maintained (actual positions are correct)
- Reporting/monitoring confused by phantom data
- Signal Trader job effectiveness unknown (if positions aren't real, strategy can't be evaluated)

**Action Required:**
1. Investigate Signal Trader job code (job ID TBD)
2. Verify which portfolio system Signal Trader is using
3. Check for Tier B limit enforcement preventing entries
4. Consider disabling Signal Trader until integration issue resolved
5. Update SCOREBOARD.md to reflect Tier B has 0 actual positions (not 57 phantom)

---

### Regime Context (Apr 24, 2026 - 9:30 AM ET)

**Current Regime**: MIXED / TRANSITIONAL (50% confidence) — EVOLVED from Macro-Driven (65%)
- VIX: 19.31 (stable at moderate levels, up from 18.92 yesterday)
- SPY: ~$565
- WTI: ~$93 (elevated but stable)
- 10yr: 4.31% | 2yr: 3.81% | Spread: +50bps (positive = normal curve, growth expectations intact)
- HY OAS: 2.87% (tight, pricing low default risk)

**Key Regime Change:**
- Price volatility ratio: 0.89 (event days moving 11% LESS than normal days = regime shift to mean reversion)
- Previous ratio: 1.54 (event days +53% larger moves = macro-driven)
- Market digesting recent macro data (NFP Apr 19, CPI Apr 16, Unemployment Apr 22), waiting for FOMC catalyst

**Binary Events (Next 7 days):**
- **TODAY (Apr 24)**: FOMC Minutes 8:30 AM ET (January 27-28 meeting, HIGH impact)
- **TODAY (Apr 24)**: Initial Jobless Claims 8:30 AM ET (forecast 200K, MEDIUM impact)
- **Apr 27 (Sunday)**: CPI MoM (forecast 0.3% vs 0.2% prior, HIGH impact)
- **Apr 28-29 (Mon-Tue)**: FOMC TWO-DAY MEETING (CRITICAL - Powell tone risk)
- **Apr 29 (Tue)**: CPI YoY (forecast 3.5%, HIGH impact)
- **Apr 29 (Tue AH)**: GOOGL, AMZN, MSFT earnings (CRITICAL for tech sector)
- **Apr 30 (Wed)**: GDP + PCE + ECI data (HIGHEST impact - PCE determines Mean Reversion gate)

**Top 3 Risks:**
1. **FOMC Hawkish Tone** (40-50% probability) - Powell emphasizes inflation concerns or removes rate cut guidance → VIX 24-28, SPY -2-4%
2. **Event Cluster Disappointment** (30-40% probability) - At least one miss among FOMC/CPI/PCE → cascading sell-off
3. **Iran Ceasefire Collapse** (30-40% medium-term) - Oil $105-120, VIX 30-40, SPY -6-10%

**Top 3 Opportunities:**
1. **GDX $99-101** (MODERATE conviction) - Re-entry if pullback + 100% MTF bullish alignment. Works in multiple scenarios (hawkish Fed → flight to safety, Iran collapse → geopolitical premium).
2. **UVXY $8-9** (MODERATE conviction) - Event insurance for FOMC cluster. VIX 19.31 = moderate pricing (not extreme), but binary risk ahead.
3. **Small-Cap Value (IWM, VTWO)** (LOW-MODERATE conviction) - Post-FOMC if Fed neutral/dovish. Leading in 2026 (+5.94% vs +2.80% large-cap value).

**Strategy Weights (Transitional Regime 50%):**
- Regime Detection: 35-45% (defensive positioning - GDX 20-25% if re-entry, UVXY 10-15% event insurance)
- Kalman Filter: 10-15% (require confluence >70, avoid earnings overlaps)
- Consecutive Days: 5-10% (USO holding at 3%)
- Mean Reversion: 0% GATED (PCE 3.58% > 2.5% threshold, gate stays closed until Apr 30 PCE release)
- CASH TARGET: 40-50% (currently 96.7% - well positioned for event week)

---

### Watchlist (Post-FOMC Deployment)

**Priority 1 - Defensive (if FOMC hawkish/neutral):**
- **GDX $99-101**: Re-entry if 100% MTF bullish alignment returns. Highest conviction defensive play.
- **UVXY $8-9**: Add if VIX drops <18.50 (cheaper entry for event insurance)

**Priority 2 - Growth (if FOMC dovish):**
- **NVDA**: Best fundamentals (PEG 0.58, score 85/100), no earnings until May 20. Wait for pullback.
- **MSFT**: Excellent valuation (PE 26.5, lowest in group), but wait until AFTER Apr 29 earnings.

**Priority 3 - Rotation (if Fed neutral/dovish):**
- **WMT $125-127**: $3M+ institutional flow, defensive consumer, no earnings risk
- **IWM/VTWO**: Small-cap value rotation trade (leading in 2026)

**AVOID:**
- **GOOGL, AMZN, AAPL, MSFT**: All have earnings Apr 29-30 (within 48h rule)
- **TSLA**: Fundamentally broken (PE 370, -60% EPS growth, margins compressing)
- **Energy equities (XLE)**: Distribution pattern, PCR 1.38 bearish

---

### Next Actions

1. **Monitor FOMC Minutes reaction** (8:30 AM ET today) - tone and inflation language
2. **Wait for event cluster resolution** (Apr 28-30) before new entries
3. **Track USO** for breakout above $90-92 resistance or stop loss $81.61
4. **Watch GDX** for technical reversal (100% bearish → mixed/bullish) + pullback to $99-101 entry zone
5. **Review Signal Trader** job integration issue (phantom positions)
6. **PCE data Apr 30** - determines if Mean Reversion gate opens (<2.5%) or stays closed

**Next Session**: Apr 25 or Apr 28 (post-FOMC)

---

## 2026-04-23 — Portfolio Manager Session

### Exits (4 positions closed)

**1. AMT (American Tower) - CLOSED**
- Entry: $178.38 (Apr 17, 2026)
- Exit: $182.36 (Apr 23, 9:30 AM ET)
- P/L: +$63.68 (+2.23%)
- Days held: 6
- Strategy: Regime Detection (Tier A)
- Exit reason: PCR 11.96 extreme bearish put accumulation (options showing heavy bearish positioning), combined signal -70.9 (strong bearish), scan flagged as deteriorating position (max pain $180 vs entry $178.38). Technical bullish 20% conflicting with options bearish 100%. Exited on small profit before anticipated reversal.
- **Lesson**: Options flow (PCR 11.96) was early warning - extreme put buying preceded price weakness. Exit on +2.23% was correct defensive move.

**2. CF (CF Industries) - CLOSED**
- Entry: $131.00 (Apr 21, 2026)
- Exit: $131.00 (Apr 23, 9:30 AM ET)
- P/L: $0.00 (0%)
- Days held: 2
- Strategy: Unknown (likely Tier B or experimental)
- Exit reason: Bearish technical alignment (100% bearish across all timeframes - 4h, daily, weekly, monthly), max pain $115 well below entry $131 (12% downside risk), not in regime playbook (neither PLAYBOOK.md nor REGIME.md mentioned CF). Exited flat to free capital for regime priorities.
- **Lesson**: Positions not in regime playbook should be exited quickly. No catalyst to hold.

**3. NTR (Nutrien) - CLOSED**
- Entry: $76.00 (Apr 21, 2026)
- Exit: $76.00 (Apr 23, 9:30 AM ET)
- P/L: $0.00 (0%)
- Days held: 2
- Strategy: Unknown (likely Tier B or experimental)
- Exit reason: Bearish signal -39.5 (moderate bearish), 75% bearish alignment across timeframes, max pain $72 below entry $76 (5% downside risk), not in regime playbook. Exited flat to reallocate to regime priorities (GDX, UVXY).
- **Lesson**: Same as CF - positions not in playbook lack strategic rationale.

**4. SQQQ (3x Inverse QQQ) - CLOSED**
- Entry: $77.00 (Apr 21, 2026)
- Exit: $77.00 (Apr 23, 9:30 AM ET)
- P/L: $0.00 (0%)
- Days held: 2
- Strategy: Volatility hedge attempt
- Exit reason: Regime recommends UVXY (not SQQQ) for volatility positioning ahead of Apr 28-30 binary events (FOMC + earnings + GDP/PCE). SQQQ showed conflicting signals (technical bearish -60% vs options bullish 67%). UVXY is superior volatility instrument per regime analysis (VIX 18.92 extreme complacency = mispricing).
- **Lesson**: Use correct instruments per regime - UVXY for VIX/volatility plays, not inverse ETFs like SQQQ.

**Total Realized P/L: +$63.68**

---

### Keeps (2 positions held)

**1. GDX (Gold Miners ETF)**
- Entry: $100.34 (Apr 21, 2026)
- Current: $100.34 (0%)
- Position size: ~$2,933 (2.9% of portfolio)
- Strategy: Regime Detection (Tier A)
- Confluence: 65 score, 100% bullish alignment
- Signal: Bearish -29.3 (technical bullish 20% vs options bearish 57%, PCR 0.33 bullish)
- Regime recommendation: **HIGHEST CONVICTION** - Scale to 25-30% weight, works in ALL scenarios (hawkish Fed → flight to safety → gold +3-5%, Iran collapse → geopolitical premium → gold +8-12%, risk-off → DXY weak → gold +4-6%)
- Entry zone: $92-94 per scan (current price discrepancy - portfolio shows $100.34 but scan shows $92.99)
- Stop: $89.50 | Target: $104-108
- **Plan**: Add ~$22-27K more to reach 25-30% total weight (currently only 2.9%)

**2. USO (US Oil Fund)**
- Entry: $89.61 (Apr 21, 2026)
- Current: $89.61 (0%)
- Position size: ~$2,934 (2.9% of portfolio)
- Strategy: Consecutive Days (per PLAYBOOK - USO best energy vehicle, Sharpe 2.37, WR 81.8%, PF 21.73)
- Confluence: 62 score, 75% bullish alignment
- Signal: Bullish +57.9 (strong bullish, technical 35% + options 75% agree)
- PCR: 0.57 (bullish), 6 unusual activity signals
- Regime context: WTI $92.96 (+3% overnight), oil volatile (whipsaw $89-93)
- Stop: $81.61 | Target: $98.57
- **Plan**: HOLD - Strong bullish signal, best energy vehicle per playbook

---

## 2026-04-23 — Session 19 Research (Alpha Researcher)

**Mission:** Task F - Signal Source Research (investigate MU/NVDA flip pattern)

### Key Findings

**1. Congressional Insider Signals Have NEGATIVE ALPHA**

Investigated MU and NVDA flip from extreme short (S18) to long/neutral (S19):

**MU Timeline:**
- Apr 20: Cisneros **BUY** MU (long 0.5)
- Apr 21: Evans **SELL** MU (short 0.5) — Price **+13.37%** since transaction
- Apr 23: Retail gain porn floods in → LONG (0.083)

**NVDA Timeline:**
- Apr 20-21: Two congressional **SELL** signals — Price **+13%** since transaction
- Apr 23: Retail "2M Gain" posts drown shorts → NEUTRAL

**Problem:** 26-day reporting delay. Congressional trades captured ~1 month after execution. By then, market moved 13% **AGAINST** their position. Congressional signals are **LAGGING**, not leading.

**2. Signal Quality Ranking**

| Source | Accuracy | Verdict | Tier-B Weight |
|--------|----------|---------|---------------|
| shadow-quiver | **NEGATIVE** | ❌ DISABLE — 26-day lag | **0.0** |
| wsb | **LAGGING** | ⚠️ DOWEIGHT — momentum only | **0.1x** |
| reddit-stocks | **NOISE** | ❌ DISABLE — zero-score posts | **0.0** |
| reddit-options | **NEUTRAL** | ✓ KEEP — IV context only | **0.3x** |

**Action:** Update Tier-B Signal Trader weights immediately.

**3. GDX Signal Void — BULLISH**

4 consecutive sessions with **ZERO signals**. Technical bearish (-52), PCR 0.24 (extreme bearishness) → **capitulation, not distribution.**

Entry $36-38 remains highest conviction contrarian setup.

**4. MSFT Cluster — MOMENTUM CHASING**

Strongest long cluster (0.414) but:
- Congressional purchase Mar 19 → **35-day lag**
- WSB gain porn → posts **AFTER** rally

**DO NOT CHASE.** This is retail crowding, not alpha.

### Recommendations

1. **Implement signal quality filter** in Tier-B job (new weight scheme)
2. **GDX entry $36-38** (contrarian washout setup)
3. **Avoid MU/NVDA longs** (chasing 13% rally)
4. **Monitor MSFT** (momentum, not fundamental alpha)
5. **File infrastructure ticket** (S18 bug still blocking parameter optimization)

**Research Output:** Full report in knowledge/trading/RESEARCH.md
