# PsiBot Alpha Research Session 8 — Strategy Scout Report

**Date:** March 27, 2026 | **Regime:** RISK-OFF / STAGFLATION (Brent $108, VIX 25, 10yr 4.41%)

---

## EXECUTIVE SUMMARY

8 strategies identified across arXiv, SSRN, QuantPedia, and academic journals. 3 are IMPLEMENT NOW. 2 are BACKTEST priority. 3 are MONITOR.

The single most important finding is the **I-XTSM Cross-Asset Momentum with OVX Signal** — a peer-reviewed strategy that uses crude oil volatility (OVX) as a regime gate for equity momentum. Its current signal is NEGATIVE, which validates and reinforces our existing risk-off posture with quantitative academic backing.

---

## STRATEGY 1: I-XTSM — OVX Cross-Asset Momentum

**SOURCE:** Xu, Li, Singh, Park (2025). *Accounting & Finance* Vol. 65, Issue 3. SSRN 4424602 + Fernandez-Perez et al. (2022). *Journal of Banking & Finance.*

**CONCEPT:** Enhances 12-month time-series equity momentum by gating entries through the CBOE Crude Oil Volatility Index (OVX). Long equity when both 12-month equity returns are positive AND OVX has been falling. Move to short/cash when equity returns are negative AND OVX is spiking. The 2025 update extends this using industrial metals (copper, aluminum) as additional cross-asset predictors. Key innovation: momentum collapse avoidance — the OVX filter exits crowded momentum before crash events.

**CURRENT SIGNAL:** NEGATIVE. OVX spiking (Brent $108, Hormuz closure). 12-month S&P returns negative in 2026. Combined signal = STAY OUT OF EQUITY LONGS. Analytically confirms current posture.

**PERFORMANCE:** ~45% Sharpe improvement over standard TSMOM. 34-year OOS (1990–2023). Peer-reviewed.

**COMPOSITE RECIPE:** time_series_momentum (12-month) + volatility_regime (OVX spike filter — exit all equity longs when OVX 1-month change exceeds +20%)

**CONFIDENCE: 5/5** | **STATUS: IMPLEMENT NOW**

---

## STRATEGY 2: GLD + IEF Joint Regime Filter for Gold

**SOURCE:** QuantPedia. "Cross-Asset Price-Based Regimes for Gold." Q4 2025.

**CONCEPT:** Only hold GLD when BOTH (a) GLD 12-month return is positive AND (b) IEF (7–10yr Treasury ETF) 12-month return is positive. This joint state identifies a "falling real rate" environment where gold thrives. In any other joint state, hold cash.

**CURRENT SIGNAL:** OFF. GLD 12-month positive (+43.87%) BUT IEF 12-month NEGATIVE (10yr yield 4.41% and rising). Joint state = NEGATIVE. Hold cash, not gold. Confirms Session 8 GLD caution.

**PERFORMANCE:** ~8–10% annualized with materially reduced max drawdown vs. buy-and-hold. 34-year OOS.

**COMPOSITE RECIPE:** kalman_filter on GLD, gated by IEF 12-month momentum binary filter (positive = allow longs, negative = cash only)

**CONFIDENCE: 4/5** | **STATUS: IMPLEMENT NOW**

---

## STRATEGY 3: Geopolitical Risk Index (GRI) as Equity Return Predictor

**SOURCE:** Sheng, Sun, Wang (May 2025). "Geopolitical Risk and Stock Returns." SSRN 5207012.

**CONCEPT:** HIGH GRI positively predicts HIGHER future equity excess returns over 3–12 months. Geopolitical risk is a priced factor. Stocks with high geopolitical exposure (defense, energy) earn higher abnormal returns. Effects intensified since 2000.

**CURRENT SIGNAL:** GRI near multi-decade highs. Bullish 3-12 month forward signal for high-geopolitical-beta sectors (energy, defense). DATA: Caldara-Iacoviello GPR index — free monthly download.

**COMPOSITE RECIPE:** When GPR > 12-month MA → overweight ITA/XAR (defense), XLE (energy). When below MA → rotate to SPY.

**CONFIDENCE: 4/5** | **STATUS: BACKTEST**

---

## STRATEGY 4: Macro 5-Factor Sector Sensitivity Rotation

**SOURCE:** Mann (May 2025). "Navigating the New Macro Landscape." SSRN 5279491.

**CONCEPT:** Compute each GICS sector's rolling 36-month sensitivity (beta) to 5 macro factors: (1) 10yr yield, (2) TIPS breakevens, (3) DXY, (4) oil price, (5) yield curve slope. Monthly: multiply factor betas by current factor momentum. Long top tercile, short bottom.

**CURRENT FACTOR ALIGNMENT:**
- Oil factor positive → LONG Energy (XLE), Materials (XLB)
- Inflation rising → LONG Staples (XLP), SHORT Tech (XLK)
- Rising yields → SHORT long-duration growth
- Provides rigorous academic justification for our current energy/defense/staples overweight

**CONFIDENCE: 4/5** | **STATUS: BACKTEST**

---

## STRATEGY 5: Defense and Cybersecurity as Geopolitical Risk Hedges

**SOURCE:** Multiple authors (Sep 2025). "Geopolitical Risk Contagion Across Strategic Sectors." PLOS One + PMC Study.

**CONCEPT:** Defense and cybersecurity sectors act as defensive assets during geopolitical crises with LOW correlation to GPR spikes. Defense stock reaction to GPR events is IMMEDIATE (81.4% of companies moved on Russia-Ukraine). Energy shows INCREASED volatility sensitivity — not a true defensive asset.

**ENTRY RULE:** On GPR spike (VIX > 25 + confirmed geopolitical event) → shift toward ITA, XAR, cybersecurity (BUG, HACK). Reduce pure energy (volatile, not defensive).

**CURRENT SIGNAL:** ACTIVE. GPR at multi-decade highs. Cybersecurity = second-order demand (infrastructure cyberattacks in war context).

**CONFIDENCE: 4/5** | **STATUS: IMPLEMENT NOW (manually)**

---

## STRATEGY 6: Pragmatic Asset Allocation (PAA)

**SOURCE:** QuantPedia (Vojtko & Javorská), February 2026.

**CONCEPT:** Multi-asset regime-switching model. 4 regimes (Bull, Correction, Bear, Recovery). In Bear regime: 10% equities, 30% bonds, 40% gold, 20% cash. February 2026 update added 3 volatility-based sub-filters.

**CURRENT STATUS:** February 2026 signal was still bullish. With Iran war March 2026, likely shifting to Correction. Implication: when GLD+IEF joint filter reactivates, PAA will reinforce 20-40% gold allocation.

**CONFIDENCE: 4/5** | **STATUS: BACKTEST**

---

## STRATEGY 7: Oil Backwardation Equity Rotation

**SOURCE:** QuantPedia. "Term Structure Effect in Commodities."

**CONCEPT:** When crude backwardation > 3%, long XLE (energy equities catch up to futures). Currently WTI in deep backwardation due to Hormuz.

**CAVEAT:** Published Sharpe 0.49 (1979–2004). Max drawdown -78%. Performs WORSE in high-vol environments (VIX 25 = current).

**CONFIDENCE: 3/5** | **STATUS: MONITOR**

---

## STRATEGY 8: US vs. EAFE Spread Momentum

**SOURCE:** QuantPedia. "Systematic Allocation in International Equity Regimes." February 2026.

**CONCEPT:** Long EAFE when SPY/EFA 12-month spread favors EAFE, vice versa. Market-neutral. OOS 55 years.

**CONFIDENCE: 4/5** | **STATUS: MONITOR** — Queue for when stagflation resolves.

---

## arXiv 2511.08571 FOLLOW-UP (gold_futures_trend)

No updates since November 2025 submission. Signal NOT ACTIVE. GLD at $400 is below 50-day MA (~$460-470). Entry condition not met. Monitor.

NEW companion paper: arXiv 2601.12706 (January 2026) — Trend-Adjusted Time Series (TATS) model for gold price direction. 58.66% directional accuracy, 16.61% MSE reduction vs LSTM. Use to time entries within gold_futures_trend once signal reactivates.

---

## PRIORITY MATRIX

| Rank | Strategy | Regime Fit | Action |
|------|----------|-----------|--------|
| 1 | I-XTSM OVX Cross-Asset Momentum | CRITICAL | IMPLEMENT NOW |
| 2 | GLD+IEF Joint Regime Filter | HIGH | IMPLEMENT NOW |
| 3 | Defense/Cybersecurity GPR Hedge | CRITICAL | IMPLEMENT NOW (manually) |
| 4 | GRI Equity Return Predictor | HIGH | BACKTEST |
| 5 | Macro 5-Factor Sector Rotation | HIGH | BACKTEST |
| 6 | PAA Multi-Asset Regime-Switch | MEDIUM-HIGH | BACKTEST |
| 7 | Oil Backwardation Equity Rotation | MEDIUM | MONITOR |
| 8 | US vs. EAFE Spread Momentum | LOW-MEDIUM | MONITOR |

---

## BACKEND BACKTEST QUEUE

1. time_series_momentum on SPY with OVX spike filter (exit when OVX 1m-change > +20%)
2. kalman_filter on GLD with IEF 12-month momentum binary gate
3. rs_momentum on ITA vs. SPY from 2014–2025
4. GRI factor backtest using Caldara-Iacoviello index data
5. PAA multi-asset regime-switch composite

---

## SOURCES
- I-XTSM: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4424602
- OVX Momentum: https://www.sciencedirect.com/science/article/abs/pii/S0378426622002849
- GLD+IEF Regimes: https://quantpedia.com/cross-asset-price-based-regimes-for-gold/
- GRI Equity Returns: https://papers.ssrn.com/sol3/Delivery.cfm/5207012.pdf?abstractid=5207012
- Macro 5-Factor: https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5279491
- GPR Defense/Cyber: https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0330557
- PAA: https://quantpedia.com/pragmatic-asset-allocation-across-market-cycles/
- TATS Gold Model: https://arxiv.org/abs/2601.12706
- Gold Futures Trend: https://arxiv.org/abs/2511.08571
