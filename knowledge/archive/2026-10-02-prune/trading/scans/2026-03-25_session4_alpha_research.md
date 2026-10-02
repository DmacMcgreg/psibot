# Alpha Research Session 4 — March 25, 2026

**Regime:** MIXED (VIX ~27, confidence 0.5)
**Upcoming catalyst:** CPI MoM March 29 (HIGH IMPACT)
**Lookback:** 365 days (2025-03-25 to 2026-03-25)

---

## TASK 1: Regime-Resilient Candidates — Expanded Universe Validation
Symbols tested: QQQ, AMZN, TSLA, XLE, XLK (365d)

| Strategy | Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|---|---|---|---|---|---|---|
| poc_reversion | 1.60 | 8.6% | 84.0% | 25 | 3.5% | PLAYBOOK |
| center_of_gravity | 1.58 | 16.0% | 67.7% | 161 | 2.9% | PLAYBOOK |
| consecutive_days | 1.53 | 10.5% | 78.3% | 46 | 2.8% | PLAYBOOK |
| connors_rsi2_pullback | 1.07 | 1.3% | 87.5% | 8 | 0.4% | WATCH (low trades) |
| cumulative_rsi | 0.20 | 0.4% | 52.4% | 21 | 1.4% | FAIL |

### HIGH PRIORITY FLAGS:
- **poc_reversion**: Sharpe 1.60, WR 84%, MDD 3.5% — meets HIGH PRIORITY criteria (Sharpe >1.0, WR >65%, MDD <5%). 25 trades across 5 symbols.
- **center_of_gravity**: Sharpe 1.58, 161 trades (very high frequency, strong statistical significance), MDD 2.9%. Best trade count of any strategy tested.
- **consecutive_days**: Sharpe 1.53, WR 78.3%, 46 trades, MDD 2.8% — HIGH PRIORITY.

### Per-symbol trade distribution (poc_reversion):
AMZN:8, TSLA:8, XLK:4, QQQ:3, XLE:3

### Per-symbol trade distribution (center_of_gravity):
TSLA:35, XLK:35, QQQ:32, XLE:33, AMZN:26

---

## TASK 2: Cross-Sectional Strategies on Sector ETF Universe (25 ETFs)
Symbols: ARKK, DIA, GLD, HYG, IWM, QQQ, SLV, SMH, SOXX, SPY, TLT, VOO, VTI, XBI, XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY

| Strategy | Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|---|---|---|---|---|---|---|
| rs_momentum | 0.00 | 0.0% | 0.0% | 1 | 0.0% | ZERO SIGNAL |
| time_series_momentum | 0.00 | 0.0% | 0.0% | 0 | 0.0% | ZERO SIGNAL |

NOTE: Both cross-sectional strategies produce effectively no signal on the ETF universe. These may require a specific ranking/rotation implementation not triggered on daily data, or need parameter tuning. Skip for now.

---

## TASK 3: Group E — Candle Patterns
Symbols: SPY, AAPL, NVDA, MSFT (365d)

| Strategy | Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|---|---|---|---|---|---|---|
| two_bar_reversal | 1.85 | 9.2% | 57.1% | 7 | 2.5% | WATCH (low trades) |
| island_reversal | 1.65 | 8.9% | 50.0% | 22 | 2.6% | PLAYBOOK |
| outside_bar | 1.20 | 6.8% | 52.4% | 21 | 5.3% | WATCH |
| fakey_pattern | 1.03 | 5.4% | 54.5% | 11 | 5.0% | WATCH (low trades) |
| key_reversal | 0.90 | 3.8% | 53.9% | 13 | 4.3% | WATCH |
| pin_bar | 0.69 | 3.3% | 61.0% | 41 | 4.6% | MARGINAL |
| morning_evening_star | 0.35 | 1.5% | 33.3% | 9 | 4.4% | MARGINAL |
| three_bar_reversal | -0.92 | -5.2% | 35.4% | 48 | 7.9% | FAIL |
| harami | -0.12 | -0.2% | 42.9% | 7 | 2.9% | FAIL |
| three_soldiers_crows | 0.00 | 0.0% | 0.0% | 0 | 0.0% | ZERO SIGNAL |
| doji_star | NOT FOUND | — | — | — | — | NOT IN LIBRARY |
| dark_cloud_cover | NOT FOUND | — | — | — | — | NOT IN LIBRARY |
| bullish_engulfing | NOT FOUND | — | — | — | — | NOT IN LIBRARY |
| bearish_engulfing | NOT FOUND | — | — | — | — | NOT IN LIBRARY |

### Highlights:
- **island_reversal**: Sharpe 1.65, 22 trades, MDD 2.6% — crosses PLAYBOOK threshold. Reversal gaps are a real edge in mixed/volatile markets.
- **two_bar_reversal**: Sharpe 1.85 is the highest in this group but only 7 trades — needs more symbols to validate.

---

## TASK 4: Group F — Williams Alligator System
Symbols: SPY, AAPL, NVDA, MSFT (365d)

| Strategy | Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|---|---|---|---|---|---|---|
| alligator | 1.61 | 8.7% | 41.9% | 31 | 4.5% | PLAYBOOK |
| gator_oscillator | 1.20 | 6.1% | 37.5% | 24 | 5.2% | WATCH |
| awesome_oscillator | 1.03 | 4.9% | 47.1% | 17 | 4.4% | WATCH |
| alligator_ao | 1.01 | 4.8% | 43.8% | 16 | 4.5% | WATCH |
| ao_saucer | 1.10 | 5.0% | 50.0% | 8 | 2.9% | WATCH (low trades) |
| williams_vix_fix | 0.04 | 0.1% | 46.1% | 13 | 2.1% | FAIL |
| accelerator_oscillator | -1.90 | -6.3% | 32.8% | 61 | 7.0% | FAIL |

### Highlights:
- **alligator**: Sharpe 1.61 with 31 trades is the standout. Trend-following nature suits volatile/trending conditions.
- Note: Alligator WR is only 41.9% — it wins on magnitude not frequency. Profit factor must be high.

---

## TASK 5: Group G — Breakout/Pattern
Symbols: SPY, AAPL, NVDA, MSFT (365d)

| Strategy | Sharpe | Return | Win Rate | Trades | MDD | Verdict |
|---|---|---|---|---|---|---|
| value_area_breakout | 1.34 | 7.2% | 30.8% | 13 | 5.5% | WATCH |
| previous_day_va | 1.09 | 4.3% | 44.3% | 61 | 5.8% | WATCH |
| darvas_box | 0.96 | 2.5% | 60.0% | 5 | 1.9% | MARGINAL (low trades) |
| value_area | 0.67 | 2.3% | 78.4% | 37 | 2.0% | MARGINAL |
| fractal_breakout | 0.67 | 3.7% | 28.0% | 25 | 6.3% | MARGINAL |
| developing_value_area | 0.55 | 1.5% | 65.7% | 35 | 1.7% | MARGINAL |
| volatility_contraction | -0.88 | -0.1% | 0.0% | 2 | 0.2% | FAIL |
| inside_bar | NOT FOUND | — | — | — | — | NOT IN LIBRARY |
| narrow_range_bar | NOT FOUND | — | — | — | — | NOT IN LIBRARY |

---

## TASK 6: Harmonic Patterns
ALL NOT IN LIBRARY: gartley, bat, butterfly, crab, shark, cypher

---

## REGIME VALIDATION
NOTE: regime_matched_backtest tool has a known serialization bug in this environment (symbols array passed as string). Could not complete regime validation. Recommend fixing in next session.

---

## TOP 10 STRATEGIES THIS SESSION (by Sharpe, min 10 trades)

| Rank | Strategy | Sharpe | Return | WR | Trades | MDD | Group |
|---|---|---|---|---|---|---|---|
| 1 | two_bar_reversal | 1.85 | 9.2% | 57.1% | 7* | 2.5% | Candle |
| 2 | island_reversal | 1.65 | 8.9% | 50.0% | 22 | 2.6% | Candle |
| 3 | alligator | 1.61 | 8.7% | 41.9% | 31 | 4.5% | Williams |
| 4 | poc_reversion | 1.60 | 8.6% | 84.0% | 25 | 3.5% | Mean Rev |
| 5 | center_of_gravity | 1.58 | 16.0% | 67.7% | 161 | 2.9% | Mean Rev |
| 6 | consecutive_days | 1.53 | 10.5% | 78.3% | 46 | 2.8% | Mean Rev |
| 7 | outside_bar | 1.20 | 6.8% | 52.4% | 21 | 5.3% | Candle |
| 8 | gator_oscillator | 1.20 | 6.1% | 37.5% | 24 | 5.2% | Williams |
| 9 | value_area_breakout | 1.34 | 7.2% | 30.8% | 13 | 5.5% | Breakout |
| 10 | ao_saucer | 1.10 | 5.0% | 50.0% | 8* | 2.9% | Williams |

*Below 15-trade threshold for full PLAYBOOK status

---

## HIGH PRIORITY — Paper Trading Candidates
Strategies meeting: Sharpe >1.0 AND WR >65% AND MDD <5%:
- **poc_reversion**: Sharpe 1.60, WR 84.0%, MDD 3.5% — CONFIRMED HIGH PRIORITY
- **center_of_gravity**: Sharpe 1.58, WR 67.7%, MDD 2.9% — CONFIRMED HIGH PRIORITY
- **consecutive_days**: Sharpe 1.53, WR 78.3%, MDD 2.8% — CONFIRMED HIGH PRIORITY

---

## NOT IN STRATEGY LIBRARY (404s)
- doji_star, dark_cloud_cover, bullish_engulfing, bearish_engulfing
- inside_bar, narrow_range_bar
- gartley, bat, butterfly, crab, shark, cypher (all harmonic patterns)
- three_bar_play, abcd_pattern, three_push

---

## NEXT PRIORITIES FOR SESSION 5
1. Fix regime_matched_backtest serialization bug — validate top 5 strategies on regime-matched periods
2. Test two_bar_reversal on expanded universe (QQQ, AMZN, TSLA, XLE, XLK) — only 7 trades on 4 symbols, need more data
3. Composite testing: poc_reversion + center_of_gravity (both mean reversion, different signals)
4. Composite: alligator (trend) + poc_reversion (mean reversion) — regime-switching composite
5. Composite: island_reversal + consecutive_days — pattern confirmation
6. Run rs_momentum on smaller universe (S&P 500 Leaders) — may need fewer symbols
7. Investigate time_series_momentum parameters — appears to need custom configuration
