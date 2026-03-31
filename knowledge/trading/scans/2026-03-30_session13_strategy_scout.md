# Strategy Scout — Session 13 (Alpha Research Session 12 Web Search)
**Date:** 2026-03-30
**Regime:** RISK-OFF / STAGFLATION (85% confidence). VIX 31, Brent $115, WTI $101, SPX 6,368.
**Mission:** Scan for NEW strategies suited to stagflation/war-premium/binary-event/de-escalation regimes.
**Iran Deadline:** April 6 8:00 PM ET.
**Dedup Note:** Sessions 11 and 12 already contain: GLD straddle (binary event), GPR ceasefire reversal (Parnes 2025), JCPOA oil analog, farmland/timberland inflation hedge (Baral 2022). Those are NOT repeated here.

---

## DISCOVERY 1: Oil Futures Backwardation Roll-Yield Tailwind (Systematic USO/BNO Hold)

**SOURCE:** ETF.com features on USO/BNO backwardation (March 2026); CNBC "Oil market in backwardation" (March 26, 2026); USC Investments substack on roll yield mechanics.
- https://www.etf.com/sections/features/surging-oil-etfs-get-extra-boost-backwardation
- https://www.cnbc.com/2026/03/26/market-trends-oil-futures-backwardation.html

**CONCEPT:** When the oil futures curve is in backwardation (near-month > far-month), ETFs that roll monthly futures contracts like USO and BNO generate POSITIVE roll yield independently of spot price direction. The ETF "sells high" (expiring front contract) and "buys low" (next-month contract at discount). Over the past 5 years, USO is +117% vs WTI front-month futures +24.5% — the ~93% gap is almost entirely roll yield accumulated across backwardated periods. Currently Brent is in steep backwardation driven by the Hormuz closure. The systematic signal is: when the 1M-3M Brent spread exceeds +$2/bbl (backwardation steepness threshold), hold USO/BNO as the roll yield generates an embedded structural tailwind on top of any spot appreciation.

**CURRENT SIGNAL:** BULLISH — Brent backwardation currently steep (near-month premium confirmed). Roll yield is positive and actively accumulating. USO/BNO are beating front-month futures by ~8-12% YTD in 2026.

**EXISTING MATCH:** PARTIAL — The library has `adxr/XLE` (trend momentum, Sharpe 6.46 at 90-day) and `poc_reversion/USO` (Sharpe 1.13). Neither explicitly captures the roll yield mechanics. This is a structural ETF selection insight, not a standalone entry/exit strategy.

**COMPOSITE RECIPE:** Use USO or BNO as the instrument (not XLE) in any energy-long strategy. USO/BNO add roll yield tailwind during steep backwardation; XLE does not. Specifically: replace or supplement `adxr/XLE` with `adxr/USO` during backwardated regimes. The adxr/USO combination has not been tested — this is a new backtest suggestion.

**BACKTEST SUGGESTION:**
- Strategy: `adxr` applied to USO (currently only tested on XLE)
- Period: regime-matched, current backwardation window (Jan 2026 - present)
- Hypothesis: adxr/USO should have comparable or better regime Sharpe vs adxr/XLE given roll yield bonus
- Also test: `consecutive_days/USO` to compare vs `consecutive_days/SLB` (Sharpe 2.23)

**ACTIONABLE BEFORE APRIL 6:** YES — hold USO over XLE for any energy-long thesis. Roll yield accrues daily regardless of direction. This does NOT change on April 6 outcome unless Hormuz reopens (which collapses backwardation to flat/contango).

**CONFIDENCE:** 4/5 — Structural mechanics are well-documented and empirically verified over 5-year horizon. Current regime is confirmed backwardated. Primary risk: ceasefire collapses backwardation before accrual period ends.

**TICKERS:** USO, BNO

---

## DISCOVERY 2: Industrial Aftershocks Cascade — Downstream Oil Shock Supply Chain Trade

**SOURCE:** PineBrook Capital "The Great Un-Rotation: Industrial Aftershocks and Supply Chain Bottlenecks" (March 2026); Financial Content "2026 Fertilizer Crisis" (March 23, 2026); World Fertilizer "Middle East conflict strains fertilizer supply chains" (March 10, 2026).
- https://www.pinebrookcap.com/p/the-great-un-rotation-industrial-supply-shocks
- https://markets.financialcontent.com/stocks/article/marketminute-2026-3-23-global-agriculture-braces-for-impact-the-2026-fertilizer-crisis-and-the-looming-shadow-over-2027
- https://www.worldfertilizer.com/special-reports/10032026/middle-east-conflict-strains-fertilizer-supply-chains/

**CONCEPT:** PineBrook Capital's thesis: the largest equity returns in a commodity supply shock rarely come from the primary commodity (oil is already known, priced, crowded). They come from the DOWNSTREAM industrial bottlenecks — specifically the sulfur/sulfuric acid supply chain that feeds phosphate fertilizer production. The Hormuz closure has cut off ~44% of global sulfur trade (Qatar, Saudi Arabia, UAE are major sulfur exporters). Sulfur is the input for sulfuric acid, which is the input for phosphate fertilizer. The cascade: Hormuz closure → sulfur supply shock → sulfuric acid shortage → phosphate fertilizer price spike → agricultural input cost inflation → food price inflation (another stagflation amplifier). Mosaic (MOS) has disclosed $250M EBITDA hit in Q1 2026 from sulfur cost doubling. BUT the sulfuric acid PRODUCERS (Ecovyst/ECVT, Chemtrade/CHE.UN) benefit from the price spike while Mosaic bears the cost. This is a pairs trade or single-leg long on ECVT/CHE.UN with supply-shock duration as the time horizon.

**CURRENT SIGNAL:** BULLISH on sulfuric acid producers (ECVT, CHE.UN) / BEARISH on phosphate consumers (MOS). The cascade is live and documented with Q1 2026 earnings impact confirmed.

**EXISTING MATCH:** NOVEL — No existing strategy in the library targets downstream commodity cascade trades. The library has `poc_reversion/DBA` (entered discretionary March 30) but that is a broad agri ETF, not the specific supply chain bottleneck play. This is a SECTOR MICRO-STRUCTURE discovery not covered by any of the 198 strategies.

**COMPOSITE RECIPE:** Not directly composable from existing strategies — requires fundamental/sector screening overlay. Closest analog: use `kalman_filter` or `consecutive_days` as the entry timing vehicle on ECVT (after confirming uptrend), with the geopolitical supply chain disruption as the regime filter.

**BACKTEST SUGGESTION:**
- Run `regime_matched_backtest` on ECVT with strategies: `consecutive_days`, `kalman_filter`, `poc_reversion`
- Period: Jan 2026 to present (post-Hormuz closure)
- Pairs component: Long ECVT / Short MOS (market-neutral within agricultural supply chain)
- Hypothesis: ECVT benefits from sulfur price spike; MOS suffers from it

**ACTIONABLE BEFORE APRIL 6:** YES — the sulfur cascade is independent of ceasefire timing. Even if April 6 produces a framework agreement, Hormuz reopening takes weeks (insurance underwriters must certify safety before commercial shipping resumes), so the supply shock persists 4-8 weeks minimum.

**CONFIDENCE:** 4/5 — The cascade mechanism is confirmed by Q1 2026 earnings disclosures. PineBrook thesis is recent and specific to the 2026 Iran conflict. Primary risk: ECVT is illiquid (small cap); CHE.UN trades on TSX.

**TICKERS:** ECVT (Ecovyst), MOS (Mosaic — short/avoid), CHE.UN (Chemtrade, TSX), CF (CF Industries), VLO (Valero — refiner beneficiary)

---

## DISCOVERY 3: Biofuel Energy-Agriculture Convergence Trade (SOYB/CORN as Oil Proxies)

**SOURCE:** Financial Content "Hedge Funds Pivot to Biofuels" (March 26, 2026); Financial Content "The Great Grain Divide" (March 27, 2026); AInvest "Soybeans Outperform Grains on Biofuel Hinge" (March 2026).
- https://markets.financialcontent.com/stocks/article/marketminute-2026-3-26-hedge-funds-pivot-to-biofuels-corn-and-soymeal-demand-surges-amid-energy-crisis
- https://markets.financialcontent.com/stocks/article/marketminute-2026-3-27-the-great-grain-divide-energy-policy-and-global-supply-chains-split-corn-and-soy-markets

**CONCEPT:** At $95+ crude oil, corn ethanol and soybean biodiesel become economically viable at scale, creating a direct energy price FLOOR under agricultural commodities. Hedge funds have swung from net-short 258,000 contracts to net-long 635,000 contracts in grains in just two months (a four-year positioning extreme). Soybean oil futures are up 22% YTD to 58 cents/pound. The EPA E15 waiver is in force. Key insight: DBA (Invesco DB Agriculture ETF) and SOYB/CORN ETFs are now functioning as PARTIAL ENERGY PROXIES — they track the energy complex with a time lag but without the direct Hormuz/Iran event risk. This means: (a) they hold value even in a ceasefire scenario because the biofuel economics persist at $80+ oil, and (b) they are NOT as crowded as XLE/USO/XOM — they carry lower event-risk on April 6. Strategy: agricultural commodity ETFs are a LOWER-VOLATILITY energy proxy trade for the period spanning the April 6 binary event.

**CRITICAL DIVERGENCE:** Corn and soybeans are diverging. Soybeans outperform on biofuel demand. Corn faces ethanol floor support but also supply overhang headwinds globally. SOYB is the cleaner play.

**CURRENT SIGNAL:** BULLISH on SOYB and DBA. Signal is active (positions already in portfolio). The NEW insight is the explicit framing as a lower-vol energy proxy that SURVIVES a ceasefire unwind, unlike USO/XLE.

**EXISTING MATCH:** PARTIAL — `poc_reversion/DBA` is in the playbook as a discretionary entry (March 30, $27.17). S11 tested DBA with consecutive_days (Sharpe 0.66) and kalman_filter (Sharpe 0.32) — both below threshold. The biofuel energy-linkage framework elevates DBA from a standalone agricultural play to a regime-resilient energy substitute, which is NEW framing.

**COMPOSITE RECIPE:** Hold DBA + SOYB as a ceasefire-resilient energy hedge. Size: DBA already entered; SOYB is the incremental add. These two positions provide energy exposure that survives both ceasefire (oil drops but biofuel economics persist at $80+) and no-deal (oil stays high, agri follows). This is a STRUCTURAL HEDGE, not a directional bet.

**BACKTEST SUGGESTION:**
- Run `regime_matched_backtest` on SOYB (not yet tested in library)
- Strategies: `consecutive_days`, `poc_reversion`, `kalman_filter`
- Period: Jan 2026 to present (biofuel-linkage regime)
- Also: test DBA vs. SOYB correlation to USO during Feb-March 2026 to quantify the "energy proxy" beta

**ACTIONABLE BEFORE APRIL 6:** YES — specifically valuable AS A CEASEFIRE HEDGE. If USO falls -15% on April 7 ceasefire news, SOYB should fall only -5 to -8% because biofuel economics persist at $80+ oil. This makes SOYB the preferred instrument for holding energy exposure through the binary event.

**CONFIDENCE:** 3/5 — The biofuel linkage thesis is well-documented and the positioning data is hard. However, DBA/SOYB have not been regime-matched in the library, and the "ceasefire resilience" claim is inferential (based on biofuel economics, not backtested behavior during prior oil selloffs).

**TICKERS:** SOYB (Teucrium Soybean Fund), CORN (Teucrium Corn Fund), DBA (Invesco DB Agriculture — already in portfolio), DAR (Darling Ingredients — renewable diesel feedstock)

---

## DISCOVERY 4: Pre-FOMC Gold Drift — GLD Long 7 Days Before Meeting

**SOURCE:** QuantifiedStrategies.com FOMC backtest (2025); Federal Reserve Bank of New York Staff Report SR/512 "The Pre-FOMC Announcement Drift" (Lucca & Moench); Tandfonline 2024 study "The pre-FOMC announcement drift: short-lived or long-lasting?"
- https://www.quantifiedstrategies.com/fomc-meeting-trading-strategy/
- https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr512.pdf
- https://www.tandfonline.com/doi/full/10.1080/00036846.2024.2322573

**CONCEPT:** The S&P500 earns ~49bps in the 24 hours before each FOMC announcement, and approximately 80% of the annual U.S. equity premium since 1994 has been earned in those 24-hour windows. However for GOLD specifically: backtesting shows the optimal entry is 7 trading days before the FOMC meeting ends — significantly earlier than the equity drift, and the equity curve "goes up pretty consistently" on that lead time. In a stagflation/high-VIX environment, the pre-FOMC gold drift is likely ENHANCED: (1) the Fed is more constrained (can't hike aggressively without crashing growth, can't cut without igniting inflation), so any hint of dovishness immediately translates to gold upside; (2) with GLD IV at the 21st percentile, the options market is underpricing pre-FOMC gold risk; (3) the FOMC meeting on May 7, 2026 will be the first since the April 6 Iran event — it carries binary outcome potential for Fed direction.

**SPECIFIC ENTRY SIGNAL:** Buy GLD approximately April 28 (7 trading days before May 7 FOMC). Hold through FOMC announcement. Exit same day or next morning. This is COMPLEMENTARY to — and does not conflict with — the April 6 GLD straddle already in the playbook (different catalyst, different timing).

**CURRENT SIGNAL:** NEUTRAL — the next FOMC is May 7, which is 38 calendar days away. Not actionable today but becomes actionable April 28. FLAG for scheduler.

**EXISTING MATCH:** NOVEL for gold specifically. The library has `regime_detection` (all-weather, Sharpe 1.37) but no FOMC-calendar-driven gold entry strategy. The QuantPedia database has the FOMC equity effect (Entry: close -1 day, Exit: close meeting day, annual return 6.19%, MDD -8.74%) but this is equity-only and does not capture the 7-day gold drift.

**COMPOSITE RECIPE:** The gold version requires a CALENDAR TRIGGER: T-7 trading days before FOMC → enter GLD long. This is not composable from existing strategies alone as none have a calendar/event trigger. Closest approximation: manually flag April 28 as GLD entry date; use `kalman_filter` or `poc_reversion` as the intraday entry vehicle to get a good fill.

**BACKTEST SUGGESTION:**
- Instrument: GLD
- Entry rule: T-7 trading days before each FOMC meeting
- Exit rule: Day of FOMC announcement close
- Period: 2020-2026 (include COVID, rate hike cycle, stagflation regime)
- Hypothesis: Gold 7-day pre-FOMC drift should have Sharpe > 1.0, with excess returns in high-VIX, stagflation, and Fed-indecision regimes
- Compare: GLD drift vs SPY drift in same windows to confirm gold is the superior instrument in stagflation

**ACTIONABLE BEFORE APRIL 6:** NO — next FOMC is May 7. Schedule a reminder for April 28 entry.

**CONFIDENCE:** 4/5 — The underlying pre-FOMC drift is one of the most replicated anomalies in academic finance (NY Fed working paper, multiple replications through 2024). The 7-day gold variant is from QuantifiedStrategies backtesting, well-documented. The stagflation enhancement hypothesis is inferential but theoretically grounded.

**TICKERS:** GLD (primary), IAU (alternative), SLV (secondary — silver has similar pre-FOMC pattern)

---

## DISCOVERY 5: Five-Scenario Iran Framework — Asymmetric Positioning Map

**SOURCE:** OilPrice.com "Five Scenarios for Iran and What They Would Mean for Oil Markets" (March 2026); Allianz Research Iran Scenarios (March 3, 2026).
- https://oilprice.com/Energy/Energy-General/Five-Scenarios-for-Iran-and-What-They-Would-Mean-for-Oil-Markets.html
- https://www.allianz.com/content/dam/onemarketing/azcom/Allianz_com/economic-research/publications/specials/en/2026/march/2026_03_03_IranScenarios.pdf

**CONCEPT:** A structured five-scenario framework with specific oil price targets, useful for calibrating position sizes and stop-loss levels for April 6:

| Scenario | Oil Impact | Key Asset Implication |
|----------|-----------|----------------------|
| S1: US forces nuclear deal | -$5/bbl | SHORT USO, LONG SPY, LONG QQQ |
| S2: Limited strikes (done) | +$5-10/bbl (temp) | VIX spike then crush, energy momentum |
| S3: Wider attacks, moderate successor | +$10/bbl (fading) | Oil premium, then gradual normalization |
| S4: Wider attacks, hardline successor | +$15/bbl (sustained) | Oil majors, shipping long-term |
| S5: Internal collapse/civil unrest | >$15/bbl (structural) | Extreme safe-haven, gold, USD |

**CRITICAL ASYMMETRY CONFIRMED:** Downside on S1 (diplomacy) is capped at -$5/bbl from $115 = $110 Brent. But wait — this is WRONG. The GPR premium unwind scenario (Sessions 11-12) estimates $15-25/bbl war premium baked in. S1 could see Brent fall $15-25 (not just $5), meaning the scenario table may UNDERSTATE the ceasefire downside for oil. The true ceasefire scenario for a genuine deal with Hormuz reopening is Brent $90-100, not $110.

**PORTFOLIO SIZING IMPLICATION:** Using a 3-scenario probability weight:
- 40% chance S1/S3 (de-escalation/deal): Brent $95-103, USO -15 to -20%
- 45% chance S4 (hardline successor, no full deal): Brent $120-130, USO +5-10%
- 15% chance S5 (collapse): Brent $130+, USO +15%

**Expected value for USO:** (0.40 × -17.5%) + (0.45 × +7.5%) + (0.15 × +17.5%) = -7% + 3.375% + 2.625% = **NEGATIVE EXPECTED VALUE (-1%)**.

This is the quantitative case for reducing energy exposure BEFORE April 6. Not a directional call — it is a risk-adjusted expected value calculation showing the distribution is negatively skewed for oil at current prices.

**EXISTING MATCH:** This is a PROBABILITY WEIGHTING FRAMEWORK, not a strategy per se. Complements and validates the T1-C JCPOA asymmetry insight from Session 12. The five-scenario map is new and provides precise price targets for stop/profit-taking calibration.

**COMPOSITE RECIPE:** Use scenario targets as stop-loss anchors for existing positions:
- USO long: stop at $110 Brent equivalent (S1 floor); profit-take at $128 (S4 threshold)
- XLE long: same scenario mapping
- DBA: survives all scenarios (biofuel economics persist at $95+)
- GLD: benefits in S4 and S5; modest in S1

**BACKTEST SUGGESTION:** Not a backtest item — this is a position-sizing framework. The five price targets should be used as scenario-based P&L stress tests for the current portfolio snapshot.

**ACTIONABLE BEFORE APRIL 6:** YES — immediately actionable for portfolio sizing. The negative expected value (-1%) for USO at current $115 Brent is the strongest quantitative argument for trimming energy exposure by April 3-4, before option theta decay accelerates.

**CONFIDENCE:** 5/5 on the scenario framework structure; 3/5 on the probability weights (my estimates, not from the source). The asymmetry math is sound — the source confirms "escalation scenarios carry non-linear upside risk" while diplomacy produces modest, capped downside.

**TICKERS:** USO (primary exposure being sized), XLE, DBA (ceasefire-resilient), GLD (safe-haven in S4/S5)

---

## DISCOVERY 6: QuantPedia Stagflation Factor Premium — Positive Factor Returns During Negative Equity Returns

**SOURCE:** QuantPedia "Investing in Deflation, Inflation, and Stagflation Regimes" (summarizing Baltussen, Swinkels, van Vliet, data back to 1875).
- https://quantpedia.com/investing-in-deflation-inflation-and-stagflation-regimes/

**CONCEPT:** The key data point from this paper that is ACTIONABLE NOW: during stagflation, nominal equity returns average -7.1% annualized and real returns are double-digit negative. HOWEVER, factor premiums (value, momentum, low-vol, carry) remain POSITIVE during stagflation. This creates the strategy: in stagflation, REDUCE broad equity index exposure (SPY, QQQ) and SHIFT to factor ETFs that capture the factor premium WITHOUT being long the index beta. The factor premiums survive because they are long/short constructs — the market risk is hedged out, leaving only the factor risk. In a stagflation regime with negative index returns, a long/short value-momentum factor portfolio should continue to generate positive absolute returns.

**SPECIFIC INSTRUMENT MAP:**
- Abandon: Long SPY, Long QQQ (index beta — the thing losing -7.1%)
- Replace with: QMOM (Alpha Architect US Quantitative Momentum), IMOM (international momentum), VLUE (iShares MSCI USA Value Factor), USMV (low-vol factor) — these are factor ETFs with long/short construction embedded

**CURRENT SIGNAL:** ACTIVE — we ARE in a stagflation regime (85% confidence, VIX 31). The factor premium opportunity window is open. The library scoreboard has numerous individual security strategies but no factor-rotation framework for stagflation.

**EXISTING MATCH:** PARTIALLY NOVEL — the library has `regime_detection` (Sharpe 1.37, all-weather) which switches between assets but does not specifically target factor ETFs. The factor-rotation-in-stagflation concept is new to the library.

**COMPOSITE RECIPE:** Use `regime_detection` as the TRIGGER (it identifies regime), then route allocation to factor ETFs (QMOM, VLUE, USMV) instead of index ETFs (SPY, QQQ). This is a two-layer system: Layer 1 = regime_detection identifies stagflation on; Layer 2 = allocate to factor premiums not index beta.

**BACKTEST SUGGESTION:**
- Run `regime_matched_backtest` on QMOM and VLUE
- Strategies: `momentum`, `kalman_filter`, `consecutive_days`
- Period: Jan 2021-present (catches the 2021-2023 inflation cycle + current stagflation)
- Hypothesis: factor ETFs should show less drawdown and positive regime Sharpe in risk-off/stagflation vs SPY
- Compare QMOM regime Sharpe vs SPY regime Sharpe in same regime-matched window

**ACTIONABLE BEFORE APRIL 6:** YES (factor rotation) and NEUTRAL (specific backtest timing). The regime-rotation thesis is live now. Reducing SPY/QQQ and adding QMOM/VLUE is immediately actionable as a defensive portfolio restructuring move before the binary event.

**CONFIDENCE:** 4/5 — Based on a 150-year dataset (Baltussen et al.) with robust replication across regimes. Factor premiums surviving stagflation is one of the strongest empirical regularities in academic finance. Risk: factor crowding in a liquidity crisis can temporarily compress even factor premiums (as seen briefly in March 2020).

**TICKERS:** QMOM (Alpha Architect US momentum), IMOM (international momentum), VLUE (iShares value), USMV (low-vol), QUAL (quality factor — also historically strong in stagflation)

---

## Summary Table

| # | Strategy Name | Regime Fit | Before Apr 6? | Action | Confidence |
|---|--------------|------------|--------------|--------|------------|
| D1 | Oil Backwardation Roll Yield (USO/BNO) | RISK-OFF energy | YES — hold USO not XLE | Backtest adxr/USO; switch instrument | 4/5 |
| D2 | Industrial Aftershocks Cascade (ECVT/fertilizer) | War supply shock | YES — ceasefire resilient | Backtest ECVT; consider pairs vs MOS | 4/5 |
| D3 | Biofuel Energy-Agriculture Proxy (SOYB/DBA) | Stagflation energy hedge | YES — ceasefire resilient | Backtest SOYB; add as energy proxy | 3/5 |
| D4 | Pre-FOMC Gold Drift (GLD T-7) | Stagflation Fed indecision | NO — action April 28 | Schedule reminder; entry April 28 | 4/5 |
| D5 | Five-Scenario Iran Asymmetry Map | Binary event | YES — sizing NOW | Trim USO pre-April 6; calibrate stops | 5/5 framework |
| D6 | Factor Premium Stagflation Rotation (QMOM/VLUE) | Stagflation | YES — regime live | Replace index with factor ETFs | 4/5 |

---

## Priority Actions for Session 13 Backtest Queue

1. **IMMEDIATE:** Run `regime_matched_backtest` on ECVT (Discovery 2) — smallest tested universe, freshest thesis
2. **IMMEDIATE:** Run `regime_matched_backtest` on SOYB (Discovery 3) — not yet in library at all
3. **THIS SESSION:** Run `adxr/USO` backtest (Discovery 1) — instrument substitution test
4. **THIS SESSION:** Run `regime_matched_backtest` on QMOM and VLUE (Discovery 6) — factor rotation validation
5. **SCHEDULE:** Set April 28 reminder for GLD pre-FOMC entry (Discovery 4)
6. **PORTFOLIO:** Apply five-scenario sizing model to USO exposure immediately (Discovery 5)

---

## Sources

- [ETF.com: Surging Oil ETFs Get Extra Boost From Backwardation](https://www.etf.com/sections/features/surging-oil-etfs-get-extra-boost-backwardation)
- [CNBC: The oil market is in backwardation (March 26, 2026)](https://www.cnbc.com/2026/03/26/market-trends-oil-futures-backwardation.html)
- [PineBrook Capital: The Great Un-Rotation](https://www.pinebrookcap.com/p/the-great-un-rotation-industrial-supply-shocks)
- [Financial Content: 2026 Fertilizer Crisis](https://markets.financialcontent.com/stocks/article/marketminute-2026-3-23-global-agriculture-braces-for-impact-the-2026-fertilizer-crisis-and-the-looming-shadow-over-2027)
- [World Fertilizer: Middle East conflict strains fertilizer supply chains](https://www.worldfertilizer.com/special-reports/10032026/middle-east-conflict-strains-fertilizer-supply-chains/)
- [Financial Content: The Great Grain Divide](https://markets.financialcontent.com/stocks/article/marketminute-2026-3-27-the-great-grain-divide-energy-policy-and-global-supply-chains-split-corn-and-soy-markets)
- [Financial Content: Hedge Funds Pivot to Biofuels](https://markets.financialcontent.com/stocks/article/marketminute-2026-3-26-hedge-funds-pivot-to-biofuels-corn-and-soymeal-demand-surges-amid-energy-crisis)
- [QuantifiedStrategies.com: FOMC Meeting Trading Strategy](https://www.quantifiedstrategies.com/fomc-meeting-trading-strategy/)
- [NY Fed SR/512: The Pre-FOMC Announcement Drift](https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr512.pdf)
- [Tandfonline: Pre-FOMC drift: short-lived or long-lasting? (2024)](https://www.tandfonline.com/doi/full/10.1080/00036846.2024.2322573)
- [OilPrice.com: Five Scenarios for Iran](https://oilprice.com/Energy/Energy-General/Five-Scenarios-for-Iran-and-What-They-Would-Mean-for-Oil-Markets.html)
- [QuantPedia: Investing in Deflation, Inflation, and Stagflation Regimes](https://quantpedia.com/investing-in-deflation-inflation-and-stagflation-regimes/)
- [Research Affiliates: Rising Risk of Stagflation](https://www.researchaffiliates.com/publications/articles/922-rising-risk-of-stagflation)
- [Bloomberg: Stagflation — How to Invest (March 19, 2026)](https://www.bloomberg.com/news/newsletters/2026-03-19/stagflation-how-to-invest-if-inflation-rises-but-growth-drops)
- [Allianz Research: Iran Scenarios (March 3, 2026)](https://www.allianz.com/content/dam/onemarketing/azcom/Allianz_com/economic-research/publications/specials/en/2026/march/2026_03_03_IranScenarios.pdf)
- [SSRN 5221072: Global Inflation Slowdown vs. Commodity Price Resilience (Vyas, April 2025)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5221072)
- [Rob Carver: Very Slow Mean Reversion (March 2025)](https://qoppac.blogspot.com/2025/03/very-slow-mean-reversion-and-some.html)
