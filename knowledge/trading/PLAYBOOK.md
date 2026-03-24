# Trading Playbook

Last updated: 2026-03-24 — Alpha Research Session 3

---

## Active Strategies

### 1. Primary: Z-Score Mean Reversion ⭐ NEW
- **Entry:** Price Z-score deviates > 2 std from rolling mean (oversold signal)
- **Exit:** Z-score reverts toward 0 OR stop loss (2x ATR) OR take profit (8%)
- **Regime:** BEST for Mixed/Range-bound. Avoid in strong trend.
- **Confidence:** High — Sharpe 2.16, win rate 87.5%, PF 13.83, MDD 0.88%
- **Universe:** Core large-caps + liquid ETFs

### 2. VWAP Mean Reversion ⭐ NEW
- **Entry:** Price deviates significantly from VWAP (buy below, sell above)
- **Exit:** Price reverts to VWAP OR stop loss (2x ATR)
- **Regime:** Mixed/Range-bound markets only
- **Confidence:** High — Sharpe 2.04, win rate 70%, PF 6.19, MDD 1.87%
- **Universe:** High-volume stocks and ETFs

### 3. Bollinger Band Mean Reversion ⭐ NEW
- **Entry:** Price touches/exceeds lower Bollinger Band (oversold fade)
- **Exit:** Price returns to middle band (20 SMA) OR stop loss
- **Regime:** Mixed/choppy markets (NOT squeeze breakouts — those fail)
- **Confidence:** High — Sharpe 1.97, win rate 84.2%, PF 6.37, MDD 1.84%
- **Note:** This is bb_mean_reversion (fade extremes), NOT bb_squeeze (ride breakouts)
- **Universe:** Broad — individual stocks + ETFs (38 trades in test)

### 4. Williams %R Oscillator ⭐ NEW
- **Entry:** Williams %R < -80 (oversold) — buy signal; > -20 (overbought) — sell signal
- **Exit:** Williams %R crosses -50 (neutral zone) OR stop loss
- **Regime:** Mixed/mean-reverting markets
- **Confidence:** High — Sharpe 1.96, win rate 77.3%, PF 5.69, MDD 1.42%
- **Universe:** Core large-caps

### 5. OBV Divergence ⭐ NEW
- **Entry:** Price makes lower low but OBV makes higher low (bullish divergence)
- **Exit:** OBV confirms price direction OR stop loss (2x ATR)
- **Regime:** Mixed markets — volume leads price reversals
- **Confidence:** High — Sharpe 1.69, win rate 76.5%, PF 8.09, MDD 1.87%
- **Note:** COMBINE with zscore_mean_reversion as confirmation signal

### 6. Kalman Filter ⭐ NEW (All-Weather)
- **Entry:** Kalman-filtered trend signal — adaptive smoothing detects regime-adjusted momentum
- **Exit:** Signal reversal OR stop loss
- **Regime:** ALL regimes — adapts automatically to mixed/trending/volatile
- **Confidence:** High — Sharpe 1.58, win rate 66.7%, PF 2.95, MDD 5.42%
- **Note:** Best regime-agnostic strategy found. Use as position sizing overlay.

### 7. Regime Detection ⭐ NEW (All-Weather)
- **Entry:** Strategy explicitly models regime state and avoids trend trades in mixed conditions
- **Exit:** Regime state change OR stop loss
- **Regime:** ALL regimes — most valuable in transitions (exactly current environment)
- **Confidence:** High — Sharpe 1.37, BEST return +15.57%, PF 2.68, 30 trades
- **Note:** Highest raw return of all strategies. Critical for regime-transition periods.

### 8. Technical Momentum (Legacy)
- **Entry:** RSI < 30 + MACD bull cross + price near lower Bollinger Band
- **Exit:** RSI > 70 OR stop loss (2x ATR) OR take profit (8%)
- **Regime:** Works best in trending markets — REDUCE in current mixed regime
- **Confidence:** Medium (backtest win rate ~58%)

### 9. Turtle System 1 (Trending Regime Only)
- **Entry:** Donchian channel breakout (20-day high/low)
- **Exit:** 10-day channel reversal OR 2x ATR stop
- **Regime:** TRENDING/RISK-ON only. DO NOT USE in current mixed regime.
- **Confidence:** Medium-High — Sharpe 1.14, PF 1.95 in trending conditions

### 10. Triple MA Crossover (Trending Regime Only)
- **Entry:** Short MA crosses above mid MA while both above long MA
- **Exit:** MA cross reversal
- **Regime:** TRENDING/RISK-ON only. Same restriction as Turtle System 1.
- **Confidence:** Medium — Sharpe 0.98, PF 2.68, best raw return in S1

---

## Strategy Weights by Regime

| Regime | Z-Score MR | VWAP MR | BB MR | Williams %R | OBV Div | Kalman | Regime Det | Turtle/TripleMA |
|--------|-----------|---------|-------|-------------|---------|--------|------------|-----------------|
| Mixed/Range | 25% | 20% | 20% | 15% | 10% | 5% | 5% | 0% |
| Trending Risk-On | 10% | 10% | 10% | 10% | 5% | 15% | 15% | 25% |
| High Volatility | 15% | 15% | 15% | 15% | 5% | 20% | 15% | 0% |
| Risk-Off | 0% | 0% | 0% | 0% | 0% | 50% | 50% | 0% |

**CURRENT REGIME: Mixed → Use top row weights**

---

## Position Sizing Rules

- Max 15 positions, min 25% cash reserve
- STRONG_BUY signal: 5% position size
- BUY signal: 3% position size
- Mean reversion entries: tighter stop (1x ATR) due to low MDD profile
- Always check options flow before entry (unusual put buying = red flag)
- No broad ETFs (SPY, QQQ) for individual positions — use for strategy validation only

---

## Current Regime (2026-03-24)

**MIXED / TRANSITIONAL** — Use mean reversion cluster (strategies 1–5 above)

FAVOR: Energy stocks, defensive sectors, commodity ETFs
AVOID: Long tech growth, utilities, concentrated Nasdaq exposure

---

## Do NOT Use (Rejected Strategies)

- **pivot_point** — Sharpe -1.90 (worst tested)
- **bb_kc_squeeze / bb_squeeze** — All squeeze variants fail in mixed regime
- **trend_following_filter** — Systematically wrong in mixed regime
- **macd_histogram** — Noise amplifier
- **hull_ma / dema / tema** — Fast MAs overfitted for trending
- **connors_rsi2** — 0% win rate
- **vwap** (as trend-follower) — Fails when used directionally; only works as mean-reversion
- **adaptive_ma_crossover** — Insufficient adaptation, net negative

---

## Strategies Pending Evaluation (Need ml_train)

- ml_prediction, volatility_regime, combined_signal, ml_enhanced_technical
