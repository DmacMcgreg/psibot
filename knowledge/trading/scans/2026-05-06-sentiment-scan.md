# Sentiment & Options Flow Scan - 2026-05-06

**Scan Time:** 2026-05-06 21:07 UTC
**Context:** Post-Iran peace deal - semis surge, oil crash rotation

## Executive Summary

**Market Rotation Signal: STRONG**
- **Rotating IN:** Semis (AMD, NVDA, QCOM, MU), Tech mega-caps
- **Rotating OUT:** Energy sector (oil crash -16.7%)
- **Overall Sentiment:** Risk-on, tech leadership resumed
- **Key Divergence:** QCOM - bullish PCR but heavy unusual put activity (contrarian warning)

---

## Sentiment Scores (News-based, 24h window)

### Mega-Cap Tech
| Symbol | Score | Label | Confidence | Mentions | Bull/Bear/Neutral |
|--------|-------|-------|------------|----------|-------------------|
| NVDA   | 73.66 | Bullish | High | 50 | 48/2/0 |
| QCOM   | 57.89 | Bullish | Medium | 18 | 17/1/0 |
| GOOGL  | 0 | Neutral | Low | 0 | 0/0/0 |
| AAPL   | 0 | Neutral | Low | 0 | 0/0/0 |
| AMZN   | 0 | Neutral | Low | 0 | 0/0/0 |
| MSFT   | 0 | Neutral | Low | 0 | 0/0/0 |
| TSLA   | 0 | Neutral | Low | 0 | 0/0/0 |

**NVDA Narrative:** 50 news mentions driven by:
- Corning partnership ($500M investment, fiber-optics capacity expansion)
- Super Micro CEO addressing $2.5B smuggling scheme (not NVDA target)
- Nvidia-related AI infrastructure deals

**QCOM Narrative:** Strong earnings momentum:
- Beat Q2 estimates, AI smartphone chip strategy with OpenAI
- Record automotive revenue, share buybacks, dividend increase
- 7.32% gain on 2026-05-05

### Semiconductors (Hot Sector)
| Symbol | Score | Label | Confidence | IV Percentile |
|--------|-------|-------|------------|---------------|
| AMD    | 0 | Neutral | Low | 71% (elevated) |
| AVGO   | 0 | Neutral | Low | 0% (cheap) |
| MU     | 0 | Neutral | Low | 80% (elevated) |

**Note:** Sentiment data gaps for AMD/AVGO/MU despite known +9.4% semi surge. News lag or source limitations.

### Energy (Rotation Victim)
| Symbol | Score | Label | Confidence | IV Percentile |
|--------|-------|-------|------------|---------------|
| XOM    | 0 | Neutral | Low | 87% (expensive) |
| CVX    | 0 | Neutral | Low | 91% (expensive) |
| SLB    | 0 | Neutral | Low | 92% (expensive) |
| VLO    | 0 | Neutral | Low | 97% (very expensive) |

**Energy IV Spike:** Options pricing in continued volatility from oil crash. High IV = hedging demand or uncertainty.

### Indices
| Symbol | Score | PCR | IV Percentile |
|--------|-------|-----|---------------|
| SPY    | 0 | 1.07 (bearish) | 0% (cheap) |
| QQQ    | 0 | 0.90 (neutral) | 9% (cheap) |
| IWM    | 0 | 1.04 (bearish) | 0% (cheap) |

---

## Options Flow Analysis

### Put/Call Ratio Summary
| Symbol | Vol PCR | Signal | OI PCR | Interpretation |
|--------|---------|--------|--------|----------------|
| **BULLISH (<0.5)** |
| GOOGL  | 0.314 | Bullish | 0.742 | Strong call demand |
| AAPL   | 0.329 | Bullish | 0.579 | Strong call demand |
| NVDA   | 0.323 | Bullish | 0.888 | Strong call demand |
| MSFT   | 0.356 | Bullish | 0.474 | Strong call demand |
| AMZN   | 0.449 | Bullish | 0.445 | Moderate call demand |
| XOM    | 0.45  | Bullish | 0.444 | Energy bounce play? |
| CVX    | 0.466 | Bullish | 0.531 | Energy bounce play? |
| TSLA   | 0.491 | Bullish | 0.553 | Tech momentum |
| **NEUTRAL (0.5-1.0)** |
| AVGO   | 0.641 | Bullish | 1.178 | Mixed, OI leans put |
| MU     | 0.632 | Bullish | 1.661 | Call flow vs put OI |
| AMD    | 0.837 | Neutral | 1.093 | Balanced sentiment |
| QQQ    | 0.898 | Neutral | 2.356 | Index hedge activity |
| **BEARISH (>1.0)** |
| IWM    | 1.038 | Bearish | 2.933 | Small-cap caution |
| SPY    | 1.074 | Bearish | 2.032 | Market hedge activity |
| SLB    | 1.281 | Bearish | 0.318 | Energy sector pain |
| VLO    | 2.098 | Bearish | 0.918 | Oil refiner carnage |
| QCOM   | 0.322 | Bullish | 0.334 | **DIVERGENCE FLAG** |

---

## Top Unusual Options Activity

### NVDA (Most Active - $139M Call Premium)
- **205C:** 517K vol (22.7x OI), $139M premium - massive bullish bet
- **202.5C:** 189K vol (8.7x OI), $92.5M premium
- **200C:** 84K vol (3.2x OI), $65.2M premium
- **Signal:** Institutional call buying, targeting continued rally
- **Current:** $207.83, Max Pain: $197.50 (-5%)
- **GEX:** Neutral (dealers mixed)

### AMD (Post-Surge Positioning - $35M Call Premium)
- **420C:** 31.5K vol (11.9x OI), $34.9M premium - at-the-money
- **410C:** 15.4K vol (3.7x OI), $26.1M premium - ITM
- **420P:** 16K vol (592x OI), $15M premium - **NEW PUT OPENING**
- **Signal:** Call buyers chasing, but smart money opening puts at 420
- **Current:** $421.39, Max Pain: $340 (-19% - stale data)
- **IV:** 71% percentile (elevated from volatility)

### MU (Memory Mania - $36M Call Premium)
- **660C:** 17K vol (6.6x OI), $36.4M premium - near ATM
- **700C:** 38.5K vol (3.3x OI), $24.7M premium - upside lottery
- **Signal:** Pure bullish flow, zero unusual puts
- **Current:** $666.59, Max Pain: $565 (-15%)
- **IV:** 80% percentile (expensive but buyers don't care)

### QCOM (DIVERGENCE WARNING)
- **Call Flow:** PCR 0.32 (very bullish)
- **Unusual Puts:**
  - 192.5P: 1,269 vol (634x OI), $492K - NEW
  - 185P: 3,677 vol (10x OI), $430K
  - 190P: 1,503 vol (10x OI), $418K
- **Signal:** Retail chasing calls, smart money buying downside protection
- **Current:** $192.57, IV: 97% percentile (VERY expensive)
- **Risk:** After +7% day, options pricing in reversal risk

### SPY (Index Hedging)
- **Massive Call Flow:** 730-734C strikes, $87M-$63M premiums
- **Unusual Puts:**
  - 735P: 59K vol (1640x OI), $3.5M - portfolio hedge
  - 740P: 3,792 vol (115x OI), $2.1M
- **Signal:** Call buyers pushing higher, institutions hedging
- **PCR 1.07:** More put volume = hedge demand, not bearish conviction

### Energy Sector (Capitulation)
- **SLB:** PCR 1.28 (bearish), 55P: 2,467 put vol (7.5x OI)
- **VLO:** PCR 2.10 (very bearish), minimal unusual activity (giving up)
- **XOM/CVX:** Bullish PCR despite oil crash - contrarian bounce setup?

---

## IV Percentile Signals (Options Pricing)

**Cheap Options (Buy Vol):**
- SPY: 0% - Market complacency
- QQQ: 9% - Tech confidence
- IWM: 0% - Small-cap ignored
- GOOGL, AAPL, AMZN, NVDA, MSFT, AVGO: 0-33% - Mega-cap stability

**Expensive Options (Sell Vol or High Risk):**
- VLO: 97% - Refiner panic
- SLB: 92% - Energy services fear
- CVX: 91% - Energy major stress
- XOM: 87% - Energy major stress
- MU: 80% - Memory mania premium
- AMD: 71% - Semi volatility
- QCOM: 97% - **POST-SURGE FEAR SPIKE**

**Trade Idea:** Energy IV crush coming if oil stabilizes. Consider selling premium on XOM/CVX vs buying tech.

---

## Narrative Shifts & Momentum Signals

### 1. Iran Peace Deal = Risk-On Rotation
- **Winners:** Tech (NVDA, QCOM, AMD, MU) - AI/semi narrative back in focus
- **Losers:** Energy (oil -16.7%) - geopolitical risk premium removed
- **Confirmation:** Bullish PCR across all mega-cap tech, VIX drop to 17

### 2. Semiconductor Leadership Restored
- **AMD +19% (from context):** Post-earnings explosion, but options show caution at 420
- **QCOM +7%:** Strong fundamentals, but IV spike to 97% = rally fatigue
- **NVDA:** Institutional call buying continuing despite already elevated
- **MU:** Pure FOMO - 80% IV, zero put protection

### 3. Energy Sector Dislocation
- **IV Spike:** 87-97% percentile across XOM/CVX/SLB/VLO
- **Bearish PCR:** SLB 1.28, VLO 2.10 - capitulation signals
- **Contrarian Setup:** XOM/CVX PCR 0.45/0.47 = early bounce positioning?
- **Risk:** If oil stabilizes at $95, energy becomes oversold bounce play

### 4. Index Divergence
- **SPY PCR 1.07, IWM PCR 1.04:** Bearish tilt = portfolio hedging
- **QQQ PCR 0.90:** Neutral = tech confidence
- **Signal:** Institutions buying tech calls, hedging broad market with SPY/IWM puts

### 5. Unusual Retail Interest
- **QCOM:** Bullish PCR 0.32 but smart money buying 192.5P after +7% day
- **AMD:** Call flow huge but unusual 420P opening (profit-taking level)
- **MU:** Zero put protection at 80% IV = peak euphoria signal?

---

## Sentiment vs Price Divergences (WARNING FLAGS)

### QCOM - CRITICAL DIVERGENCE
- **Sentiment:** PCR 0.32 (very bullish), 70K call volume
- **Unusual Activity:** Heavy put buying at 192.5/190/185 strikes
- **IV:** 97th percentile (options pricing in BIG move)
- **Current:** $192.57 (+7% yesterday)
- **Interpretation:** Retail FOMO chasing, institutions locking profits
- **Action:** Fade the rally or wait for pullback to 185 support

### MU - EUPHORIA WARNING
- **Sentiment:** PCR 0.63 (bullish), 206K call volume
- **Unusual Activity:** ZERO unusual puts
- **IV:** 80th percentile (expensive calls, buyers don't care)
- **Current:** $666.59, Max Pain: $565
- **Interpretation:** Pure momentum chase, no hedging = late-stage move
- **Action:** Don't chase, wait for IV crush or pullback

### Energy - Contrarian Setup
- **Sentiment:** PCR 0.45-0.47 on XOM/CVX (bullish)
- **IV:** 87-91% percentile (pricing in more pain)
- **Context:** Oil -16.7%, sector capitulation
- **Interpretation:** Early contrarian positioning, but no confirmation yet
- **Action:** Monitor oil price action - if $95 holds, energy could bounce

---

## Smart Money vs Crowd Positioning

### Smart Money Signals (Institutional Flow)
1. **NVDA:** $139M in 205C = conviction tech rally continues
2. **SPY:** $87M in 730C but buying 735P hedges = bullish but cautious
3. **QCOM Puts:** 192.5P with 634x OI ratio = new hedge on +7% rally
4. **AMD 420P:** Opening puts at resistance = profit-taking level
5. **XOM/CVX Low PCR:** Contrarian energy positioning starting

### Crowd Signals (Retail Flow)
1. **MU Calls:** Zero put protection at 80% IV = FOMO peak
2. **QCOM Calls:** 70K call volume chasing +7% day
3. **AMD Calls:** $35M in premium buying into 420 resistance
4. **SPY/QQQ Calls:** Massive call flow = bullish consensus

### Divergence Plays
- **Fade:** QCOM above 192 (puts stacking), MU above 665 (no hedges)
- **Follow:** NVDA (institutional call conviction), XOM/CVX (contrarian IV crush)

---

## Top Signals for Action

### HIGH CONVICTION BULLISH
1. **NVDA:** 73.66 sentiment, PCR 0.32, $139M call premium, institutional backing
2. **AAPL/GOOGL/MSFT:** PCR 0.31-0.36, cheap IV, mega-cap safety in risk-on

### MEDIUM CONVICTION BULLISH
3. **TSLA:** PCR 0.49, neutral GEX, riding tech wave
4. **QQQ:** PCR 0.90, cheap IV 9%, tech index strength

### CONTRARIAN BULLISH (Oversold Bounce)
5. **XOM/CVX:** PCR 0.45/0.47, IV 87-91% (sell premium or wait for oil stabilization)

### BEARISH / FADE RALLIES
6. **QCOM:** Divergence - bullish PCR but 97% IV, unusual put buying post +7% day
7. **MU:** 80% IV, zero put hedges, late-stage momentum chase
8. **AMD:** 71% IV, 420P opening at resistance after +19% surge

### NEUTRAL / WAIT
9. **IWM:** PCR 1.04 (bearish), small-cap lagging tech
10. **Energy (SLB/VLO):** PCR 1.28/2.10, capitulation but no catalyst yet

---

## Regime Context (from intelligence_scan)

- **SPY Sentiment:** 0.3877 (moderately bullish)
- **VIX:** 17 (risk-on, low fear)
- **Oil:** $95 (-16.7% crash on Iran peace deal)
- **Semis:** +9.4% sector surge (AMD +19%)
- **Theme:** Geopolitical risk-off = tech risk-on rotation

**Sentiment Scout Conclusion:**
Market is in full risk-on rotation from energy to tech/semis. Options flow confirms institutional conviction in NVDA, but retail FOMO building in QCOM/MU. Watch for reversal signals when:
1. QCOM IV spikes further above 97% (already extreme)
2. MU starts seeing unusual put activity (currently zero)
3. Energy IV crushes below 50% (oil stabilization)

**Best Plays:**
- **Momentum:** Follow NVDA calls, AAPL/GOOGL safety
- **Contrarian:** Fade QCOM/MU on next spike, wait for XOM/CVX IV crush
- **Hedge:** SPY puts if tech rally extends (institutions already hedging)
