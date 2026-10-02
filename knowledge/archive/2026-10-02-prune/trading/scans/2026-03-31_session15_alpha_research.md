# Alpha Research Session 15

**Date:** 2026-03-31 4:00 PM ET
**Regime:** RISK-OFF 87% (stagflation overlay)
**Iran Deadline:** April 6 8PM ET (6 days)
**VIX:** 31.07 | Brent: $111.55

---

## Portfolio Status

| Symbol | Entry | Current | P/L% | Stop | Target | Days | Action |
|--------|-------|---------|------|------|--------|------|--------|
| T | $28.79 | $28.93 | +0.49% | $27.99 | $31.67 | 1 | HOLD |
| MRK | $119.15 | $119.05 | -0.08% | $114.49 | $131.07 | 4 | HOLD |
| DBA | $27.17 | $27.13 | -0.15% | $25.49 | $29.89 | 1 | HOLD |
| WEAT | $23.26 | $23.26 | 0.00% | $22.58 | $25.59 | 0 | HOLD |

**Portfolio:** $99,970 (-0.03%) | 4 positions | 88% cash

---

## Backtest Results (S15)

### NEW DISCOVERIES

| Strategy | Symbols | Sharpe | Trades | WR | MDD | Return | Verdict |
|----------|---------|--------|--------|-----|-----|--------|---------|
| poc_reversion | ABBV+GILD | **2.55** | 16 | 87.5% | 1.55% | +6.71% | TOP TIER — Pharma MR |
| consecutive_days | GDX+JNJ | **2.38** | 19 | 89.5% | 1.84% | +6.91% | TOP TIER — Gold+Defensive |
| kalman_filter | T+MRK | **1.83** | 6 | 83.3% | 1.22% | +4.38% | VALIDATES HOLDS |
| kalman_filter | GDX+GLD | 0.77 | 3 | 66.7% | 0.83% | +1.35% | REJECT — too sparse |

### KEY FINDINGS

1. **poc_reversion/ABBV+GILD (Sharpe 2.55)** — NEW highest pharma composite
   - 87.5% win rate, 16 trades, MDD 1.55%
   - Entry condition: RSI stabilization 35-37
   - BLOCKED until April 6 resolution

2. **consecutive_days/GDX+JNJ (Sharpe 2.38)** — Novel composite
   - Gold miners + healthcare defensive pairing
   - 89.5% win rate, 19 trades
   - Entry: GDX above $91 + JNJ RSI hook

3. **kalman_filter/T+MRK (Sharpe 1.83)** — Validates current holds
   - Both positions confirmed by backtest
   - 83.3% win rate, MDD 1.22%
   - Hold thesis intact

4. **GDX/GLD kalman (Sharpe 0.77)** — REJECTED
   - Only 3 trades, too sparse
   - Wait for GDX individual test

---

## Position Analysis

### T (AT&T) — HOLD
- Confluence: 74.5 bullish, 100% alignment
- Sentiment: +0.43 bullish (5/7 positive mentions)
- Technicals: RSI 58.65, MACD bullish, SMA bullish
- PCR: 0.66 neutral, Max Pain: $29
- Thesis: Defensive income + valuation gap

### MRK (Merck) — HOLD
- Confluence: 60.5 bullish, 75% alignment
- Sentiment: Neutral (no recent news)
- Technicals: RSI 53.69, MACD bullish
- PCR: 0.24 bullish, IV 88th percentile
- Thesis: Enlicitide catalyst (3x Phase 3 wins)

### DBA (Ag Commodities) — HOLD, NO ADDS
- Confluence: 68 bullish
- RSI 69.98 approaching overbought
- Stop raised to $26
- Thesis: Stagflation + biofuel floor

### WEAT (Wheat) — HOLD
- Confluence: 52.5 neutral
- RSI 59.95, EMA bullish
- Thesis: Houthi Bab al-Mandeb premium

---

## Regime Status

**RISK-OFF 87%** — unchanged

### Critical Events (Next 10 Days)
1. **Apr 1:** EIA Petroleum (job #47)
2. **Apr 3:** CPI + Jobless Claims (stagflation risk)
3. **Apr 5:** NFP (Saturday)
4. **Apr 6, 8PM ET:** IRAN DEADLINE — MOST BINARY
5. **Apr 8:** FOMC Minutes
6. **Apr 9:** PCE Feb 2026 (MR activation gate)
7. **Apr 10:** CPI March 2026

### MR Activation Gate
- Condition: Core PCE <2.5% AND VIX <25 on April 9
- Both conditions required
- If met: Activate zscore_mr, vwap_mr, bb_mr strategies

---

## Decisions

### NO NEW ENTRIES
- April 6 binary event too close
- 6 days to resolution
- Cash preservation priority

### Position Management
- T: Hold, stop $27.99
- MRK: Hold, stop $114.49
- DBA: Hold, no adds, stop $26
- WEAT: Hold, stop $22.58

### Post-April 6 Watchlist
1. ABBV: poc_reversion entry at RSI 35-37
2. GILD: poc_reversion entry at RSI 30-32
3. GDX: consecutive_days entry above $91
4. JNJ: consecutive_days entry on RSI hook

---

## Session Stats

- Backtests run: 4
- New discoveries: 2 (poc_reversion/ABBV+GILD, consecutive_days/GDX+JNJ)
- Validated holds: 2 (T, MRK)
- Positions opened: 0
- Positions closed: 0

**Next Session:** Post-April 6 resolution (April 7 PM or April 8 AM)
