# Trading Playbook

Last updated: (auto-updated by Strategy Reviewer)

## Active Strategies

### Primary: Technical Momentum
- **Entry:** RSI < 30 + MACD bull cross + price near lower Bollinger Band
- **Exit:** RSI > 70 OR stop loss (2x ATR) OR take profit (8%)
- **Regime:** Works best in trending markets, avoid in choppy/range-bound
- **Confidence:** Medium (backtest win rate ~58%)

### Secondary: Mean Reversion
- **Entry:** RSI < 25 + price at/below VPOC + volume declining
- **Exit:** RSI > 50 OR price reaches upper value area
- **Regime:** Works best in range-bound markets
- **Confidence:** Medium (backtest win rate ~55%)

## Strategy Weights by Regime
| Regime | Momentum | Mean Reversion | Breakout | Notes |
|--------|----------|----------------|----------|-------|
| Risk-on trending | 60% | 20% | 20% | Favor momentum |
| Range-bound | 20% | 60% | 20% | Favor reversion |
| High volatility | 10% | 30% | 60% | Favor breakouts with tight stops |
| Risk-off | 0% | 0% | 0% | Cash / defensive only |

## Rules
- Max 15 positions, min 25% cash reserve
- No broad ETFs (SPY, QQQ) -- only individual stocks + commodity ETFs
- STRONG_BUY: 5% position size, BUY: 3% position size
- Always check options flow before entry (unusual put buying = red flag)
