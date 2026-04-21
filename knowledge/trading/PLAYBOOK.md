# Trading Playbook

Last updated: 2026-04-19 — Weekly Strategy Review (Week of Apr 13 - Apr 19)

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
- **Confidence:** LOW — Backtest Sharpe 1.58, but LIVE 0W/3L (T, WEAT stopped; MRK lost to infra bug)
- **Note:** Performed poorly in acute risk-off/geopolitical selloff. Not truly "all-weather" when faced with correlated binary event drawdown. MRK was profitable (+2.80%) before portfolio integrity bug displaced it — not a strategy failure.
- **LIVE RECORD:** 0W/3L legitimate + 1 infrastructure loss (MRK displacement)
- **ACTION:** Hold at 35% weight in Risk-Off. Require confluence >70 for entries. No new Kalman entries until a win proves thesis.

### 7. Regime Detection (All-Weather) — IMPROVING ↑
- **Entry:** Strategy explicitly models regime state and avoids trend trades in mixed conditions
- **Exit:** Regime state change OR stop loss
- **Regime:** ALL regimes — most valuable in transitions
- **Confidence:** IMPROVING — VLO +2.95%, AMT +2.23% (open). NEE -3.46% (entered without 100% MTF rule). DBA -0.77%, MCD -1.44%.
- **LIVE RECORD:** 1W/3L closed + 1 open (AMT +2.23%). BEST active strategy.
- **KEY INSIGHT:** AMT entered WITH 100% MTF alignment rule = winning. NEE entered WITHOUT it = lost. The MTF filter works.
- **ACTION:** INCREASE to 55% in Risk-Off (from 50%). 100% MTF alignment is now MANDATORY for all Regime Detection entries.

### 8. POC Reversion — DOWNGRADED ↓
- **Entry:** Price reverts to Point of Control from VPVR
- **Exit:** POC touch OR stop loss
- **Regime:** REGIME-RESILIENT — confirmed at 96.87% regime match
- **Confidence:** REDUCED — Backtest Sharpe 1.60 but LIVE 0W/2L on JNJ (best backtest symbol!)
- **Note:** JNJ has failed TWICE despite being #1 backtest symbol (Sharpe 2.43). Live performance diverges sharply from backtest. Possible overfitting or regime mismatch.
- **LIVE RECORD:** 0W/2L (both JNJ)
- **ACTION:** REDUCE to 0% weight until a non-JNJ POC trade validates the strategy. Do NOT re-enter JNJ on POC Reversion — 0/2 is a pattern, not bad luck. Try ABBV or GILD if conditions align.
- **Universe:** Healthcare (ABBV, GILD — NOT JNJ), Energy (XLE)

### 9. Consecutive Days ⭐ PROMOTED (Session 8-10 Research)
- **Entry:** Consecutive same-direction closes signal continuation
- **Exit:** Pattern break OR stop loss
- **Regime:** REGIME-RESILIENT — confirmed at 96.87% regime match (Sharpe +0.48 vs others that went negative)
- **Confidence:** High — Sharpe 1.53, win rate 78.3%, 46 trades, MDD 2.8%
- **Note:** USO: Sharpe 2.37, WR 81.8%, PF 21.73 — BEST energy vehicle
- **Universe:** Commodities (USO, DBA), broad
- **STATUS:** No live trades yet. Needs validation.

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
| Risk-Off/Stagflation | 0% (GATED) | 30% ↓ | 55% ↑ | 0% ↓ | 10% | 5% | 0% |

**CURRENT REGIME: Risk-On Surface / Stagflation Core 65% → Use Risk-Off row (stagflation floor)**
**CHANGES THIS WEEK:**
- Regime Detection 50% → 55% (AMT winning with 100% MTF rule, best active strategy)
- Kalman 35% → 30% (no improvement, holding pattern)
- POC Reversion 0% → 0% (JNJ 0/2 live, suspended until non-JNJ validation)
- Net 5% redistributed: POC → Regime Detection

---

## Position Sizing Rules

### Tier A — Full Multi-Factor Gate (existing)

Alpha Researcher (#39) and Portfolio Manager (#30) run this lane. Unchanged.

- Max 15 positions, min 25% cash reserve
- STRONG_BUY signal: 5% position size
- BUY signal: 3% position size
- Mean reversion entries: tighter stop (1x ATR) due to low MDD profile
- Always check options flow before entry (unusual put buying = red flag)
- No broad ETFs (SPY, QQQ) for individual positions
- Max 4 correlated positions (same sector/theme)
- Before binary events (Iran deadline, FOMC, PCE), max 50% invested. Cash is a position.
- Kalman Filter entries require confluence >70
- 100% MTF alignment MANDATORY for Regime Detection entries (NEE had 75% = lost, AMT had 100% = winning)
- Do not enter positions within 48 hours of known binary events (this week: CPI/Iran/HAL triple binary correctly avoided)

### Tier B — Signal Cluster Auto-Entry (NEW, fully automated)

The **Signal Trader** job (every 15m during market hours) auto-opens Tier-B positions when:

- **≥2 distinct signal sources** agree on direction within 24h (`get_signal_clusters` primitive)
- Source pool: WSB / r/stocks / r/options / r/investing / r/pennystocks / r/SecurityAnalysis firehose, OpenInsider (top purchases + cluster buys), Finviz analyst upgrades/downgrades, Shadow-TipRanks (top analysts + top insiders), Shadow-C2/Zulu (top algorithmic traders), Shadow-AfterHour + Autopilot (celebrity portfolios) + Quiver Quantitative (congressional trades)
- Backend `analyze_symbol` technicals not strongly contradicting the cluster direction
- No high-impact calendar event within 48h
- Position size: **1% of portfolio** (~$1000 on $100K paper)
- Stop: **1.5×ATR** (tighter than Tier-A 2×ATR because signal-driven, not conviction-driven)
- Target: open-ended — exit on signal decay (all originating sources drop off `get_signal_clusters` for 48h)
- **Max 5 concurrent Tier-B positions**
- Each Tier-B trade records its originating `signal_ids` via `mark_signal_acted` so Strategy Reviewer can attribute P&L per source
- P&L tracked separately in `SCOREBOARD.md` → "Tier B — Signal Cluster" section. Tier A and Tier B performance judged independently — do not combine into a single win rate

Tier-B is a parallel lane, NOT a relaxation of Tier A. The conservative multi-factor gate stays intact for size-3-5% positions.

---

## Current Regime (2026-04-19)

**RISK-ON SURFACE / STAGFLATION CORE 65%** — All indices overbought (SPY RSI 74, QQQ 75, IWM 73). VIX ~18.

- Regime Detection 55% weight (AMT open +2.23%)
- Kalman 30% weight (zero qualifying entries)
- MR GATED (PCE 3.0% binding)
- POC SUSPENDED (0/2 JNJ)

FAVOR: Tower/infrastructure REITs (AMT), Gold miners (GDX), Defensive consumer (WMT)
AVOID: Energy equities (XLE distribution, PCR 1.38), Ag commodities (DBA PCR reversed), Tech at ATH
WATCH: GDX $99-101 (highest conviction), WMT $125-127 ($3M+ institutional flow), GOOGL post-earnings Apr 29

---

## Active Setups (Week of Apr 20)

### IMMEDIATE (Pre-Iran Apr 21)
| Ticker | Strategy | Entry Zone | Stop | Target | Max Pos | Notes |
|--------|----------|------------|------|--------|---------|-------|
| GDX | Regime Det | $99-101 | $93.50 | $108 | 5% | HIGHEST CONVICTION. PCR 0.32, block $107 $683K, DXY weak. Requires 100% MTF. |
| WMT | Consec Days | $125-127 | $121 | $133 | 3% | $3M+ institutional blocks. Defensive. |

### POST-EARNINGS (After Apr 29)
| Ticker | Strategy | Entry Zone | Notes |
|--------|----------|------------|-------|
| GOOGL | Watch | $320-325 | Earnings Apr 29. Cloud Next Apr 22-24 catalyst. Wait for pullback. |

### HOLD
| Ticker | Strategy | Entry | Current | Stop | Target | Status |
|--------|----------|-------|---------|------|--------|--------|
| AMT | Regime Det | $178.38 | $182.36 | $173.38 | $196.22 | +2.23%. 100% MTF. HOLD. |

### MR ACTIVATION (If PCE <2.5% at Apr 30 release)
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

---

## Strategies Pending Evaluation (Need ml_train)

- ml_prediction, volatility_regime, combined_signal, ml_enhanced_technical

---

## ML System Status

- 512 signals tracked, 0 evaluated. Evaluation loop STILL broken.
- Feature importances: atr_pct (21.9%), macd (19.9%), rsi (15.4%), price_change_5d (15.2%), volume_ratio (14.1%), bb_position (13.5%)
- ACTION: ML predictions carry ZERO weight until evaluation loop is fixed.

---

## Benchmark Comparison (180-day)

| Benchmark | Return | CAGR | Max DD |
|-----------|--------|------|--------|
| SPY | +6.34% | 13.5% | -9.1% |
| QQQ | +7.16% | 15.4% | -12.2% |
| DIA | +6.11% | 13.0% | -10.1% |
| Paper Portfolio | -0.53% | n/a | n/a |

Paper portfolio underperforming all benchmarks by 6-8%. Cash preservation has limited downside but missed the rally. Strategy activation (MR gate, binary event avoidance) is correct for risk management but costly in opportunity terms.
