# ML Model Tracking

Performance and feature importance tracking. Auto-updated by ML Trainer.

## Current Models

| Model | Type | Status |
|-------|------|--------|
| gradient_boosting_direction_h5 | Gradient Boosting | Active |

## Signal Inventory (as of 2026-04-18)

- Total Tracked: 512
- Evaluated: 0 (signals not yet resolved — no outcome data available)
- Overall Win Rate: N/A (no evaluated signals)
- Signal Mix: 278 bearish / 217 bullish / 128 neutral

## Confidence Distribution

| Bucket | Signals | Evaluated |
|--------|---------|-----------|
| 0-10%  | 71      | 0         |
| 10-20% | 116     | 0         |
| 20-30% | 108     | 0         |
| 30-40% | 56      | 0         |
| 40-50% | 52      | 0         |
| 50-60% | 75      | 0         |
| 60-70% | 45      | 0         |
| 70-80% | 79      | 0         |
| 80-90% | 21      | 0         |
| 90-100%| 0       | 0         |

Note: Heavy concentration in low-confidence buckets (0-30%) suggests model uncertainty in current Risk-Off/Stagflation regime.

## Feature Importance Rankings

Model: gradient_boosting_direction_h5

| Rank | Feature | Importance | Notes |
|------|---------|------------|-------|
| 1 | atr_pct | 0.2191 | Volatility-driven — dominant in Risk-Off |
| 2 | macd | 0.1987 | Momentum signal |
| 3 | price_change_5d | 0.1522 | Short-term trend |
| 4 | rsi | 0.1539 | Overbought/oversold |
| 5 | volume_ratio | 0.1407 | Volume confirmation |
| 6 | bb_position | 0.1353 | Band positioning |

ATR_PCT being #1 is consistent with elevated volatility environment (tariff shocks, Iran risk, OpEx).
MACD #2 suggests momentum matters more than pure mean-reversion in current regime.

## Training History

| Date | Result | Notes |
|------|--------|-------|
| 2026-04-18 | FAILED | ml_train API 422 error — body field required but MCP tool sends no body. Backend API mismatch. |

## Accuracy Trends

| Date | Pre-Train WR | Post-Train WR | Delta | Notes |
|------|-------------|---------------|-------|-------|
| 2026-04-18 | 0% (0/512 evaluated) | N/A (training failed) | N/A | First tracking entry. No signal outcomes resolved yet. |

## Known Issues

1. **ml_train API 422**: The MCP tool `ml_train` calls the backend with no request body, but the API requires a body field. Training cannot proceed until this is fixed in the backend route or MCP tool definition.
2. **No evaluated signals**: 512 signals are tracked but none have been evaluated against outcomes. The win-rate tracking system may need signals to age past their holding period before evaluation runs.

## Observations

- Model is active and generating signals (512 total) but outcome tracking is not yet populating.
- Signal distribution skews bearish (278 bearish vs 217 bullish) — consistent with Risk-Off regime.
- ATR volatility dominance in features aligns with current market environment.
- Recommend checking if signal evaluation job is running correctly (signals need price outcomes fetched after holding period).
