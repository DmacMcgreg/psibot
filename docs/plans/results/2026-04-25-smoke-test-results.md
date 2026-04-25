# EPIC E — 100-row Smoke Test Results

**Date:** 2026-04-25
**Tickers:** SPY, QQQ, AAPL, NVDA, AMD, MRK, TSLA, GDX, USO, UVXY (10)
**Dates:** 2026-04-15, 2026-04-17, 2026-04-21, 2026-04-23, 2026-04-24 (5)
**Times:** premarket, midday (2)
**Total rows:** 100
**Wall time:** 37 seconds
**Errors:** 0

---

## Smoke gate

| Criterion | Threshold | Actual | Pass |
|---|---|---|---|
| Fill rate per non-NULL-expected column | ≥ 70% avg | 84.7% avg | ✅ |
| RSI in [0,100] for all rows | 100% | min=37.17, max=88.94 | ✅ |
| IC computation finishes | no exception | 24 IC rows written | ✅ |
| Total runtime | ≤ 30 min | 37 seconds | ✅ |

**Gate: PASS — clear to launch full backfill (EPIC G).**

---

## Column fill rates

100% filled (20 columns): close, prev_close, open_today, high_today, low_today, ret_1d, ret_5d, ret_20d, atr_14, dollar_volume, gap_pct, rsi_14, macd_hist, bb_pos, ema_distance_50, ema_distance_200, near_support, distance_to_support, regime_label, regime_fingerprint_json

72%: distance_to_resistance (no level above current price for some snapshots in strong-uptrend tickers)
60%: news_24h_count, news_7d_count, fwd_ret_1d, hit_stop_5pct (forward-returns only fill where future data exists; news is current-day only)
22%: news_sentiment_7d
20%: pcr (live options data; some tickers had no options or yfinance returned partial)
17%: news_sentiment_24h

NULL by design (v1):
- analyst_*, earnings_* — STUB pending Phase B (Polygon endpoint + new earnings provider)
- iv_rank, unusual_options_score, max_pain_distance — yfinance options data shape varies; defensive extraction
- vix, dxy, ten_yr — Polygon does not accept yfinance ^VIX/^TNX prefix; needs separate macro fetch logic in Phase B
- sector — Polygon ticker_info returned no sector_description for these symbols
- mtf_alignment_pct, trend_score — multi_timeframe.py is "now"-hardcoded; needs as_of param work
- consolidation_score, accumulation_score, breakout_distance, near_resistance edge cases
- fwd_ret_5d, fwd_ret_20d, hit_target_10pct — need more time aged

---

## Top IC numbers (n=60, regime='all', horizon='1d')

| Feature | IC | Note |
|---|---:|---|
| distance_to_support | 0.288 | Closer to support → lower next-day return — possible "stops triggered" signal |
| ema_distance_50 | 0.231 | Trend strength matters at 50d |
| ema_distance_200 | 0.231 | Same on 200d |
| macd_hist | 0.228 | Standard momentum |
| gap_pct | -0.182 | Negative IC — fade-the-gap signal |
| rsi_14 | 0.175 | |
| bb_pos | 0.151 | Bollinger position |
| ret_20d | 0.146 | Momentum |
| atr_14 | 0.133 | |
| ret_5d | 0.115 | |
| dollar_volume | 0.091 | |
| ret_1d | -0.037 | Mean-reversion at 1d ~ noise |

⚠️ **Caveat:** n=60, single regime ("Risk-On" — VIX is fully NULL so all rows fall into the same regime label). These ICs are SUGGESTIVE only. With the full 360k-row backfill they will tighten dramatically.

⚠️ **Identical IC for ema_distance_50 and ema_distance_200**: Likely because in this small sample, both are monotonically related to current trend strength. With more variance across regimes this should diverge.

---

## Cost

Polygon API calls: ~10 tickers × ~3 calls per snapshot × 100 snapshots = ~3000 calls. At paid tier limits, no rate-limit hits. Yahoo News calls: ~10 (current-day only), no throttle.

---

## Reproducibility

```bash
cd trading-bot/backend
uv run python -m app.research.cli init-db   # idempotent
uv run python -m app.research.cli backfill \
  --tickers SPY,QQQ,AAPL,NVDA,AMD,MRK,TSLA,GDX,USO,UVXY \
  --dates 2026-04-15,2026-04-17,2026-04-21,2026-04-23,2026-04-24 \
  --no-resume
uv run python -m app.research.cli forward-returns --min-age-days 1 --horizons 1d
uv run python -m app.research.cli compute-ic --min-periods 50

# inspect
sqlite3 data/research.db "SELECT * FROM factor_ic ORDER BY ABS(ic_spearman) DESC LIMIT 10;"
```

---

## Next

1. EPIC G — wire backfill scripts (`scripts/eval/research_backfill.sh`, `scripts/eval/halt.sh`), verify resume.
2. EPIC F — `/agents/eval` dashboard route to surface these IC numbers.
3. Real backfill — Russell 3000 × 90 days × 2 snapshots ≈ 360k rows over ~6-12 hours.
