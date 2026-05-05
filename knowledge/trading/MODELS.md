# ML Model Tracking

Performance and feature importance tracking. Auto-updated by ML Trainer.

## Current Models

| Model | Type | Status |
|-------|------|--------|
| gradient_boosting_direction_h5 | Gradient Boosting | Active |

## Signal Inventory (as of 2026-05-02)

- Total Tracked: **1,034** (+220 from Apr 25)
- Evaluated: 0 (signals not yet resolved — no outcome data available)
- Overall Win Rate: N/A (no evaluated signals)
- Signal Mix: 460 bearish / 607 bullish / 273 neutral

**Growth Rate**: +27% signal volume in 7 days (814 → 1,034)
**Signal Balance**: STRONG BULLISH SHIFT — bullish signals jumped 57% (386 → 607) while bearish only grew 17% (394 → 460). This aligns with regime transition from Mixed (55%) to Risk-On (91% confidence as of May 2).

## Confidence Distribution

| Bucket | Signals | Evaluated | Change from Apr 25 |
|--------|---------|-----------|---------------------|
| 0-10%  | 157     | 0         | +37                 |
| 10-20% | 208     | 0         | +46                 |
| 20-30% | 206     | 0         | +41                 |
| 30-40% | 163     | 0         | +65 ⬆               |
| 40-50% | 116     | 0         | +27                 |
| 50-60% | 201     | 0         | +64 ⬆               |
| 60-70% | 118     | 0         | +45                 |
| 70-80% | 131     | 0         | +28                 |
| 80-90% | 40      | 0         | +7                  |
| 90-100%| 0       | 0         | 0                   |

**Note**: Strongest growth in mid-confidence buckets (30-40%: +65, 50-60%: +64). Model finding more confident setups as market transitioned to Risk-On regime post-FOMC/PCE relief rally.

## Feature Importance Rankings

Model: gradient_boosting_direction_h5 (as of 2026-05-02)

| Rank | Feature | Importance | Change | Notes |
|------|---------|------------|--------|-------|
| 1 | atr_pct | 0.2191 | — | Volatility-driven — dominant in Risk-Off |
| 2 | macd | 0.1987 | — | Momentum signal |
| 3 | rsi | 0.1539 | — | Overbought/oversold |
| 4 | price_change_5d | 0.1522 | — | Short-term trend |
| 5 | volume_ratio | 0.1407 | — | Volume confirmation |
| 6 | bb_position | 0.1353 | — | Band positioning |

**Stability**: Feature importances UNCHANGED from Apr 18 (14 days). Training has not run successfully.

ATR_PCT #1 despite Risk-On regime suggests model may be over-weighting volatility. MACD #2 aligns with current momentum-driven market (S&P/Nasdaq ATHs, VIX sub-17).

## Training History

| Date | Result | Notes |
|------|--------|-------|
| 2026-04-18 | FAILED | ml_train API 422 error — body field required but MCP tool sends no body. Backend API mismatch. |
| 2026-04-25 | FAILED | Same 422 error persists. MCP tool schema shows no params, API expects body. Blocking retraining. |
| 2026-05-02 | FAILED | 422 error still blocking. 14 days without successful training. Model is stale. |

## Accuracy Trends

| Date | Signals Tracked | Evaluated | WR | Notes |
|------|-----------------|-----------|----|----|
| 2026-04-18 | 512 | 0 | 0% | First tracking entry. No signal outcomes resolved yet. |
| 2026-04-25 | 814 | 0 | 0% | +302 signals (+59% growth). Training blocked. Evaluation loop still broken. |
| 2026-05-02 | 1,034 | 0 | 0% | +220 signals (+27% growth). Bullish surge (+57%) matches Risk-On regime shift. Training still blocked. |

## Known Issues

1. **ml_train API 422 (CRITICAL)**: The MCP tool `ml_train` calls the backend with no request body, but the API requires a body field. Training cannot proceed until this is fixed in the backend route (`/ml/train`) or MCP tool definition. **Status**: Blocking since Apr 18 (14 days).

2. **No evaluated signals (CRITICAL)**: 1,034 signals are tracked but none have been evaluated against outcomes. The win-rate tracking system may need signals to age past their holding period before evaluation runs. **Impact**: Cannot measure model accuracy or retrain with feedback loop.

3. **Signal evaluation job not running**: Check if there's a cron job or background task that should be periodically calling `evaluate_strategies` to backfill outcomes for aged signals. Without this, the ML system is generating predictions but never learning from results.

4. **Feature importance staleness**: Importances unchanged for 14 days despite regime shift from Mixed → Risk-On. Model may be misweighted for current conditions (ATR_PCT #1 in low-VIX environment).

## Observations

- Model is active and generating signals at healthy rate (1,034 total, +27% in 7 days).
- **BULLISH SURGE**: Bullish signals jumped 57% (386 → 607) vs bearish +17% (394 → 460) — model is responding to Risk-On regime (S&P 7,212 ATH, Nasdaq 24,907 ATH, VIX 16.99).
- Mid-confidence buckets (30-40%, 50-60%) saw largest gains (+65, +64) — model finding more conviction as volatility compressed and trend strengthened.
- ATR volatility still dominates features despite VIX at cycle lows (16.99) — suggests model needs retraining to adapt to new regime.
- **Recommend urgent investigation**: Fix ml_train endpoint AND verify if signal evaluation automation exists. ML system is accumulating 100+ signals/day but learning loop is broken for 14+ days.

## Next Steps

1. **Backend fix required**: Investigate `/ml/train` route in trading-bot API to determine correct request body schema. Update MCP tool or API to align.
2. **Evaluation automation**: Confirm existence of scheduled job calling `evaluate_strategies` to populate win/loss outcomes for aged signals.
3. **Feature rebalancing**: Once training unblocked, expect MACD/price_change_5d to increase in importance as Risk-On regime rewards momentum over volatility.
4. **Once training unblocked**: Run full retrain cycle and compare pre/post accuracy to establish baseline improvement rate.

## monthly additions (indicator combos) — appended 2026-05-01
- MTF alignment (4h/Daily/Weekly/Monthly) + Confluence score (0-100) + PCR + Max Pain stack as canonical entry filter (2026-04-07, 2026-04-20, 2026-04-23, 2026-04-25, 2026-04-26, 2026-04-28)
- Kalman Filter + Regime Detection composite for trend hold validation in stagflation regime (2026-04-02, 2026-04-05, 2026-04-15)
- Block trade premium ($-size) + Open Interest multiples + IV percentile + same-day flow direction as institutional sentiment composite (2026-04-18, 2026-04-20, 2026-04-23)
- VIX level + VIX term structure (M1 vs M2 backwardation) + SPX consecutive down weeks as contrarian equity timer (2026-03-30 session11)
- Macro 5-Factor sector rotation score (oil/CPI/yields/DXY/curve slope) producing -10 to +10 sector overlay (2026-03-27 session9)
- PEG + ROE + insider transaction volume + analyst PT consensus as fundamental gating filter for Big Tech (2026-04-24, 2026-04-30, 2026-05-01)
- zscore + Bollinger Band mean-reversion composite gated by Core PCE <2.5% AND VIX <25 (2026-03-31, 2026-04-14)
- Price Volatility Ratio (event-day vs normal-day move magnitude) as event-cluster sizing input (2026-04-23, 2026-04-25, 2026-04-26)
