# Alpha Research Session 9 — Strategy Scout
## Date: 2026-03-27 | Regime: RISK-OFF / STAGFLATION (75%)

**Mission:** Deep search for stagflation-specific strategies, oil shock historical studies, geopolitical risk premium strategies, mid-vol regime strategies (VIX 20-35), energy-tech pairs, commodity-equity rotation, and I-XTSM OVX parameter updates.

---

## STRATEGY 1: I-XTSM (Improved Cross-Asset Time-Series Momentum with OVX)

**SOURCE:**
- Primary: Xu, Li, Singh, Park (2025) "Cross-Asset Time-Series Momentum Strategy: A New Perspective" — *Accounting & Finance*, Wiley. SSRN 4424602. Published January 2025.
- Foundational: Fernandez-Perez, Indriawan, Tse, Xu (2022) "Cross-Asset Time-Series Momentum: Crude Oil Volatility and Global Stock Markets" — *Journal of Banking & Finance*. SSRN 3850465.
- Related (prior version): Xu et al. (2023) SSRN 4231887 "A New Suggestion"

**CONCEPT:**
Standard time-series momentum (TSMOM) uses only past stock returns to forecast future returns. The I-XTSM uses OVX (CBOE Crude Oil Volatility Index, 30-day implied vol of USO options) as a NEGATIVE predictor: past OVX increase = negative equity signal. When stock returns are positive AND OVX is falling, go long. When stock returns are negative AND OVX is rising, go to cash or short. The 2025 Wiley paper extends this with 1–12 month lookback windows and industrial metals (GSCI-IND) as an additional cross-asset signal.

**IMPLEMENTATION DETAILS (extracted from search):**
- Lookback: 1-month lagged returns preferred (OVX predictability strongest at 1-month horizon)
- Signal construction: sign(past_stock_return) * sign(-past_OVX_change) — only go long when BOTH positive
- 2025 paper extends to 1–12 month lookbacks and adds GSCI Industrial Metals Index as second cross-asset gate
- OOS test: January 1990 – December 2023 (34-year OOS), 25 global equity portfolios
- Sharpe improvement: ~45% over standard single-asset TSMOM
- Momentum collapse avoidance: explicitly tested and confirmed
- Data: OVX via CBOE/FRED (OVXCLS series), GSCI-IND via Bloomberg/Refinitiv

**CURRENT SIGNAL STATUS (March 27, 2026):**
- 1-month stock return: NEGATIVE (S&P 4+ weeks down)
- OVX: SPIKING (Brent $108, oil vol elevated)
- Signal: FULLY NEGATIVE = CASH/SHORT on equities. Perfect regime alignment.
- GSCI Industrial Metals: Copper at $6.11/lb (elevated). Metal signal NEUTRAL to SLIGHTLY POSITIVE (infrastructure demand). Mitigates extreme short signal — suggests cash over outright short.

**ESTIMATED PERFORMANCE:**
- Published Sharpe: ~1.2–1.4 vs ~0.8 for plain TSMOM (34-year OOS)
- Momentum collapse periods avoided (2008-like drawdowns significantly reduced)

**REGIME FIT:** PERFECT. Current environment (oil vol spike + negative equity momentum) is the precise setup this strategy was designed for.

**EXISTING MATCH:** PARTIAL. `time_series_momentum` exists in strategy library. OVX gate is NOT currently implemented — this is a NOVEL COMPOSITE.

**COMPOSITE RECIPE:**
```
composite_backtest:
  base: time_series_momentum (lookback=1m, asset=SPY)
  gate: custom OVX filter
    - source: FRED OVXCLS daily series
    - rule: if OVX_1m_change > 0 → override signal to FLAT/SHORT
    - if OVX_1m_change < 0 → allow TSMOM signal through
  optional_gate2: gsci_industrial_metals_momentum (lookback=1m)
```

**BACKTEST SUGGESTION:**
- Symbol: SPY (primary), EFA, EEM (test globally)
- OVX lookback: 1 month (primary), test 3m and 12m
- Stock return lookback: 1m and 12m (test both per original paper)
- Date range: 2010–2026 (captures 2022 oil shock and current episode)
- Benchmark: plain time_series_momentum, buy-and-hold SPY
- Expected output: higher Sharpe, lower max drawdown, better 2022 and 2025-2026 performance

**CONFIDENCE: 5/5** — Published in peer-reviewed journal (Accounting & Finance), 34-year OOS, current signal perfectly aligned with live regime.
**IMPLEMENTATION COMPLEXITY:** Medium (need OVX data feed, but FRED API free)
**PRIORITY: BACKTEST NOW**

---

## STRATEGY 2: Macro 5-Factor Sector Rotation (Stagflation-Explicit)

**SOURCE:**
- Mann (May 2025) SSRN 5279491 "Macro Factor Sector Sensitivity Model"
- Supporting: MSCI "Factor Indexing Through the Decades" (50-year dataset, 2025)
- Supporting: Meketa "A Stagflation Primer" (May 2025)
- QuantPedia "Quantitative Sub-sector Rotation Strategy (QSRS)" — Putamen Capital (September 2025)

**CONCEPT:**
Each equity sector is scored on sensitivity to 5 macro factors: (1) oil price change, (2) CPI/inflation expectations, (3) 10-year yield level, (4) DXY change, (5) yield curve slope. Sectors with the highest combined factor scores in the current macro environment are overweighted; lowest scores are underweighted. Rebalance monthly or on macro regime change. The QSRS implementation claims ~2.05% alpha annually over 35.6-year backtest.

**CURRENT FACTOR SCORING (March 27, 2026):**
| Sector | Oil+ | Inflation+ | Rising Yields | Weak DXY | Flat Curve | TOTAL |
|--------|------|------------|---------------|----------|------------|-------|
| Energy | +++ | +++ | + | ++ | + | 10/10 |
| Materials | ++ | ++ | + | +++ | + | 9/10 |
| Staples | + | ++ | 0 | + | + | 5/10 |
| Defense/Industrials | + | + | 0 | + | 0 | 3/10 |
| Technology | --- | -- | -- | - | - | -8/10 |
| Financials | - | + | ++ | - | -- | -1/10 |
| Utilities | - | 0 | --- | + | + | -2/10 |

**TRADE SIGNAL:** LONG XLE+XLB+XLP, SHORT XLK+XLU

**ESTIMATED PERFORMANCE:**
- QSRS backtest: ~2.05% annual alpha over 35.6 years
- Historical stagflation periods (1973-1982): Energy +1000%+, Materials outperformed; Tech/Discretionary worst performers
- MSCI 50-year data: Value + Energy + Quality = top stagflation factors

**REGIME FIT:** STRONG. Directly designed for macro regime alignment.

**EXISTING MATCH:** PARTIAL. `regime_detection` already does sector-level signals. A pure 5-factor macro scoring model is NOVEL.

**COMPOSITE RECIPE:**
```
composite_backtest:
  strategy1: rs_momentum (sector ETFs: XLE, XLB, XLP, XLV, XLK, XLU, XLF, XLI)
  macro_overlay: score each sector on oil/CPI/yield/DXY/curve sensitivity monthly
  weight: top 3 sectors equally weighted, short bottom 2 (if regime confirmed)
  rebalance: monthly or on regime flag change
```

**BACKTEST SUGGESTION:**
- Instruments: XLE, XLB, XLP, XLV, XLK, XLU, XLF, XLI, XLY
- Lookback for macro sensitivity: 12-month rolling betas to each factor
- Rebalance: Monthly
- Date range: 2000–2026 (includes 2008, 2022, current episode)
- Regime filter: only activate full short leg when VIX > 20

**CONFIDENCE: 4/5** — Well-supported by 50+ years of factor data, directly actionable, signal perfectly aligned.
**IMPLEMENTATION COMPLEXITY:** Medium
**PRIORITY: BACKTEST NOW**

---

## STRATEGY 3: Geopolitical Risk Premium — GPR-Gated Defense/Energy Rotation

**SOURCE:**
- Sheng, Sun, Wang (May 2025) SSRN 5207012 "Geopolitical Risk Index as Equity Return Predictor"
- Caldara & Iacoviello (2022) "Geopolitical Risk Index" — Fed Board, updated monthly. Free data: matteoiacoviello.com/gpr.htm
- PLOS One (September 2025) "Geopolitical Risk Contagion Across Strategic Sectors: Defense, Cybersecurity, Energy, Raw Materials" — 90 companies, 2014–2025
- Behavioural Investment (January 2026) "Does Increasing Geopolitical Risk Lead to Higher Equity Market Returns?"
- TanDfonline (2025) "Market Dynamics of Military Conflict: Financial Returns in Global Arms Industry"

**CONCEPT:**
The Caldara-Iacoviello GPR Index (text-based, counting war/conflict news in major newspapers) is a POSITIVE predictor of future equity returns in defense, energy, and materials — the market builds in a geopolitical risk premium that subsequently gets earned. When GPR > 12-month moving average, overweight ITA (defense ETF), XAR (aerospace), XLE (energy), and CRIT (critical materials). When GPR falls below MA, rotate to SPY. The PLOS One paper adds cybersecurity (BUG ETF) as a defensive asset during GPR crises. Arms companies averaged +10 percentage points CAR after the Russian invasion of Ukraine.

**CURRENT SIGNAL:**
- GPR Index: ELEVATED (US-Iran conflict, multiple active war fronts)
- Signal: ACTIVE — overweight defense/energy/cyber cluster
- Caveat from search: "After Hamas attack, CAR was indistinguishable from zero" — GPR signal works on escalation, not prolonged conflict. MONITOR for new escalation events (April 6 expiry).

**ESTIMATED PERFORMANCE:**
- Defense basket: +10% CAR on major war escalation events (event study)
- GPR-gated strategy: Sharpe not published in abstracts, but positive predictive power documented OOS
- PLOS One confirms: defense and cybersecurity are defensive assets (LOW vol sensitivity during GPR crises)

**REGIME FIT:** STRONG. Current GPR is very elevated. Defense technically bearish but institutionally accumulated (LMT PCR 0.41). April 6 binary event = potential re-escalation catalyst.

**EXISTING MATCH:** PARTIAL. `regime_detection` has general macro awareness. GPR as a quantified, external-index signal gate is NOVEL.

**COMPOSITE RECIPE:**
```
composite_backtest:
  trigger: GPR_index > GPR_12m_MA → activate rotation
  portfolio: 40% ITA + 30% XAR + 20% XLE + 10% BUG
  exit: GPR_index falls 15% from peak OR VIX > 35 (full crisis = correlations break)
  benchmark: SPY
```

**BACKTEST SUGGESTION:**
- Trigger events to test: Ukraine invasion (Feb 2022), Hamas Oct 2023, US-Iran 2026
- GPR data: monthly from matteoiacoviello.com (free, updated)
- Rebalance: Monthly or on GPR threshold crossing
- Note: At VIX > 35, all correlations converge — GPS strategy likely less effective

**CONFIDENCE: 4/5** — Multiple academic confirmations, free data source, directly maps to current regime.
**IMPLEMENTATION COMPLEXITY:** Easy to Medium (GPR data is free and public)
**PRIORITY: BACKTEST NOW**

---

## STRATEGY 4: VIX Term Structure Equity Timing (Backwardation Signal)

**SOURCE:**
- Cboe research: "Inside Volatility Trading: Is VIX Backwardation Necessarily a Sign of a Future Down Market?" (2024)
- PM Research (2024) "U.S. Stock Returns and VIX Futures Curve"
- PMC/PLOS One (2024) "VIX Constant Maturity Futures Trading Strategy: A Walk-Forward Machine Learning Study"
- Macrosynergy (2025) "VIX Term Structure as a Trading Signal"
- QuantPedia "Exploiting Term Structure of VIX Futures"
- Medium/Nayab Bhutta (January 2026) "The VIX Code Cracked: Build a Python Detector That Spots Volatility Regimes"
- ArXiv 2410.14841 (October 2024) "Dynamic Factor Allocation Leveraging Regime-Switching Signals"

**CONCEPT:**
VIX term structure (M1 vs M2 VIX futures) acts as a regime gate for equity exposure. When VIX futures are in CONTANGO (M1 < M2 = normal, low fear), hold equities long and potentially short volatility. When in BACKWARDATION (M1 > M2 = current state), reduce equity exposure and avoid shorting vol. The 2024 PMC machine learning paper achieves information ratios > 0.02 (avg 0.037) using term structure features to predict VIX CMF returns. The equity application: backwardation predicts POSITIVE future equity returns (mean reversion dynamic) but with HIGH current stress.

**CURRENT SIGNAL (March 27, 2026):**
- VIX term structure: IN BACKWARDATION (confirmed from REGIME.md)
- VIX spot: ~24.98-25.33
- Signal: ELEVATED STRESS. Do NOT short volatility. Equity signal is AMBIGUOUS — backwardation = current fear + potential future mean reversion bounce.
- Actionable: Use as TIMING gate only. Wait for contango restoration before adding equity long exposure.

**KEY FINDING FROM RESEARCH:**
"When VIX futures are in backwardation, subsequent S&P 500 returns are positive" — this is the CONTRARIAN use case. Backwardation = fear is already priced = forward equity returns historically POSITIVE but volatile. The strategy is: buy equity dips when VIX is in backwardation at 20-35, NOT at 35+.

**ESTIMATED PERFORMANCE:**
- ML walk-forward: Information ratio 0.037 (modest but consistent)
- Regime-switching factor allocation: Sharpe 0.16–0.40 per factor (regime signals improve over naive allocation)
- Term structure timing: Significantly better max drawdown vs buy-and-hold in 2008, 2020 episodes

**REGIME FIT:** STRONG as a FILTER/GATE. Current backwardation confirms risk-off. Also flags the forward opportunity when backwardation resolves.

**EXISTING MATCH:** PARTIAL. `volatility_regime` strategy likely exists. VIX term structure slope as a specific signal may be novel.

**COMPOSITE RECIPE:**
```
composite_backtest:
  signal: VIX_M1/VIX_M2 ratio (term structure slope)
  if ratio > 1.0 (backwardation): 
    - reduce equity long exposure by 50%
    - activate mean-reversion strategies on oversold names
    - NO new trend-following entries
  if ratio < 0.95 (contango restored):
    - full equity long exposure
    - activate momentum strategies
  threshold_zone: 0.95-1.0 = neutral/monitoring
```

**BACKTEST SUGGESTION:**
- VIX M1/M2 ratio as regime gate for SPY long position
- Test: full exposure in contango, 50% in backwardation 20-35, 0% in backwardation > 35
- Compare to buy-and-hold and plain volatility-adjusted allocation
- Date range: 2010–2026

**CONFIDENCE: 3/5** — Solid academic backing but marginal information ratio. Best used as a filter, not standalone strategy.
**IMPLEMENTATION COMPLEXITY:** Easy (VIX futures term structure widely available)
**PRIORITY: MONITOR / USE AS FILTER**

---

## STRATEGY 5: Energy-Tech Pairs Trade (Stagflation Sector Divergence)

**SOURCE:**
- FinancialContent / MarketMinute (March 11, 2026) "The Great Rotation: Why Old Economy Energy and Materials are Crushing Big Tech in 2026"
- Yahoo Finance (2026) "These 3 Sectors Are Crushing Tech in 2026"
- Tomasz Tunguz blog (2026) "The 2026 Rotation"
- Putamen Capital QSRS (September 2025) — sector rotation backtesting
- Finviz news (2026) "2026's Most Violent Market Rotation: Buy Energy, Sell Software"

**CONCEPT:**
The 2026 macro regime has created the widest energy-tech spread in years: XLE +25% YTD vs XLK -5% YTD (30-point spread as of March 11). In stagflation, energy benefits from supply shocks AND operating leverage (5% revenue growth = 16% earnings growth via 3x operating leverage), while tech suffers from rising discount rates, margin compression, and sentiment rotation. A pairs trade — LONG XLE, SHORT XLK — captures this spread as a dollar-neutral, regime-specific alpha source. Historical analog: 1970s (energy dominated), 2022 (XLE +55%, XLK -28%, 83-point spread).

**CURRENT SIGNAL (March 27, 2026):**
- XLE YTD: +25%, RSI basket avg ~78 (overbought)
- XLK YTD: -5%, breadth 35% (severe deterioration)
- Spread: ~30 points and widening
- CAUTION: XLE overbought at RSI 78-84. Pairs entry is BETTER on XLE pullback (e.g., ceasefire signal).
- April 6 binary: ceasefire = XLE -10%+, XLK relief rally → rapid spread compression. Manage carefully.

**ESTIMATED PERFORMANCE:**
- 2022 analog: Long XLE / Short XLK generated approximately +83 percentage point spread performance (XLE +55%, XLK -28%)
- 1973-1982 stagflation: Energy was single best-performing sector, tech non-existent as sector
- QSRS 35-year backtest: ~2.05% annual alpha from sector rotation — pairs approach should exceed this

**REGIME FIT:** VERY STRONG currently. This trade IS the regime. However, mean reversion risk at April 6 (ceasefire = reverse quickly).

**EXISTING MATCH:** This is a NOVEL COMPOSITE. `rs_momentum` likely handles sector rotation, but a specific pairs trade (dollar-neutral long/short) is not a standard single-strategy output.

**COMPOSITE RECIPE:**
```
composite_backtest:
  leg1: LONG XLE (weight: +50%)
  leg2: SHORT XLK (weight: -50%)
  entry_trigger: 
    - XLE/XLK ratio > 1.5x 12-month average (spread wide enough to be meaningful)
    - VIX > 20 (regime confirmation)
    - OVX elevated (oil uncertainty premium)
  exit_trigger:
    - April 6 binary event (mandatory reduce to 25% before event)
    - VIX drops below 18 (regime normalized)
    - XLE/XLK ratio mean-reverts to 12m average
  stop: 5% drawdown on the pair
```

**BACKTEST SUGGESTION:**
- Instruments: XLE vs XLK (ETF pair)
- Signal: relative RS momentum (XLE 12m return minus XLK 12m return) + VIX > 20 gate
- Dollar neutral: 50/50 long/short
- 2022 episode benchmark comparison essential
- Date range: 2000–2026 (captures 2008, 2015 oil crash, 2022, 2025-2026)

**CONFIDENCE: 4/5** — Live trade is working. Strong academic and historical support. Short-term timing risk around April 6.
**IMPLEMENTATION COMPLEXITY:** Easy
**PRIORITY: BACKTEST NOW (with April 6 caveat)**

---

## STRATEGY 6: Oil Supply Shock Equity Regime — Event-Conditioned Positioning

**SOURCE:**
- ScienceDirect (2024) "Betting on War? Oil Prices, Stock Returns, and Extreme Geopolitical Events" — Journal of Energy Economics
- Hamilton (2009, cited 2024) "Historical Oil Shocks" — UCSD working paper, canonical reference
- MPRA 124295 (2024) "Quantile Analysis of Oil Price Shocks"
- ECB Working Paper 2472 (2022) "Global Financial Markets and Oil Price Shocks"

**CONCEPT:**
Oil price changes only predict stock returns during EXTREME geopolitical events — specifically the 1973 Arab-Israeli war, 1986 OPEC collapse, 1990/91 Gulf War, and 2003 Iraq invasion. In non-crisis periods (2003-2022), oil-equity forecasting is statistically insignificant. The CURRENT ENVIRONMENT (active armed conflict, Strait of Hormuz effectively closed) IS one of those rare extreme events. Strategy: when oil is supply-shock driven (not demand-driven) AND involves active military conflict, apply an equity UNDERWEIGHT overlay globally, with sector carve-outs for energy and defense. The key distinction: demand-driven oil spikes are bullish (growth); supply-shock oil spikes are bearish (stagflation).

**SIGNAL DECOMPOSITION (March 27, 2026):**
- Oil shock type: SUPPLY (Hormuz closure, insurance siege, not demand surge)
- Military conflict: ACTIVE (US-Iran, 21 confirmed attacks)
- Equity forecast: NEGATIVE (supply shock + conflict = historical underperformance regime)
- Carve-outs: XLE, ITA positive (as in 1973, 1990 — energy/defense outperform even in supply shock)
- Duration signal: Supply shocks from military conflict typically last 3-18 months

**ESTIMATED PERFORMANCE:**
- In the 4 identified extreme geopolitical episodes, oil price changes explained ~22% of long-term US stock return fluctuations
- A market-timing strategy based on oil price changes alone generates INSIGNIFICANT abnormal returns (important: this rules out mechanical oil-following strategies)
- The VALUE is in the REGIME IDENTIFICATION, not oil price momentum per se

**REGIME FIT:** PERFECT. We are in one of the rare identified periods where this relationship is active.

**EXISTING MATCH:** NOVEL. No existing strategy in library identified captures the supply-shock vs. demand-shock oil distinction as a regime gate.

**COMPOSITE RECIPE:**
```
composite_backtest:
  regime_gate: 
    - oil_shock_type = SUPPLY (proxy: rising OVX + rising oil simultaneously)
    - geopolitical_conflict_active = TRUE (GPR > 2 standard deviations above mean)
  when_regime_active:
    - SPY: reduce to 30% of normal weight
    - XLE: increase to 150% of normal weight
    - ITA: increase to 120% of normal weight
    - TLT: 0% (stagflation breaks bond safe-haven)
    - GLD: monitor (anomalous weakness currently)
  regime_exit: OVX drops > 20% from peak (suggests supply shock ending)
```

**BACKTEST SUGGESTION:**
- Test on 2022 episode first (best recent analog)
- Use OVX + WTI price slope + GPR threshold to identify supply-shock regime entries
- Compare regime-gated equity allocation vs pure buy-and-hold SPY
- Date range: 1990–2026 (4 full episodes + current)

**CONFIDENCE: 3/5** — Strong academic basis, but noted that mechanical oil-following strategies do NOT generate abnormal returns. Alpha is in regime identification only.
**IMPLEMENTATION COMPLEXITY:** Medium (supply vs. demand shock decomposition is non-trivial)
**PRIORITY: MONITOR / RESEARCH FURTHER**

---

## STRATEGY 7: VIX Backwardation + Market Breadth Mean Reversion Composite

**SOURCE:**
- TradeWell (2025) "Backtesting a Trading Strategy Derived from VIX Backwardation, Market Breadth and Market Spreads"
- Hedged.in (July 2025) "Momentum vs Mean Reversion Strategies: What Works in Volatile Markets?"
- Behavioural Investment (January 2026) "Does Increasing Geopolitical Risk Lead to Higher Equity Market Returns?"
- Cboe research on VIX backwardation and equity forward returns

**CONCEPT:**
When three conditions align simultaneously — (1) VIX in backwardation (M1 > M2), (2) market breadth severely depressed (< 40% of stocks above 200-day MA), AND (3) HY spreads not yet in distress mode (< 400 bps) — subsequent 20-60 day equity returns are historically above average. The "fear is priced, not collapsing" zone. This is the setup for mean-reversion bounce entries in oversold quality names, NOT trend-following. The TradeWell backtest confirms this specific 3-factor combination outperforms the individual signals.

**CURRENT STATUS (March 27, 2026):**
- VIX backwardation: YES (confirmed)
- Nasdaq breadth < 40%: YES (35.49%)
- SPX breadth: 48.3% (approaching sub-40 threshold)
- HY spreads: 319 bps (below 400 distress threshold)
- All 3 conditions ACTIVE — composite signal is LIVE
- BUT: PCE March 28 and April 6 binary events create regime uncertainty. Signal suggests PREPARING for bounce, NOT full positioning now.

**ESTIMATED PERFORMANCE:**
- TradeWell backtest: positive Sharpe in VIX 20-35 range, significantly worse in VIX > 35 or VIX < 15
- The "sweet spot" is exactly VIX 20-35 with backwardation — current environment
- Post-PCE mean reversion entries (MSFT RSI 25, GOOGL RSI 28) align with this signal

**REGIME FIT:** STRONG for TACTICAL mean reversion entries. Does NOT contradict overall risk-off stance — it finds entry timing within the risk-off environment.

**EXISTING MATCH:** This is a NOVEL COMPOSITE. Elements exist (`volatility_regime`, `cumulative_rsi`) but 3-factor breadth-backwardation-spread composite is new.

**COMPOSITE RECIPE:**
```
composite_backtest:
  trigger: ALL 3 conditions met:
    1. VIX_M1/VIX_M2 > 1.0 (backwardation)
    2. pct_stocks_above_200d < 40% (or Nasdaq breadth equivalent)
    3. HY_spread < 400 bps
  entry: buy oversold quality names (RSI < 30, P/E < sector median, no fundamental deterioration)
  universe: MSFT, GOOGL, NVDA, AAPL (for PCE-soft scenario)
  position size: 25-50% of normal (regime uncertainty)
  exit: RSI > 55 or VIX drops below 18 (regime normalized)
  mandatory exit: IF HY spreads cross 400 bps — full collapse risk
```

**BACKTEST SUGGESTION:**
- Test 3-factor entry signal vs. single-factor (breadth only, VIX only, spread only)
- Instruments: QQQ, MSFT, GOOGL, NVDA
- Measure 20-day and 60-day forward returns from signal trigger
- Date range: 2018–2026 (multiple episodes of backwardation + breadth deterioration)

**CONFIDENCE: 3/5** — Intuitive, consistent with regime, but limited peer-reviewed academic support. TradeWell source is practitioner not academic.
**IMPLEMENTATION COMPLEXITY:** Easy
**PRIORITY: MONITOR (activate post-PCE if cool print)**

---

## SUMMARY TABLE

| # | Strategy | Confidence | Regime Fit | Priority | Complexity | Existing Match |
|---|----------|-----------|------------|----------|------------|----------------|
| 1 | I-XTSM OVX Momentum | 5/5 | PERFECT | BACKTEST NOW | Medium | Partial |
| 2 | Macro 5-Factor Sector Rotation | 4/5 | STRONG | BACKTEST NOW | Medium | Partial |
| 3 | GPR-Gated Defense/Energy | 4/5 | STRONG | BACKTEST NOW | Easy-Med | Partial |
| 4 | VIX Term Structure Gate | 3/5 | STRONG (filter) | USE AS FILTER | Easy | Partial |
| 5 | Energy-Tech Pairs Trade | 4/5 | VERY STRONG | BACKTEST NOW | Easy | Novel |
| 6 | Oil Supply Shock Regime | 3/5 | PERFECT | MONITOR | Medium | Novel |
| 7 | VIX Backwardation+Breadth MR | 3/5 | STRONG (tactical) | MONITOR/POST-PCE | Easy | Novel |

---

## KEY UPDATES VS SESSION 8

### I-XTSM Parameter Clarification (New from 2025 Wiley paper):
- 2025 publication confirms: 1-month lookback is PRIMARY (not 12-month)
- Second cross-asset signal is GSCI Industrial Metals (GSCI-IND), not bonds
- Bond index used in the "New Suggestion" paper (4231887) but superseded by metals in final publication (4424602)
- FRED OVXCLS series = correct data source for OVX
- OOS period extended to December 2023 in final publication

### Novel Findings Not in Session 8:
- 3-factor VIX backwardation + breadth + HY spread composite (Strategy 7) — novel combination from TradeWell
- Supply shock vs. demand shock decomposition for oil (Strategy 6) — important: mechanical oil momentum does NOT work, only regime identification does
- Pairs trade quantification: 30-point XLE/XLK spread as of March 11 (live data)

### Session 8 Strategies Confirmed/Updated:
- GRI Equity Return Predictor (#3 Session 8): CONFIRMED — GPR predictability well-supported across 2024-2025 literature. GPR free data source re-confirmed: matteoiacoviello.com/gpr.htm
- Defense/Cybersecurity as GPR Hedge (#5 Session 8): CONFIRMED — PLOS One and TandFonline 2025 papers align. New caveat: Hamas attack showed near-zero CAR (prolonged conflict ≠ escalation event). April 6 = potential new escalation trigger.

---

## DATA SOURCES FOR IMPLEMENTATION

| Data | Source | Cost |
|------|--------|------|
| OVX (OVXCLS) | FRED API (fred.stlouisfed.org) | Free |
| GPR Index | matteoiacoviello.com/gpr.htm | Free |
| GSCI Industrial Metals | Bloomberg/Refinitiv | Paid |
| VIX Term Structure (M1/M2) | Cboe website | Free |
| HY Credit Spreads | FRED (BAMLH0A0HYM2) | Free |
| Market Breadth | Various (Stockcharts, Finviz) | Free/Low cost |
| Sector ETF prices | Yahoo Finance/Alpaca | Free |
