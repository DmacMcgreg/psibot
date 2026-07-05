# Trading Playbook

Last updated: 2026-05-03 — Weekly Strategy Review (Week of Apr 27 - May 3)

---

## Active Strategies

### 1. Primary: Z-Score Mean Reversion ⭐
- **Entry:** Price Z-score deviates > 2 std from rolling mean (oversold signal)
- **Exit:** Z-score reverts toward 0 OR stop loss (2x ATR) OR take profit (8%)
- **Regime:** BEST for Mixed/Range-bound. Avoid in strong trend.
- **Confidence:** High — Sharpe 2.16, win rate 87.5%, PF 13.83, MDD 0.88%
- **Universe:** Core large-caps + liquid ETFs
- **STATUS:** GATED — awaiting PCE <2.5% AND VIX <25 sustained

### 2. VWAP Mean Reversion
- **Entry:** Price deviates significantly from VWAP (buy below, sell above)
- **Exit:** Price reverts to VWAP OR stop loss (2x ATR)
- **Regime:** Mixed/Range-bound markets only
- **Confidence:** High — Sharpe 2.04, win rate 70%, PF 6.19, MDD 1.87%
- **Universe:** High-volume stocks and ETFs
- **STATUS:** GATED — same conditions as Z-Score MR

### 3. Bollinger Band Mean Reversion
- **Entry:** Price touches/exceeds lower Bollinger Band (oversold fade)
- **Exit:** Price returns to middle band (20 SMA) OR stop loss
- **Regime:** Mixed/choppy markets (NOT squeeze breakouts — those fail)
- **Confidence:** High — Sharpe 1.97, win rate 84.2%, PF 6.37, MDD 1.84%
- **Note:** This is bb_mean_reversion (fade extremes), NOT bb_squeeze (ride breakouts)
- **STATUS:** GATED

### 4. Williams %R Oscillator
- **Entry:** Williams %R < -80 (oversold) — buy signal; > -20 (overbought) — sell signal
- **Exit:** Williams %R crosses -50 (neutral zone) OR stop loss
- **Regime:** Mixed/mean-reverting markets
- **Confidence:** High — Sharpe 1.96, win rate 77.3%, PF 5.69, MDD 1.42%
- **STATUS:** GATED

### 5. OBV Divergence
- **Entry:** Price makes lower low but OBV makes higher low (bullish divergence)
- **Exit:** OBV confirms price direction OR stop loss (2x ATR)
- **Regime:** Mixed markets — volume leads price reversals
- **Confidence:** High — Sharpe 1.69, win rate 76.5%, PF 8.09, MDD 1.87%
- **Note:** COMBINE with zscore_mean_reversion as confirmation signal
- **STATUS:** GATED

### 6. Kalman Filter (All-Weather) — DOWNGRADED
- **Entry:** Kalman-filtered trend signal — adaptive smoothing detects regime-adjusted momentum
- **Exit:** Signal reversal OR stop loss
- **Regime:** ALL regimes — adapts automatically to mixed/trending/volatile
- **Confidence:** LOW — Backtest Sharpe 1.58, LIVE 0W/3L (T, WEAT stopped; MRK lost to infra bug)
- **Note:** Performed poorly in acute risk-off/geopolitical selloff. Not truly "all-weather" when faced with correlated binary event drawdown. MRK was profitable (+2.80%) before portfolio integrity bug displaced it — not a strategy failure.
- **LIVE RECORD:** 0W/3L legitimate + 1 infrastructure loss (MRK displacement)
- **ACTION:** MAINTAIN at 25% weight in Risk-Off. Require confluence >75 for entries (raised from 70). No new Kalman entries until a win proves thesis.

### 7. Regime Detection (All-Weather) — BEST ACTIVE STRATEGY ⭐
- **Entry:** Strategy explicitly models regime state and avoids trend trades in mixed conditions
- **Exit:** Regime state change OR stop loss
- **Regime:** ALL regimes — most valuable in transitions
- **Confidence:** HIGH — AMT +2.23% validated the 100% MTF rule. VLO +2.95%, AMT +2.23% (wins). NEE -3.46% (entered without 100% MTF rule), GDX -8.12% (entered at wrong price/zone). DBA -0.77%, MCD -1.44%.
- **LIVE RECORD:** 2W/4L closed (33% win rate). BEST active strategy despite mixed record.
- **KEY INSIGHT:** 100% MTF alignment is the ONLY reliable filter. AMT (100% MTF = +2.23% win), GDX (entry zone violation + MTF not verified = -8.12% loss).
- **UPDATED RULE:** Entry checklist now MANDATORY:
  1. 100% MTF alignment across ALL 4 timeframes (4h, daily, weekly, monthly) — NO EXCEPTIONS
  2. Entry price MUST be within stated entry zone (not "just below" or "just above")
  3. Confluence score ≥60
  4. No binary events within 48 hours
  5. Price data verified across multiple sources (portfolio vs scan discrepancies = RED FLAG)
- **ACTION:** MAINTAIN at 55% in Risk-Off. The strategy WORKS when rules are followed strictly. Losses were from rule violations, not strategy failure.

### 8. POC Reversion — SUSPENDED ❌
- **Entry:** Price reverts to Point of Control from VPVR
- **Exit:** POC touch OR stop loss
- **Regime:** REGIME-RESILIENT — confirmed at 96.87% regime match
- **Confidence:** ZERO — Backtest Sharpe 1.60 but LIVE 0W/2L on JNJ (best backtest symbol!)
- **Note:** JNJ has failed TWICE despite being #1 backtest symbol (Sharpe 2.43). Live performance diverges sharply from backtest. Overfitting confirmed.
- **LIVE RECORD:** 0W/2L (both JNJ)
- **ACTION:** REMAIN at 0% weight. Do NOT re-enter JNJ on POC Reversion — 0/2 is a pattern, not bad luck. Strategy suspended until non-JNJ validation trade succeeds.
- **Universe:** Healthcare (ABBV, GILD — NOT JNJ), Energy (XLE)

### 9. Consecutive Days ⭐ PROMOTED (Session 8-10 Research)
- **Entry:** Consecutive same-direction closes signal continuation
- **Exit:** Pattern break OR stop loss
- **Regime:** REGIME-RESILIENT — confirmed at 96.87% regime match (Sharpe +0.48 vs others that went negative)
- **Confidence:** Medium — Sharpe 1.53, win rate 78.3%, 46 trades, MDD 2.8%
- **Note:** USO: Sharpe 2.37, WR 81.8%, PF 21.73 — BEST energy vehicle
- **Universe:** Commodities (USO, DBA), broad
- **STATUS:** USO closed flat Apr 28 (correct pre-FOMC exit). Awaiting next validation.
- **LIVE RECORD:** 0W/1L (USO flat exit = defensive win)

### 10. ADXR ⭐ NEW (Session 8 Research)
- **Entry:** ADXR trend strength confirmation
- **Exit:** ADXR weakening OR stop loss
- **Regime:** Works across regimes. XLE regime-matched Sharpe 2.42.
- **Confidence:** High — Avg Sharpe 1.09 across 9 symbols, 89% positive
- **Universe:** Energy (XLE primary), broad

### 11. Volume Imbalance ⭐ NEW (Session 8 Research)
- **Entry:** Buy/sell volume imbalance detection
- **Exit:** Imbalance normalization OR stop loss
- **Regime:** XLE regime-matched Sharpe 2.74, 100% WR
- **Confidence:** High for energy sector. MDD 0.3%.
- **Universe:** Energy (XLE primary)

### 12. Technical Momentum (Legacy) — INACTIVE
- **Entry:** RSI < 30 + MACD bull cross + price near lower Bollinger Band
- **Exit:** RSI > 70 OR stop loss (2x ATR) OR take profit (8%)
- **Regime:** TRENDING only — 0% weight in current regime
- **Confidence:** Medium (backtest win rate ~58%)

### 13. Turtle System 1 / Triple MA Crossover — INACTIVE
- **Regime:** TRENDING/RISK-ON only. 0% in current regime.

---

## Strategy Weights by Regime

| Regime | MR Cluster (1-5) | Kalman | Regime Det | POC Rev | Consec Days | ADXR/VolImb | Trend (Turtle/MA) |
|--------|------------------|--------|------------|---------|-------------|-------------|-------------------|
| Mixed/Range | 60% | 10% | 10% | 10% | 5% | 5% | 0% |
| Trending Risk-On | 20% | 15% | 15% | 10% | 5% | 10% | 25% |
| High Volatility | 30% | 15% | 15% | 15% | 10% | 15% | 0% |
| Risk-Off/Stagflation | 0% (GATED) | 25% | 55% | 0% | 15% | 5% | 0% |

**CURRENT REGIME: Risk-On / Growth-Driven (91% confidence) — Use Risk-On row**
**NO CHANGES THIS WEEK** — Portfolio was 94%+ cash (defensive posture before FOMC/CPI cluster)

---

## Position Sizing Rules

### Tier A — Full Multi-Factor Gate (existing)

Alpha Researcher (#39) and Portfolio Manager (#30) run this lane.

- Max 15 positions, min 25% cash reserve
- STRONG_BUY signal: 5% position size
- BUY signal: 3% position size
- Mean reversion entries: tighter stop (1x ATR) due to low MDD profile
- Always check options flow before entry (unusual put buying = red flag)
- No broad ETFs (SPY, QQQ) for individual positions
- Max 4 correlated positions (same sector/theme)
- Before binary events (Iran deadline, FOMC, PCE), max 50% invested. Cash is a position.
- Kalman Filter entries require confluence >75 (RAISED from 70)
- **100% MTF alignment MANDATORY for Regime Detection entries — STRICTLY ENFORCED**
  - ALL 4 timeframes (4h, daily, weekly, monthly) must agree
  - Entry price MUST be within stated entry zone (not approximate)
  - Confluence ≥60 required
  - Verify price data across multiple sources before entry
- Do not enter positions within 48 hours of known binary events
- **NEW:** Price data verification — if portfolio price differs from scan by >5%, investigate before entry

### Tier B — Signal Cluster Auto-Entry (DISABLED - BROKEN)

**STATUS: DISABLED pending infrastructure fix**

The **Signal Trader** job is creating phantom positions in trading-bot database but NOT opening them in the actual portfolio (agent-tools). This creates reporting confusion and prevents strategy evaluation.

**Issue identified:** Apr 24, 2026 - 9 phantom positions (NVDA, GOOGL, MRVL, XLF, AMZN, META, CF, AAL, GDX) showed in trading_portfolio but returned "No open position" errors when attempting to close.

**NEW FINDING (Week of May 3):** trading_portfolio backend shows 64 phantom positions totaling $73,912 with +4.85% P/L, while real portfolio (agent-tools) has only 2 positions totaling $5,663 with 0% P/L. Discrepancy = $68,249 phantom capital.

**Action required before re-enabling:**
1. Verify Signal Trader is calling correct portfolio system (agent-tools portfolio_open_position)
2. Check Tier B limit (5 max) enforcement
3. Test with single position to validate integration
4. Clear phantom positions from trading_portfolio database
5. Update SCOREBOARD.md once Tier B is functional

**Original Tier B rules (for when re-enabled):**
- ≥2 distinct signal sources agree on direction within 24h
- Source pool: WSB / r/stocks / r/options / r/investing / r/pennystocks / r/SecurityAnalysis firehose, OpenInsider (top purchases + cluster buys), Finviz analyst upgrades/downgrades, Shadow-TipRanks (top analysts + top insiders), Shadow-C2/Zulu (top algorithmic traders), Shadow-AfterHour + Autopilot (celebrity portfolios) + Quiver Quantitative (congressional trades)
- Backend analyze_symbol technicals not strongly contradicting
- No high-impact calendar event within 48h
- Position size: 1% of portfolio (~$1000 on $100K paper)
- Stop: 1.5×ATR
- Target: open-ended, exit on signal decay (48h)
- Max 5 concurrent Tier-B positions
- P&L tracked separately in SCOREBOARD.md

---

## Current Regime (2026-05-03)

**RISK-ON / GROWTH-DRIVEN (91% confidence)** — S&P 500 and Nasdaq at ALL-TIME HIGHS, VIX sub-17 (extreme complacency)

- Regime Detection 55% weight (best active strategy, strict rules enforcement)
- Kalman 25% weight (downgraded, confluence >75 required, awaiting validation win)
- Consecutive Days 15% weight (USO flat exit validated defensive approach)
- MR GATED (PCE still >2.5%, gate release pending Apr 30 PCE data)
- POC SUSPENDED (0W/2L JNJ)

FAVOR: Big Tech (AAPL, QCOM opened May 1 — both flat after 3 days), Tower REITs (AMT proven), Growth stocks (if pullback)
AVOID: Energy equities (distribution confirmed), Ag commodities (DBA), Defensive sectors (rotation out)
WATCH: CPI May 5 8:30 AM ET (THE regime catalyst), VIX mean reversion risk (16.99 = complacency), Consumer sentiment divergence (48 vs SPY ATH)

---

## Active Setups (Week of May 4)

### IMMEDIATE (Pre-CPI Monday)
| Ticker | Strategy | Entry Zone | Stop | Target | Max Pos | Notes |
|--------|----------|------------|------|--------|---------|-------|
| AAPL | HOLD | — | $262.51 | $310.50 | 3% | Opened May 1, flat after 3 days. 100% MTF alignment. |
| QCOM | HOLD | — | $165.07 | $195.24 | 3% | Opened May 1, flat after 3 days. 100% MTF alignment. |

### POST-CPI (If CPI <0.4%, disinflationary)
| Ticker | Strategy | Entry Zone | Stop | Target | Max Pos | Notes |
|--------|----------|------------|------|--------|---------|-------|
| AMD | Regime Det | $354-360 | TBD | TBD | 5% | 100% MTF alignment, confluence 79.5. Wait for CPI confirmation. |
| GOOGL | Regime Det | $380-385 | TBD | TBD | 5% | Post-earnings pullback, strong fundamentals. |
| LLY | Regime Det | $920-930 | TBD | TBD | 5% | Healthcare strength, wait for pullback. |

### POST-CPI (If CPI >0.4%, inflationary)
| Ticker | Strategy | Entry Zone | Notes |
|--------|----------|------------|-------|
| GDX | Regime Det | $99-101 | HIGHEST CONVICTION defensive. MUST verify 100% MTF + price data. |
| UVXY | Event Ins | $8-9 | VIX spike play if >20. |

### MR ACTIVATION (If PCE data confirms <2.5%)
| Ticker | Strategy | Entry Zone | Notes |
|--------|----------|------------|-------|
| NKE | BB MR | Dip | RSI 40, PCR 0.22 bull. Best MR candidate. |
| VRTX | Z-Score MR | Dip | P/E 29, EPS +33%. Fundamental strength. |

---

## Do NOT Use (Rejected Strategies)

- **pivot_point** — Sharpe -1.90 (worst tested)
- **bb_kc_squeeze / bb_squeeze** — All squeeze variants fail in mixed regime
- **trend_following_filter** — Systematically wrong in mixed regime
- **macd_histogram** — Noise amplifier
- **hull_ma / dema / tema** — Fast MAs overfitted for trending
- **connors_rsi2** — 0% win rate
- **vwap** (as trend-follower) — Fails when used directionally
- **adaptive_ma_crossover** — Insufficient adaptation, net negative
- **end_of_month / calendar_aware / santa_claus_rally / quarter_end** — Calendar bias
- **ITA strategies (adxr, volume_imbalance)** — Regime-matched Sharpe negative (S10 finding)
- **GLD/SLV active strategies** — Passive buy-and-hold outperforms all active strategies

---

## Do NOT Trade (Ticker Blacklist)

- **JNJ via POC Reversion** — 0/2 live. Backtest overfitting confirmed. Use ABBV/GILD instead.
- **CF, NTR** — Not in regime playbook, entered by phantom Signal Trader, exited flat
- **SQQQ** — Wrong instrument for volatility (use UVXY instead per regime)

---

## Strategies Pending Evaluation (Need ml_train)

- ml_prediction, volatility_regime, combined_signal, ml_enhanced_technical

---

## ML System Status — CRITICAL ISSUE ⚠️

- **1,025 signals tracked, 0 evaluated** — Evaluation loop COMPLETELY BROKEN (up from 830 last week)
- Feature importances: atr_pct (21.9%), macd (19.9%), rsi (15.4%), price_change_5d (15.2%), volume_ratio (14.1%), bb_position (13.5%)
- **ACTION REQUIRED:** Fix evaluation loop before ML predictions can be trusted
- **IMPACT:** Cannot attribute P/L to signal sources, cannot improve signal weights, flying blind
- ML predictions carry ZERO weight until evaluation loop is fixed

**Signal Source Activity (Past Week):**
- WSB: 140 signals, 50 acted (35.7% action rate)
- reddit-stocks: 114 signals, 42 acted (36.8% action rate)
- reddit-investing: 70 signals, 29 acted (41.4% action rate)
- shadow-quiver: 51 signals, 4 acted (7.8% action rate) — LOW engagement
- reddit-options: 44 signals, 12 acted (27.3% action rate)
- reddit-pennystocks: 81 signals, 0 acted (0% action rate) — ZERO engagement

**CRITICAL:** Cannot evaluate signal source P/L due to Signal Trader creating phantom positions. All "acted" signals may be unreliable.

---

## Benchmark Comparison (180-day)

| Benchmark | Return | CAGR | Max DD |
|-----------|--------|------|--------|
| SPY | +6.36% | 13.57% | -9.13% |
| QQQ | +8.16% | 17.59% | -11.83% |
| DIA | +4.63% | 9.80% | -10.06% |
| Paper Portfolio | -0.70% | n/a | n/a |

Paper portfolio underperforming all benchmarks by 6-9%. Cash preservation (94.3%) has limited downside but missed the rally. Strategy activation (MR gate, binary event avoidance, strict entry rules) is correct for risk management but costly in opportunity terms.

**Key Issue:** Portfolio has been 90%+ cash for most of the period. The problem is NOT strategy selection but DEPLOYMENT RATE. Most opportunities are filtered out by gates and rules.

**Consideration:** When indices are in clear uptrend (SPY RSI 74, QQQ 75, IWM 73), having 10-20% passive index exposure may outperform pure active approach with 95% cash.

## monthly additions (setups) — appended 2026-05-01
- JNJ Kalman Filter / POC Reversion long in stagflation regime: entry $240-243 with stop $236-238 (recurred 2026-03-31, 2026-04-02, 2026-04-05, 2026-04-07, 2026-04-15, 2026-04-20)
- DBA stagflation hedge long with Kalman Filter + 100% MTF bullish, entry $26.80-27.30, raised trailing stop pattern (2026-03-31, 2026-04-02-0200-scan, 2026-04-05, 2026-04-07, 2026-04-15-1700)
- MRK Kalman Filter hold $119-121, target $124-126, tighten stop to 4h support (2026-03-31, 2026-04-02, 2026-04-07, 2026-04-14, 2026-04-15)
- XLE/XOM/USO energy long ahead of Iran/Hormuz binary deadlines, conditional post-deadline entry triggers (2026-03-27 session10, 2026-04-02 addendum, 2026-04-05, 2026-04-07, 2026-04-14)
- GOOGL pre-earnings accumulation: cheap IV + block call flow + fundamental BUY at $300-310 (2026-04-18, 2026-04-20, 2026-04-24, 2026-04-28, 2026-04-30)
- GDX defensive precious metals long with PCR <0.4 + 100% MTF bullish + institutional call blocks at $107 (2026-03-31, 2026-04-18, 2026-04-20, 2026-04-23)
- consecutive_days strategy on E&P cluster (XOM/COP/EOG/SLB) in stagflation, RSI<65 + PCR<1.0 trigger (2026-03-27 session10, 2026-03-30 S12-research, 2026-04-07)
- T (AT&T) defensive telecom long $28-29, tight stop $27.99, target $31.67 (2026-03-31, 2026-04-02-0200-scan, 2026-04-02-addendum, 2026-04-07)
- Defense sector long during Iran escalation (LMT/NOC/RTX/ITA), then SHORT once war premium unwinds (2026-04-02-addendum, 2026-04-14 long; 2026-04-23 short reversal)
- AMZN/AAPL/GOOGL Big Tech 100% MTF bullish + confluence >75 + PCR <0.3 cluster setup (2026-03-24, 2026-04-25, 2026-04-28, 2026-04-30)

## monthly additions (setups) — appended 2026-06-01
- GDX long $92-101 with 100% MTF bullish + bullish PCR <0.35 as stagflation/risk-off hedge (2026-04-16, 2026-04-20, 2026-04-21, 2026-04-22 both sessions, 2026-04-23, 2026-04-29)
- DBA long as ag-commodity stagflation hedge via Kalman Filter + Consecutive Days, entry ~$27, tight ATR stop (2026-03-30, 2026-04-02, 2026-04-03, 2026-04-05, 2026-04-06, 2026-04-07, 2026-05-07)
- T (AT&T) long Kalman Filter defensive at $28-29, target $31.50, tight stop ~$28 (2026-03-27, 2026-03-30, 2026-03-31, 2026-04-02, 2026-04-06, 2026-04-07)
- MRK long Kalman Filter defensive healthcare at $118-121 with pipeline/KEYTRUDA catalysts (2026-03-30, 2026-03-31, 2026-04-13, 2026-04-14, 2026-04-15, 2026-04-06)
- JNJ long POC Reversion at $240-243 with max pain $242.50 gravitational support (2026-04-02, 2026-04-03, 2026-04-05, 2026-04-06, 2026-04-07, 2026-04-13, 2026-04-15)
- UVXY/VIX-call long 15-25% allocation when VIX <19 ahead of binary FOMC/CPI/earnings cluster (2026-04-23, 2026-04-29, 2026-04-30, 2026-05-04 overnight)
- GOOGL long on pullback to value-area / post-earnings with Cloud +63% YoY thesis and cheap pre-earnings IV (2026-04-24, 2026-04-28, 2026-04-30, 2026-05-01, 2026-05-04, 2026-05-07)
- NVDA long PEG <0.75 AI-infrastructure setup with breakout >$208-218 or value-area pullback (2026-04-24, 2026-04-25, 2026-04-26, 2026-04-30 0200, 2026-05-01, 2026-05-04, 2026-05-06)
- V (Visa) long bullish base breakout $308-320 with PCR 0.08 institutional call accumulation, target $345-352 (2026-04-24, 2026-05-01 1700, 2026-05-06)
- XLE/USO/XOM Consecutive-Days+ADXR long post-Iran-deadline as oil supply-shock continuation (2026-04-02, 2026-04-03, 2026-04-05, 2026-04-06, 2026-04-07, 2026-03-30 session13)

## monthly additions (setups) — appended 2026-07-01
- **GOOGL long** (100% MTF + confluence >76 + earnings momentum): recurred across scan_2026-05-07, 2026-05-04_ACTIONABLE, 2026-05-04_2100, scan-2026-05-07-1700ET — highest-conviction mega-cap long
- **AMZN long** (breakout above $229 resistance or pullback to $225-226 support): scan_2026-05-07, 2026-05-04_ACTIONABLE, 2026-04-29_0600ET, 2026-05-04_2100
- **AAPL pullback-to-support long** ($254-258 zone, 100% MTF alignment): scan_2026-05-07, 2026-05-04_ACTIONABLE, 2026-05-04_2100, scan-2026-05-07-1700ET
- **GDX gold miners stagflation hedge** (entry $96-101, GLD at ATH support, 100% MTF bullish): 2026-04-17_0200, scan-2026-04-19-0200, 2026-04-21_0200, 2026-04-22_1700
- **DBA ag commodities stagflation hedge** (consecutive days + Kalman, CPI hedge): scan_2026-05-07, 2026-04-01-0200, 2026-04-17_0200, scan-2026-04-06-0200
- **WMT defensive staples long** (consecutive days trigger + institutional block call flow 6.6x OI): 2026-04-18-0200, scan-2026-04-19-0200, 2026-05-03_fundamental, 2026-05-03_0200
- **Energy sector longs** (XOM/CVX/SLB/HAL/EOG with regime detection + Brent tailwind): 2026-03-27_session8, 2026-03-27-0200ET, 2026-04-07-1700, 2026-04-29_fundamental
- **META short** (100% bearish Kalman/Regime alignment but reduce to 1.5% on squeeze risk when RSI <30 + bullish PCR): 2026-03-31-0200, 2026-04-01-0200, 2026-03-30-1700, 2026-03-31-1707
- **HPE long breakout** (multi-month base, 100% MTF bullish + confluence >77): 2026-04-23, 2026-05-05-1700, 2026-05-04_comprehensive, 2026-05-04_ACTIONABLE
- **MRK defensive healthcare hold** (Kalman Filter + pipeline catalysts + PCR <0.25): 2026-04-01-0200, scan-2026-04-13-0200, 2026-03-30-1700, scan-2026-04-12-0200
