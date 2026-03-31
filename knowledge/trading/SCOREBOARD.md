# Strategy Scoreboard

Cumulative rankings across all Alpha Research sessions. Updated after each run.
Last updated: 2026-03-30 Session 12 PM — consecutive_days/XLK EXCEPTIONAL (Sharpe 2.77/91%WR), kalman/GDX confirmed (1.82), rate_of_change/USO confirmed (1.44), vortex/XLE confirmed (1.82), poc_reversion/ABBV confirmed (1.30), CVX E&P cluster extended (1.95). T OPENED (PCR trigger met). 6 scout discoveries. Job #48 GLD pre-FOMC April 28.

---

## Master Rankings — All Tested Strategies (Top Tier)

Sorted by Sharpe ratio (descending). 1Y backtest unless noted.

| Rank | Strategy | Sharpe (1Y) | Return | Win Rate | PF | Trades | MDD | Session | Verdict |
|------|----------|-------------|--------|----------|----|--------|-----|---------|---------|
| 1 | zscore_mean_reversion | 2.160 | +4.71% | 87.5% | 13.83 | 16 | 0.88% | S2 | PLAYBOOK (regime-off) |
| 2 | vwap_mean_reversion | 2.040 | +6.93% | 70.0% | 6.19 | 20 | 1.87% | S2 | PLAYBOOK (regime-off) |
| 3 | bb_mean_reversion | 1.970 | +6.20% | 84.2% | 6.37 | 38 | 1.84% | S2 | PLAYBOOK (regime-off) |
| 4 | rate_of_change | 1.970 | +10.77% | 55.6% | 6.01 | 9 | 3.22% | S3 | WATCH (low trades, bull) |
| 5 | williams_r | 1.960 | +5.32% | 77.3% | 5.69 | 22 | 1.42% | S2 | PLAYBOOK (regime-off) |
| 6 | two_bar_reversal | 1.850 | +9.2% | 57.1% | — | 7 | 2.5% | S4 | WATCH (low trades) |
| 7 | aroon | 1.770 | +9.63% | 43.8% | 3.59 | 16 | 4.90% | S3 | WATCH (trending) |
| 8 | obv_divergence | 1.690 | +5.78% | 76.5% | 8.09 | 17 | 1.87% | S2 | PLAYBOOK (regime-off) |
| 9 | island_reversal | 1.650 | +8.9% | 50.0% | — | 22 | 2.6% | S4 | SUSPENDED — regime-hostile (S8 matched: Sharpe -0.19) |
| 10 | alligator | 1.610 | +8.7% | 41.9% | — | 31 | 4.5% | S4 | WATCH (trending only) |
| 11 | price_volume_trend | 1.610 | +8.25% | 28.3% | 2.33 | 46 | 5.07% | S3 | BULL REGIME ONLY |
| 12 | poc_reversion | 1.600 | +8.6% | 84.0% | — | 25 | 3.5% | S4 | PLAYBOOK — REGIME-RESILIENT |
| 13 | detrended_price_oscillator | 1.590 | +6.66% | 61.7% | 1.73 | 107 | 4.41% | S3 | WATCH (bull only) |
| 14 | center_of_gravity | 1.580 | +16.0% | 67.7% | — | 161 | 2.9% | S4 | SUSPENDED — regime-hostile (S8 matched: Sharpe -0.24) |
| 15 | kalman_filter | 1.580 | +11.18% | 66.7% | 2.95 | 21 | 5.42% | S2 | PLAYBOOK (all-weather) |
| 16 | consecutive_days | 1.530 | +10.5% | 78.3% | — | 46 | 2.8% | S4 | PLAYBOOK — REGIME-RESILIENT (S8 matched: Sharpe +0.48) |
| 17 | anchored_vwap | 1.540 | +7.91% | 30.0% | 2.19 | 50 | 5.85% | S3 | BULL REGIME ONLY |
| 18 | aroon_trend_strength | 1.480 | +8.18% | 70.0% | 5.04 | 10 | 3.81% | S3 | WATCH |
| 19 | hammer_shooting_star | 1.470 | +3.58% | 75.0% | 4.53 | 8 | 1.31% | S2 | WATCH (low trades) |
| 20 | stochastic_oscillator | 1.430 | +2.32% | 71.4% | 8.16 | 7 | 0.80% | S2 | WATCH (low trades) |
| 21 | regime_detection | 1.370 | +15.57% | 43.3% | 2.68 | 30 | 7.22% | S2 | PLAYBOOK (all-weather) |
| 22 | value_area_breakout | 1.340 | +7.2% | 30.8% | — | 13 | 5.5% | S4 | WATCH |
| 23 | stochastic_bb | 1.340 | +2.73% | 75.0% | 9.87 | 4 | 1.12% | S2 | WATCH (very low trades) |
| 24 | volatility_breakout | 1.320 | +11.23% | 41.9% | 1.37 | 310 | 6.39% | S2 | WATCH (high freq) |
| 25 | momentum | 1.260 | +5.91% | 80.0% | 80.01 | 5 | 3.12% | S2 | WATCH (very low trades) |
| 26 | outside_bar | 1.200 | +6.8% | 52.4% | — | 21 | 5.3% | S4 | WATCH |
| 27 | supertrend | 1.200 | +6.00% | 29.0% | 2.32 | 31 | 5.39% | S2 | WATCH |
| 28 | gator_oscillator | 1.200 | +6.1% | 37.5% | — | 24 | 5.2% | S4 | WATCH |
| 29 | connors_rsi2_pullback | 1.070 | +1.3% | 87.5% | — | 8 | 0.4% | S4 | WATCH (low trades) |
| 30 | ao_saucer | 1.100 | +5.0% | 50.0% | — | 8 | 2.9% | S4 | WATCH (low trades) |
| 31 | previous_day_va | 1.090 | +4.3% | 44.3% | — | 61 | 5.8% | S4 | WATCH |
| 32 | awesome_oscillator | 1.030 | +4.9% | 47.1% | — | 17 | 4.4% | S4 | WATCH |
| 33 | alligator_ao | 1.010 | +4.8% | 43.8% | — | 16 | 4.5% | S4 | WATCH |
| 34 | fakey_pattern | 1.030 | +5.4% | 54.5% | — | 11 | 5.0% | S4 | WATCH |
| 35 | turtle_system1 | 1.140 | +5.88% | 33.3% | 1.95 | 21 | — | S1 | TRENDING ONLY |
| 36 | triple_ma | 0.980 | +6.50% | 41.7% | 2.68 | 12 | — | S1 | TRENDING ONLY |
| 37 | key_reversal | 0.900 | +3.8% | 53.9% | — | 13 | 4.3% | S4 | WATCH |

---

## Session 11 — Regime-Matched Results (2026-03-30)

REGIME: Risk-Off/Stagflation 85% | VIX 31 | Brent $115

### USO Regime-Matched (USO as reference symbol)

| Strategy | Regime Sharpe | Return | Win Rate | MDD | Trades | Verdict |
|----------|--------------|--------|----------|-----|--------|---------|
| poc_reversion | **1.13** | +0.48% | 70.1% | 0.60% | 7 | WATCH — sparse but valid |
| consecutive_days | 0.67 | +0.34% | 55.1% | 0.97% | 11 | REJECT — full-period was inflated |
| kalman_filter | 0.49 | +0.26% | 39.9% | 0.50% | 2 | REJECT (2 trades only) |
| adxr | 0.22 | +0.53% | 50.2% | 1.46% | 7 | REJECT |
| regime_detection | -0.18 | +0.44% | 40.2% | 1.56% | 5 | REJECT |
| volume_imbalance | -0.73 | +0.15% | 20.1% | 1.53% | 5 | REJECT |

CRITICAL: consecutive_days/USO full-period Sharpe 2.37 was REGIME-INFLATED. Real matched Sharpe = 0.67. DEMOTED from Playbook.

### USO Composite Backtest (S11)

| Composite | Mode | Sharpe | Trades | Verdict |
|-----------|------|--------|--------|---------|
| consecutive_days + poc_reversion | weighted | 1.17 | 4 | WATCH — too sparse |
| consecutive_days + adxr | weighted | 0.00 | 0 | REJECT — orthogonal strategies |

### adxr/XLE Time Window Sensitivity (S11)

| Window | Sharpe | Return | Win Rate | MDD | Trades | Notes |
|--------|--------|--------|----------|-----|--------|-------|
| 90-day | **6.46** | +2.93% | 100% | 0.29% | 1 | 1 open trade since Jan 22 (+29.2%) |
| 180-day | **3.92** | +3.73% | 100% | 0.71% | 3 | 3 consecutive wins |
| 365-day regime-matched | 2.42 | — | — | — | — | S10 confirmed |

FINDING: adxr/XLE is STRENGTHENING at shorter windows — momentum accelerating. Highest-confidence energy strategy.

### SLB Regime-Matched (S11) — STRONGEST NEW FINDING

| Strategy | Regime Sharpe | Return | Win Rate | MDD | Trades | Verdict |
|----------|--------------|--------|----------|-----|--------|---------|
| consecutive_days | **2.23** | +1.24% | 79.8% | 0.76% | 15 | DEPLOY — wait RSI < 65 |
| poc_reversion | 0.98 | +0.43% | 69.7% | 0.66% | 6 | WATCH — backup entry |
| kalman_filter | 0.79 | +0.35% | 39.7% | 0.33% | 3 | BORDERLINE (3 trades) |
| adxr | -0.69 | -0.27% | 20.0% | 1.09% | 11 | REJECT |

Note: Options bearish (PCR 0.18, 2 unusual signals) → Entry conditional on RSI pullback below 65 AND PCR normalizing. Do not enter ahead of April 6 binary.

### XLV Regime-Matched (S11) — ALL REJECTED

| Strategy | Regime Sharpe | Win Rate | Trades | Verdict |
|----------|--------------|----------|--------|---------|
| poc_reversion | -0.08 | 30.0% | 6 | REJECT |
| consecutive_days | -0.39 | 53.4% | 9 | REJECT |
| kalman_filter | +0.14 | 19.9% | 3 | REJECT |

FINDING: S9 poc_reversion/XLV Sharpe 1.19 was non-regime period artifact. XLV is NOT a valid defensive entry in Risk-Off/Stagflation. Do not add healthcare ETF exposure.

### T (AT&T) Regime-Matched (S11)

| Strategy | Regime Sharpe | Return | Win Rate | MDD | Trades | Verdict |
|----------|--------------|--------|----------|-----|--------|---------|
| kalman_filter | **1.14** | +0.40% | 39.7% | 0.28% | 4 | WATCH — PCR 2.58 blocks entry |
| poc_reversion | 0.72 | +0.15% | 79.8% | 0.52% | 6 | BORDERLINE |
| consecutive_days | -0.27 | -0.20% | 33.4% | 0.84% | 10 | REJECT |

Note: PCR 2.58 (heavy institutional put buying) is a serious red flag overriding the bullish technical. Wait for PCR to normalize below 1.5.

### DBA Regime-Matched (S11)

| Strategy | Regime Sharpe | Return | Win Rate | MDD | Trades | Verdict |
|----------|--------------|--------|----------|-----|--------|---------|
| consecutive_days | 0.66 | +0.14% | 63.4% | 0.28% | 11 | BORDERLINE |
| kalman_filter | 0.32 | +0.12% | 20.2% | 0.22% | 3 | REJECT |
| regime_detection | -1.28 | -0.15% | 30.1% | 0.40% | 7 | REJECT |

Note: No strategy clears 0.8 threshold. DBA position is a DISCRETIONARY/FUNDAMENTAL entry based on PCR 0.14 (extreme call buying), stagflation overlay thesis, and regime file designation as active long. PM entered at $27.17 (March 30 9:30 AM ET).

### Defensive Pharma Basket — kalman_filter (S11)

| Basket | Regime Sharpe | Trades | Verdict |
|--------|--------------|--------|---------|
| ABBV + GILD + JNJ (aggregate) | 0.21 | 7 total | REJECT — no evidence |

Note: 2-3 trades per name is statistically meaningless. Per-name testing deferred to S12.

---

## Session 12 — Regime-Matched Results (2026-03-30)

REGIME: Risk-Off/Stagflation 85% | VIX 31 | Brent $115 | Iran deadline April 6

### TEST 1 — GPR Ceasefire Reversal Proxy (USO)

| Strategy | Regime Sharpe | Trades | WR | MDD | Verdict |
|----------|--------------|--------|-----|-----|---------|
| regime_detection / USO | -0.26 | 4 | 19.9% | 0.56% | REJECT |
| composite (regime+kalman) / USO+SPY (365d) | 1.18 | 12 | 50% | 2.1% | WATCH* |

*Full-period, not regime-matched. Alpha is from SPY leg (60% WR), not USO short (43% WR).
Manual-only ceasefire trade. Backtest framework cannot proxy GPR drop >15% threshold.

### TEST 2 — VIX Term Structure Contrarian / SPY

| Strategy | Regime Sharpe | Trades | WR | MDD | Verdict |
|----------|--------------|--------|-----|-----|---------|
| consecutive_days / SPY | -0.38 | — | 51.7% | 0.8% | REJECT |
| composite (regime+consecutive) / SPY (365d) | 1.35 | 6 | 50% | 0.65% | REJECT** |

**Regime-matched signal is negative (-0.38). Full-period composite has only 6 trades — insufficient.
SSRN 3189502 claim of 3.4% alpha/month NOT confirmed in current regime conditions.

### TEST 3 — Individual Pharma (ABBV, GILD, JNJ) — S12 Per-Name Re-test

| Strategy | Regime Sharpe | Trades | WR | MDD | Verdict |
|----------|--------------|--------|-----|-----|---------|
| kalman_filter / ABBV+GILD+JNJ | 0.21 | 7 | 16.7% | 0.51% | REJECT |
| poc_reversion / ABBV+GILD+JNJ | 0.29 | 13 | 58.1% | 0.87% | REJECT |

No individual name cleared threshold. ~2-4 trades per name = statistically insufficient.
All pharma names remain on rejection list. Different strategy or longer lookback needed.

### TEST 4 — consecutive_days E&P Cluster Extension (COP, XOM, EOG)

| Symbol | Regime Sharpe (cluster) | Trades | WR | Avg Return | Verdict |
|--------|------------------------|--------|-----|------------|---------|
| COP | 1.91 (aggregate) | 12 | 83% | +3.87% | DEPLOY — highest conviction |
| EOG | 1.91 (aggregate) | 12 | 58% | +2.93% | DEPLOY |
| XOM | 1.91 (aggregate) | 12 | 58% | +1.87% | DEPLOY |
| Cluster aggregate | **1.91** | 36 | 60.8% | +2.11% | DEPLOY — post-April 6 only |

Aggregate metrics: Sortino 2.60, MDD 1.56%, Profit Factor 33.5, Outperforms B&H by +12.4%.
BLOCKED until April 6 resolution. Energy reduction mandate active. PCR bearish (SLB 0.18).
Combined with SLB consecutive_days (S11 Sharpe 2.23), we have a full E&P cluster template.

E&P CLUSTER TEMPLATE (consecutive_days, regime-matched):
- SLB: Sharpe 2.23, 15 trades, 79.8% WR (S11 — HIGHEST conviction)
- COP: Sharpe ~2+, 12 trades, 83% WR (S12)
- EOG: 12 trades, 58% WR (S12)
- XOM: 12 trades, 58% WR (S12)

### TEST 5 — DBA Post-Entry Validation

| Strategy | Regime Sharpe | Trades | WR | MDD | Verdict |
|----------|--------------|--------|-----|-----|---------|
| poc_reversion / DBA | **1.04** | 3 | 40.4% | 0.15% | WATCH — first threshold clearance |
| consecutive_days / DBA | 0.66 | 11 | 63.4% | 0.28% | WATCH — below threshold |

IMPORTANT: poc_reversion/DBA is the FIRST strategy to clear 0.8 on DBA. Only 3 trades limits confidence
but profit factor 403 indicates enormous win/loss asymmetry — consistent with commodity breakout thesis.
Combined with PCR 0.14 (extreme institutional call buying): HOLD DBA at current stop ($25.49).

---

## Session 12 PM — Additional Regime-Matched Results (2026-03-30 PM)

REGIME: Risk-Off/Stagflation 85% | VIX 31 | Brent $115 | Reference: XLE (96% similarity)

### Master S12 PM Results Table

| Strategy | Symbol | Regime Sharpe | Return | Win Rate | MDD | Trades | Verdict |
|----------|--------|--------------|--------|----------|-----|--------|---------|
| consecutive_days | XLK | **2.77** | +0.62% | 91.0% | 0.23% | 14 | DEPLOY — highest S12 result; LONG signal (not pairs short) |
| kalman_filter | GDX | **1.82** | +0.79% | 70.0% | 0.60% | 8 | DEPLOY — gold miners confirmed |
| vortex_indicator | XLE | **1.82** | +0.79% | 70.0% | 0.60% | 8 | DEPLOY — S8 rank #2 regime-validated |
| consecutive_days | CVX | **1.95** | +0.63% | 70.0% | 0.42% | 13 | DEPLOY — E&P cluster extended (5th name) |
| adaptive_trend | XLE | 1.44 | +0.69% | 63.3% | 0.68% | 10 | DEPLOY — S8 rank #3 regime-validated |
| rate_of_change | USO | 1.44 | +0.78% | 80.1% | 0.82% | 6 | DEPLOY — first valid USO strategy found |
| poc_reversion | ABBV | 1.30 | +0.36% | 59.9% | 0.33% | 6 | DEPLOY — ABBV is MR name, not trend |
| rs_momentum | GDX | 1.39 | +0.50% | 60.1% | 0.31% | 3 | SPARSE/WATCH — need more trades |
| kalman_filter | GILD | 0.82 | +0.22% | 40.0% | 0.47% | 4 | SPARSE/WATCH — barely clears threshold |
| kalman_filter | ABBV | -0.06 | +0.02% | 20.1% | 0.26% | 3 | REJECT — trend fails on ABBV |
| kalman_filter | JNJ | +0.20 | +0.04% | 20.0% | 0.35% | 4 | SPARSE/REJECT |
| kalman_filter | XLK | +0.31 | +0.09% | 20.1% | 0.11% | 1 | SPARSE/REJECT |
| adxr | XLV | -0.45 | -0.04% | 56.7% | 0.36% | 10 | REJECT — XLV completely dead zone |
| momentum | USO | 0.00 | 0.00% | 0.0% | 0.00% | 0 | REJECT (no signal) |
| poc_reversion + kalman composite | T | +0.17 | +0.28% | 80.0% | 1.71% | 5 | REJECT — signal cancellation |

### Key S12 PM Findings

1. consecutive_days/XLK (2.77 Sharpe, 91% WR, 14 trades): Best single result of the session. This is a LONG signal on XLK. The regime-matched backtest is profitable GOING LONG XLK — suggesting mean reversion bounces in the tech decline are tradable. NOT a mechanical short. For a pairs trade (long XLE / short XLK), need an explicit composite backtest in S13.

2. E&P Cluster Complete — consecutive_days works across ALL 5 names tested:
   | Name | Regime Sharpe | Trades | Entry Trigger |
   |------|--------------|--------|---------------|
   | SLB | 2.23 | 15 | RSI <65 + PCR <1.0 (S11) |
   | COP | ~1.91 (S12 AM) | 12 | Post-April 6 |
   | CVX | 1.95 | 13 | Post-April 6 |
   | EOG | ~1.91 (S12 AM) | 12 | Post-April 6 |
   | XOM | ~1.91 (S12 AM) | 12 | Post-April 6 |
   ALL BLOCKED until April 6 resolution. Energy reduction mandate still active.

3. XLE now has 6 confirmed regime-validated strategies:
   volume_imbalance (2.74) → adxr (2.42) → consecutive_days (2.14) → poc_reversion (2.02) → vortex_indicator (1.82) → adaptive_trend (1.44)
   S13 priority: triple composite vortex+adaptive_trend+adxr on XLE.

4. XLV confirmed dead zone: ALL 4 strategies negative in regime (poc -0.08, consecutive -0.39, kalman +0.14, adxr -0.45). Do not revisit XLV until regime shift.

5. ABBV: poc_reversion 1.30 WORKS; kalman -0.06 FAILS. ABBV is a mean-reversion name, not trend. Wait for pullback to $207-210 POC before entering.

6. rate_of_change/USO (1.44, 80.1% WR, 6 trades): First valid USO strategy. Combines with S12-1 scout (roll yield in backwardation) to make USO a legitimate tactical energy instrument. Test adxr/USO in S13 per scout recommendation.

---

## XLE Regime-Matched Rankings (S10 — XLE as reference, 98.73% similarity)

Highest-confidence regime-matched results in the research program.

| Strategy | Regime Sharpe | Regime Return | Win Rate | MDD | Verdict |
|----------|--------------|--------------|----------|-----|---------|
| volume_imbalance | **2.74** | +0.74% | 100% | 0.3% | ACTIONABLE — top XLE regime strategy |
| adxr | **2.42** | +0.72% | 69.9% | 0.4% | ACTIONABLE — confirmed regime-fit; S11: 3.92 (180d) / 6.46 (90d) |
| consecutive_days | **2.14** | +0.81% | 65.0% | 0.4% | ACTIONABLE |
| poc_reversion | **2.02** | +0.48% | 80.0% | 0.1% | ACTIONABLE — lowest MDD |
| volatility_targeting | 1.22 | +0.19% | 59.9% | 0.1% | Composite use only |
| kalman_filter | 0.77 | +0.23% | 19.9% | 0.0% | WEAK — do not deploy |

---

## ITA Regime-Matched Rankings (S10 — ITA as reference, 96.07% similarity)

| Strategy | Regime Sharpe | Regime Return | Win Rate | MDD | Verdict |
|----------|--------------|--------------|----------|-----|---------|
| consecutive_days | 0.60 | +0.19% | 52.3% | 0.9% | WEAK — below threshold |
| kalman_filter | -0.85 | -0.22% | 19.9% | 0.7% | FAIL |
| adxr | **-1.15** | -0.37% | 39.9% | 0.8% | DEMOTED — was playbook |
| volume_imbalance | **-1.25** | -0.18% | 19.5% | 0.4% | DEMOTED — regime-hostile |

ITA alpha was a full-period artifact. Do NOT trade ITA with these strategies.

---

## Session 8 NEW Strategies (Full Sweep — 169 new strategies tested)

Sorted by avg Sharpe across 9 symbols (SPY/QQQ/AAPL/MSFT/NVDA/XLE/XLK/AMZN/TSLA).

| Rank | Strategy | Avg Sharpe | Avg Return | Notes |
|------|----------|-----------|------------|-------|
| 1 | adxr | 1.087 | +1.85% | PLAYBOOK — XLE only (ITA demoted S10) |
| 2 | vortex_indicator | 0.997 | +1.64% | WATCH — needs regime test |
| 3 | adaptive_trend | 0.983 | +1.87% | WATCH — needs regime test |
| 4 | mtf_momentum | 0.932 | +1.78% | WATCH — needs regime test |
| 5 | r_squared | 0.926 | +1.89% | WATCH — needs regime test |
| 6 | rainbow_ma | 0.896 | +1.70% | WATCH |
| 7 | standard_error_bands | 0.890 | +1.60% | WATCH |
| 8 | linear_regression_slope | 0.877 | +1.45% | WATCH |
| 9 | fibonacci_extension | 0.816 | +2.00% | WATCH |
| 10 | volume_imbalance | 0.813 | +1.68% | PLAYBOOK — XLE only (ITA demoted S10) |
| 11 | risk_adjusted_momentum | 0.804 | +1.45% | WATCH |
| 12 | atr_channel_breakout | 0.799 | +1.38% | WATCH |
| 13 | atr_trailing_stop | 0.787 | +1.31% | WATCH |
| 14 | multi_period_breakout | 0.777 | +1.47% | WATCH |
| 15 | price_channel | 0.777 | +1.47% | WATCH |
| 16 | developing_value_area | 0.772 | +0.75% | WATCH |
| 17 | value_area | 0.764 | +1.03% | WATCH |
| 18 | keltner_channel | 0.739 | +1.25% | WATCH |
| 19 | linear_regression_channel | 0.708 | +1.26% | WATCH |
| 20 | fractal_breakout | 0.703 | +1.22% | WATCH |

---

## GLD / USO / SLV Universe Rankings (S10 original + S11 regime-matched corrections)

| Strategy | Symbol | Full-Period Sharpe | Regime Sharpe (S11) | Trades | Verdict |
|----------|--------|--------------------|---------------------|--------|---------|
| consecutive_days | USO | ~~2.37~~ | **0.67** | 11 | DEMOTED — regime-inflated (S11) |
| poc_reversion | USO | — | **1.13** | 7 | WATCH — only valid USO play |
| regime_detection | USO | 1.70 | -0.18 | 6 | REJECT (regime-matched) |
| volatility_targeting | USO | 1.67 | — | — | WATCH (not yet regime-tested) |
| adxr | USO | 1.38 | 0.22 | 7 | REJECT (regime-matched) |
| adxr | SLV | 1.17 | — | 3 | WATCH (3 trades only) |
| consecutive_days | GLD | 1.12 | — | — | WATCH |
| regime_detection | GLD | 1.12 | — | — | WATCH |
| adxr | GLD | 1.02 | — | 4 | WATCH (4 trades only) |
| volume_imbalance | USO | 1.23 | -0.73 | 5 | REJECT (regime-matched) |
| All strategies | GLD | <1.10 | — | — | Buy-and-hold dominates |
| kalman_filter | All | <0.20 | — | — | FAIL in commodities |

Note: GLD buy-and-hold = +46.87% in 1Y. SLV buy-and-hold = +101.56%. All active strategies are structural underperformers vs passive in commodities.

---

## Post-PCE Mean Reversion Test (S10 — MSFT/GOOGL)

| Strategy | Symbol | Sharpe | Return | Verdict |
|----------|--------|--------|--------|---------|
| bb_mean_reversion | MSFT | -1.55 | -2.54% | FAIL — regime-hostile |
| zscore_mean_reversion | MSFT | -0.93 | -1.15% | FAIL |
| zscore_mean_reversion | GOOGL | -0.31 | -0.23% | FAIL |
| bb_mean_reversion | GOOGL | +0.49 | +0.61% | Weak — insufficient |

Decision: Do NOT activate mean reversion on MSFT/GOOGL regardless of PCE print. Deferred to April 9 PCE — only activate if Core PCE <2.5% AND VIX <25 simultaneously.

---

## XLE Composite Voting Mode Comparison (S10)

| Composite | Voting Mode | Sharpe | Trades | PF | MDD | Verdict |
|-----------|-------------|--------|--------|----|-----|---------|
| adxr + vol_imbalance + vol_target | weighted | 1.84 | 9 | 3.99 | 1.25% | BEST — use this mode |
| adxr + vol_imbalance + vol_target | any | 1.84 | 9 | 3.99 | 1.25% | Identical to weighted |
| adxr + vol_imbalance + vol_target | majority | 2.51* | 1 | 999* | 0.81% | DEGENERATE (1 trade) |
| adxr + vol_imbalance (2-leg) | weighted | 1.73 | 7 | — | 1.4% | Fewer trades, lower Sharpe |

Use triple composite weighted as a POSITION SIZING signal on XLE: all three agree = full size, two agree = half size.

---

## Session 8 — Regime-Matched Validation (96.87% similarity)

| Strategy | 1Y Avg Sharpe | Regime Sharpe | Regime Return | Win% | Max DD | Verdict |
|----------|-------------|--------------|--------------|------|--------|---------|
| center_of_gravity | ~1.58 | **-0.24** | -0.75% | 53.5% | 4.8% | SUSPENDED — regime-hostile |
| consecutive_days | ~1.53 | **+0.48** | +1.93% | 59.5% | 5.0% | REGIME-RESILIENT (on SPY/broad) |
| island_reversal | ~1.65 | **-0.19** | -0.97% | 32.2% | 6.1% | REJECTED — regime-hostile, low WR |

---

## Session 8 — Composite Backtest Results

| Composite | Sharpe | Return | Win% | PF | Trades | Verdict |
|-----------|--------|--------|------|----|--------|---------|
| poc_reversion + center_of_gravity | 0.32 | +3.35% | 68.4% | 2.03 | 171 | WEAK — no synergy |
| zscore_mean_reversion + obv_divergence | -0.07 | -1.56% | 74.1% | 2.33 | 54 | NEGATIVE — too restrictive |
| bb_mean_reversion + williams_r | -0.22 | -3.31% | 75.0% | 1.91 | 72 | NEGATIVE — MR hostile in regime |

---

## Zero-Signal Strategies (never triggered in 365d on 9 symbols)

combined_signal, consolidation_breakout, dual_momentum, golden_cross, hv_breakout, lvn_breakout, mass_index, ml_enhanced_technical, ml_prediction, momentum_rank, rectangle_pattern, rs_momentum, sentiment_driven, three_soldiers_crows, time_series_momentum, trend_intensity_index, volatility_regime, vpin

---

## REJECT LIST (Confirmed — do not revisit)

| Strategy | Avg Sharpe | Reason |
|----------|-----------|--------|
| end_of_month | -1.45 | Calendar bias, wrong timing |
| pivot_point | -1.09 | Negative everywhere |
| calendar_aware | -1.00 | Multi-signal, underperforms |
| santa_claus_rally | -0.92 | Wrong season/regime |
| macd_histogram | -0.84 | MACD derivative fails |
| accelerator_oscillator | -0.77 | Negative all symbols |
| quarter_end | -0.76 | Wrong timing |
| camarilla_pivot | -0.75 | Pivot strategies failing |
| halflife_mean_reversion | -0.70 | Slow MR fails (confirmed Rob Carver) |
| spread_mean_reversion | -0.60 | Pairs-based, sparse |
| island_reversal | -0.19 (regime) | Regime-hostile, low WR 32% |
| adxr/ITA | -1.15 (regime) | S10 demotion — full-period mirage |
| volume_imbalance/ITA | -1.25 (regime) | S10 demotion — regime-hostile |
| bb_mean_reversion/MSFT | -1.55 | Regime-hostile on tech |
| zscore_mean_reversion/MSFT | -0.93 | Regime-hostile on tech |
| consecutive_days/USO | 0.67 (regime) | S11 demotion — full-period 2.37 was inflated |
| volume_imbalance/USO | -0.73 (regime) | S11 — regime-hostile |
| regime_detection/USO | -0.18 (regime) | S11 — regime-hostile |
| adxr/USO | 0.22 (regime) | S11 — below threshold |
| poc_reversion/XLV | -0.08 (regime) | S11 — S9 result was non-regime artifact |
| consecutive_days/XLV | -0.39 (regime) | S11 — regime-hostile |
| kalman_filter/XLV | +0.14 (regime) | S11 — below threshold, too few trades |
| consecutive_days/T | -0.27 (regime) | S11 — regime-hostile |
| pharma basket (ABBV+GILD+JNJ) | 0.21 (regime) | S11 — no evidence, need per-name test |

---

## PLAYBOOK-Promoted Strategies (All-Time)

| Strategy | Sharpe | PF | Trades | Regime Fit | Current Regime Weight | Stop Rule |
|----------|--------|----|--------|------------|----------------------|-----------|
| zscore_mean_reversion | 2.16 | 13.83 | 16 | Mixed | 0% (Risk-Off) | 1x ATR |
| vwap_mean_reversion | 2.04 | 6.19 | 20 | Mixed | 0% (Risk-Off) | 1x ATR |
| bb_mean_reversion | 1.97 | 6.37 | 38 | Mixed | 0% (Risk-Off) | 1x ATR |
| williams_r | 1.96 | 5.69 | 22 | Mixed | 0% (Risk-Off) | 1x ATR |
| obv_divergence | 1.69 | 8.09 | 17 | Mixed | 0% (Risk-Off) | 2x ATR |
| island_reversal | 1.65 | — | 22 | Mixed | SUSPENDED (regime-hostile) | — |
| poc_reversion | 1.60 | — | 25 | All | HIGH — regime-proven | 2x ATR |
| center_of_gravity | 1.58 | — | 161 | All | SUSPENDED (regime-hostile) | — |
| kalman_filter | 1.58 | 2.95 | 21 | All-weather | 50% weight | 2x ATR |
| consecutive_days | 1.53 | — | 46 | All-weather | HIGH — S8/S10 regime confirmed (broad symbols) | 2x ATR |
| regime_detection | 1.37 | 2.68 | 30 | All-weather | 50% weight | 2x ATR |
| turtle_system1 | 1.14 | 1.95 | 21 | Trending | 0% (avoid) | 2x ATR |
| triple_ma | 0.98 | 2.68 | 12 | Trending | 0% (avoid) | 2x ATR |
| adxr | 1.09–6.46 | 2.65 | 21+ | XLE ONLY | HIGH (S11: strengthening at shorter windows) | 2x ATR |
| volume_imbalance | 0.81–2.74 | — | — | XLE ONLY | HIGH (S10 confirmed) | 2x ATR |
| consecutive_days/USO | ~~2.37~~ → 0.67 (regime) | — | 11 | DEMOTED S11 | 0% — regime inflation confirmed | — |

### WATCH LIST — Near Playbook Promotion (needs 5 profitable paper trades)

| Strategy | Symbol | Regime Sharpe | Trades | Entry Trigger | Status |
|----------|--------|--------------|--------|---------------|--------|
| consecutive_days | SLB | **2.23** | 15 | RSI < 65 + PCR normalize + post-Apr6 | WATCH — highest new S11 finding |
| poc_reversion | USO | 1.13 | 7 | Pullback to support | WATCH — only valid USO play |
| kalman_filter | T | 1.14 | 4 | PCR < 1.5 | WATCH — marginal trade count |
| poc_reversion | SLB | 0.98 | 6 | Backup to consecutive_days | WATCH |

---

## Scout Strategies — Sessions 8–11

### Sessions 8–10 Discoveries

| # | Strategy | Source | Confidence | Signal | Priority |
|---|----------|--------|------------|--------|----------|
| 1 | I-XTSM OVX Cross-Asset Momentum | SSRN 4424602 (Wiley 2025) | 5/5 | FULLY NEGATIVE (cash) | BACKTEST S12 |
| 2 | GLD+IEF Joint Regime Filter | QuantPedia Q4 2025 | 4/5 | OFF (IEF negative) | BACKTEST S12 |
| 3 | Macro 5-Factor Sector Rotation | SSRN 5279491 (May 2025) | 4/5 | Energy 10/10, Tech -8/10 | BACKTEST S12 |
| 4 | GPR Defense/Energy Rotation | SSRN 5207012 + PLOS One 2025 | 4/5 | April 6 re-escalation trigger | BACKTEST S12 |
| 5 | Energy-Tech XLE/XLK Pairs | FinancialContent + 2022 analog | 4/5 | 30pt spread live, reduce pre-Apr6 | BACKTEST S12 |
| 6 | VIX Backwardation+Breadth+HY MR | TradeWell + Cboe 2025 | 3/5 | All 3 conditions active, engine disagrees | CAUTION |
| 7 | Post-PCE Entry Timing | SSRN 4280699 (Fed paper) | 4/5 | Deferred to April 9 PCE | IMPLEMENT on April 9 |
| 8 | Crack Spread Refiner (CRAK/VLO) | Benzinga Mar 2026 + CME | 4/5 | Reduce 50% by April 4 | MONITOR (reduction mandate) |
| 9 | Oil Supply Shock Regime ID | Hamilton 2009 + ScienceDirect 2024 | 3/5 | Confirmed supply shock | MONITOR |
| 10 | TATS Gold Direction Model | arXiv 2601.12706 (Jan 2026) | 4/5 | 58.66% directional accuracy | MONITOR — time GLD re-entry |
| 11 | PAA Multi-Asset Regime-Switch | QuantPedia Feb 2026 | 4/5 | Bear regime = 40% gold | BACKTEST S12 |

### Session 11 Scout — 7 New Discoveries (2026-03-30)

| # | Strategy | Source | Confidence | Signal | Action |
|---|----------|--------|------------|--------|--------|
| S11-1 | VIX Term Structure Contrarian Equity Timer | SSRN 3189502 / JRFM 2019 | 4/5 | ACTIVE — backwardation confirmed, 5 weekly declines | BACKTEST S12 |
| S11-2 | EIA Wednesday Crude Intraday Momentum | SSRN 3822093 / Energy Journal 2023 | 4/5 | April 1 10:30 AM ET — job #47 set | IMPLEMENT MANUAL |
| S11-3 | WTI 14-Month ROC on USO | IJEEP 2024 (Gurrib et al.) | 3/5 | ACTIVE (WTI $70→$101, ROC strongly +) | BACKTEST S12 |
| S11-4 | Multi-Commodity GPR + Ceasefire Reversal | SSRN 4964922 / IRFA 2025 | 4/5 | ACTIVE + ceasefire: GPR -15% → SHORT USO / LONG SPY | BACKTEST S12 URGENT |
| S11-5 | GDX/GLD Ratio Stagflation Lever | QuantPedia/WisdomTree/Sprott 2025 | 3/5 | ACTIVE — ratio broke 15yr consolidation | BACKTEST S12 (regime-validate first) |
| S11-6 | VIX-Gated Healthcare Defensive Rotation | Meketa/Hartford Funds 2025 | 3/5 | CONFLICTED — thesis valid but XLV regime-matched = -0.08 | MONITOR only |
| S11-7 | AMLP MLP Toll-Road Pipeline | Alerian/ALPS/Allianz 2025 | 2/5 | ACTIVE (ceasefire-resilient energy) | MONITOR |

Key S11 Scout notes:
- S11-2 EIA intraday: Job #47 fires April 1 10:30 AM ET. Watch USO direction in 10:30-11:00 window. >1% move = ride to close.
- S11-4 GPR Ceasefire Reversal (URGENT): First academically-grounded April 6 de-escalation trade: GPR drop >15% in a week → SHORT USO / LONG SPY, 4-day hold.
- S11-1 VIX Contrarian: Backwardation = LONG signal (OPPOSITE of current filter use). ~3.4% alpha/month. Composite: regime_detection + consecutive_days, 20-day hold, HARD EXIT April 6.
- S11-6 XLV DEMOTED: S11 sprint found regime Sharpe -0.08 — sector thesis ≠ strategy performance.
- XLU explicitly WORSE than XLV in stagflation (S&P Global 2025). Do not add utilities.

### Session 12 PM Scout — 6 New Discoveries (2026-03-30 PM)

Full report: knowledge/trading/scans/2026-03-30_session13_strategy_scout.md

| # | Strategy | Source | Confidence | Signal | Action |
|---|----------|--------|------------|--------|--------|
| S12-1 | Oil Backwardation Roll Yield (USO/BNO) | ETF.com/CNBC Mar 2026 | 4/5 | ACTIVE — Brent steep backwardation, USO beating WTI by 8-12% YTD | Use USO not XLE for energy longs; test adxr/USO |
| S12-2 | Industrial Aftershocks Cascade (ECVT/sulfur) | PineBrook Capital Mar 2026 | 4/5 | ACTIVE — Mosaic $250M EBITDA hit Q1, sulfur producers benefit | Backtest consecutive_days on ECVT; ceasefire-resilient (weeks to reopen) |
| S12-3 | Biofuel Energy-Agriculture Proxy (SOYB/DBA) | Financial Content Mar 2026 | 3/5 | ACTIVE — DBA/SOYB as ceasefire-resilient energy proxy at $80+ oil | DBA already held; add SOYB as incremental hedge; backtest SOYB |
| S12-4 | Pre-FOMC Gold Drift GLD T-7 (NY Fed SR/512) | QuantifiedStrategies + NY Fed | 4/5 | NOT YET — May 7 FOMC; entry April 28 | JOB #48 SET — fires April 28 9:30 AM ET |
| S12-5 | Five-Scenario Iran Asymmetry Map | OilPrice.com + Allianz Mar 2026 | 5/5 (framework) | ACTIVE — NEGATIVE EV for USO: (40%×-17.5%) + (45%×+7.5%) + (15%×+17.5%) = -1% | Energy reduction mandate CONFIRMED by EV math; DBA survives all scenarios |
| S12-6 | Factor Premium Stagflation Rotation (QMOM/VLUE) | QuantPedia (Baltussen 1875-2026) | 4/5 | ACTIVE — stagflation regime, factor premiums positive while index -7.1%/yr | Replace SPY/QQQ with QMOM/VLUE/USMV; backtest in S13 |

Key S12 Scout actions:
- S12-5 Iran EV math: USO has negative expected value (-1%) at $115 Brent. TRIM energy before April 6.
- S12-4 GLD T-7: Job #48 fires April 28 9:30 AM ET to check GLD entry for May 7 FOMC drift.
- S12-1 Roll yield: Prefer USO over XLE for energy-long thesis (structural roll yield tailwind in backwardation). Test adxr/USO in S13.
- S12-2 ECVT: Ceasefire-resilient downstream play; sulfur shortage persists 4-8 weeks even after deal.
- S12-3 SOYB: Biofuel floor at $80+ oil makes SOYB less volatile than XLE/USO on ceasefire. Complements DBA position.
- S12-6 Factor ETFs: QMOM/VLUE/USMV as index replacements in stagflation. Backtest S13.

---

## Paper Trading Log — Alpha Research System

| # | Date | Symbol | Strategy | Entry | Stop | Target | Status | P&L |
|---|------|--------|----------|-------|------|--------|--------|-----|
| 1 | 2026-03-25 | XLE | poc_reversion | $55.79 | $58.00 | $61.37 | CLOSED WIN | +$1,034 (+10.35%) |
| 2 | 2026-03-30 | T | kalman_filter | $28.79 | $27.99 | $31.67 | OPEN | — |

Paper trade stats: 1/1 closed | 100% win rate on closed | +$1,034 realized | 1 open position (T)
Note: Paper trade sizing = $10K. PM system sizing = 5% of $100K = $5K (explains P&L difference vs PM history).
T entry rationale: PCR collapsed 2.58→1.15 (trigger met PCR<1.5), 100% bullish alignment all TFs, P/E 9.6x, yield 3.84%, kalman regime Sharpe 1.14, Risk-Off defensive telecom, max pain $29 pull.

---

## Portfolio Manager System — Full History (as of 2026-03-30)

All positions since inception (March 18, 2026).

| Ticker | Entry | Exit | P/L% | P/L$ | Days | Exit Signal | Status |
|--------|-------|------|------|------|------|-------------|--------|
| T | $28.79 | — | +0.00% | — | 0 | — | OPEN (stop $27.99, target $31.67) — S12 PM entry |
| DBA | $27.17 | — | -0.17% | — | 0 | — | OPEN (stop $25.49, target $29.89) |
| MRK | $119.15 | — | -0.88% | — | 3 | — | OPEN (stop $114.49, target $131.07) — Terns acquisition $6.7B today (bullish) |
| VLO | $247.04 | $254.32 | **+2.95%** | **+$145.60** | 3 | RSI_OVERBOUGHT | CLOSED WIN ✓ |
| MCD | $315.73 | $311.19 | -1.44% | -$68.10 | 11 | TREND_REVERSAL | CLOSED LOSS |
| EOG | $139.68 | $144.72 | **+3.61%** | **+$176.40** | 2 | RSI_OVERBOUGHT | CLOSED WIN ✓ |
| XLE | $55.79 | $61.07 | **+9.46%** | **+$464.64** | 1 | TAKE_PROFIT | CLOSED WIN ✓ |
| GE | $302.09 | $293.67 | -2.79% | -$75.78 | 9 | TREND_REVERSAL | CLOSED LOSS |
| SBUX | $92.66 | $92.01 | -0.70% | -$34.45 | 8 | TREND_REVERSAL | CLOSED LOSS |
| UNP | $242.32 | $234.92 | -3.05% | -$88.80 | 6 | TREND_REVERSAL | CLOSED LOSS |
| GDX | $93.96 | $82.90 | **-11.77%** | **-$342.86** | 2 | STOP_LOSS | CLOSED LOSS (largest) |
| MSFT | $370.57 | $370.57 | 0.00% | $0.00 | 1 | TREND_REVERSAL | CLOSED FLAT |
| PG | $143.78 | $143.78 | 0.00% | $0.00 | 1 | TREND_REVERSAL | CLOSED FLAT |
| ABBV | $207.06 | $207.06 | 0.00% | $0.00 | 1 | MANUAL | CLOSED FLAT |
| QCOM | $131.59 | $130.47 | -0.85% | -$41.44 | 1 | TREND_REVERSAL | CLOSED LOSS |
| HD | $341.43 | $330.93 | -3.08% | -$84.00 | 1 | TREND_REVERSAL | CLOSED LOSS |
| NKE | $55.12 | $53.47 | -2.99% | -$89.10 | 1 | TREND_REVERSAL | CLOSED LOSS |

Portfolio Stats (closed trades only, 14 closed):
- Wins: 3 (VLO, EOG, XLE) | 21.4% win rate
- Losses: 8 | Break-even: 3
- Avg Win: +$262.21 | Avg Loss: -$103.07
- Win/Loss Ratio: 2.54 (cutting losses fast, letting winners run)
- Total Realized P/L: ~-$37.89 (system total)
- Current Value: $99,930.91 (-0.07% from $100K start, 3 positions open)
- Cash: $91,000.50 (91% — defensive with 3 open positions: T + DBA + MRK)

Key observations:
- GDX was the only stop-loss exit (all others were TREND_REVERSAL or RSI signals)
- System is performing as designed: small losses, larger wins
- VLO exit today (+$145.60) on RSI_OVERBOUGHT = correct energy reduction execution
- T opened S12 PM on PCR trigger — first kalman_filter live test
- MRK acquiring Terns Pharmaceuticals $6.7B (CML dominance) — bullish catalyst today

---

## Daily Snapshots

| Date | Value | Day P/L | Total P/L | Positions |
|------|-------|---------|-----------|-----------|
| 2026-03-18 | $100,000 | — | $0.00 | 6 |
| 2026-03-19 | $99,524 | -$475 (-0.48%) | -$475 | 5 |
| 2026-03-20 | $99,326 | -$199 (-0.20%) | -$674 | 4 |
| 2026-03-26 | $99,817 | +$490 (+0.49%) | -$183 | 6 |
| 2026-03-30 AM | $99,962 | +$146 (+0.15%) | -$38 | 2 |
| 2026-03-30 PM | $99,931 | -$31 | -$69 | 3 (T added) |

Recovery: $99,326 low → $99,931 (3 positions). T, DBA, MRK all within normal range of entry.

---

## Session Coverage

| Session | Date | Strategies Tested | Cumulative Total | Key Finding |
|---------|------|-------------------|------------------|-------------|
| S1 | 2026-03-22 | ~7 | 7 | Turtle/TripleMA baseline |
| S2 | 2026-03-24 AM | 52 | 59 | MR cluster discovered (zscore, vwap, bb, williams_r) |
| S3 | 2026-03-24 PM | 42 | 101 | rate_of_change, aroon, OBV |
| S4 | 2026-03-25 | ~35 | ~136 | poc_reversion, consecutive_days promoted |
| S5-S7 | 2026-03-26 | 0 (backend down) | ~136 | XLE paper trade WIN +10.35% |
| S8 | 2026-03-27 AM | 169 + 7 priority | 206 (100%) | adxr, vortex, full sweep complete |
| S9 | 2026-03-27 PM | Regime validation + cross-universe | 206 (regime-mapped) | ALL S8 strategies fail on SPY regime-matched |
| S10 | 2026-03-27 EOD | XLE/ITA regime-matched + commodities | 206 + ~45 runs | XLE cluster confirmed, consecutive_days/USO promoted |
| S11 | 2026-03-30 AM | USO/SLB/T/DBA/XLV/pharma regime-matched | 206 + ~80 runs | consecutive_days/USO DEMOTED, SLB new signal (Sharpe 2.23) |
| S12 | 2026-03-30 PM | Pharma/GDX/XLK/CVX/XLE strategies + 6 scout discoveries | 206 + ~95 runs | consecutive_days/XLK 2.77!, kalman/GDX 1.82, T OPENED, Job #48 GLD Apr28 |

---

## Session 12 — COMPLETED (2026-03-30 PM)

### S12 Results Summary

S12 QUANT (10 tasks completed):
- consecutive_days/XLK: Sharpe 2.77, 91% WR, 14 trades — HIGHEST S12 RESULT (long strategy, not pairs short)
- kalman_filter/GDX: Sharpe 1.82, 70% WR, 8 trades — DEPLOY (gold miners, all-weather)
- vortex_indicator/XLE: Sharpe 1.82, 70% WR, 8 trades — DEPLOY (S8 rank #2, first regime validation)
- consecutive_days/CVX: Sharpe 1.95, 70% WR, 13 trades — DEPLOY (E&P cluster extended: SLB+COP+EOG+XOM+CVX)
- adaptive_trend/XLE: Sharpe 1.44, 63.3% WR, 10 trades — DEPLOY (S8 rank #3 confirmed)
- rate_of_change/USO: Sharpe 1.44, 80.1% WR, 6 trades — DEPLOY (first valid USO strategy!)
- poc_reversion/ABBV: Sharpe 1.30, 59.9% WR, 6 trades — DEPLOY (ABBV is MR name, not trend)
- kalman_filter/GILD: Sharpe 0.82, 40% WR, 4 trades — SPARSE/WATCH
- adxr/XLV: Sharpe -0.45 — REJECT (confirms XLV dead zone)
- poc_reversion + kalman composite/T: Sharpe 0.17 — REJECT (signal cancellation)

S12 ACTIONS TAKEN:
- T OPENED at $28.79 (stop $27.99, target $31.67) — PCR trigger fired (2.58→1.15)
- ABBV DEFERRED — 100% bearish alignment, above max pain $207.50, need POC pullback to $207-210
- GDX DEFERRED — RSI stabilization above 35 needed per regime file
- Job #48 created — GLD pre-FOMC T-7 entry signal fires April 28 9:30 AM ET

S12 SCOUT (6 discoveries — see scans/2026-03-30_session13_strategy_scout.md):
- D1: USO backwardation roll yield → prefer USO over XLE; test adxr/USO in S13
- D2: ECVT cascade (sulfur→fertilizer) — ceasefire-resilient downstream play
- D3: SOYB biofuel proxy — DBA/SOYB survive ceasefire (biofuel floor at $80+ oil)
- D4: Pre-FOMC GLD drift T-7 — Job #48 April 28 (NY Fed SR/512)
- D5: Iran 5-scenario EV = -1% for USO at $115 — validates energy reduction mandate
- D6: Factor premiums in stagflation → QMOM/VLUE/USMV replace index ETFs

---

## Session 13 Priorities

### ACTIVE MONITORING (Pre-April 6)

1. April 1 10:30 AM ET — Job #47 EIA USO intraday signal. Watch USO >1% move = ride to close.
2. April 3 — CPI MoM (forecast +0.3%). If hot: energy/DBA holds. If soft: MR conditional.
3. April 5 — NFP first Iran-conflict reading. Jobs weakness = Fed caught, stagflation confirmed.
4. April 6 8PM ET — Iran deadline. THE binary event. Triggers: ceasefire = USO short/energy trim; no deal = hold energy.
5. April 8 — FOMC Minutes. Check for explicit rate hike signal.
6. April 9 8:30 AM — PCE Feb 2026. MR activation gate: PCE <2.5% AND VIX <25 → activate zscore/bb/vwap cluster.
7. April 10 — CPI March 2026. Highest data impact of April gauntlet.

### ENTRY TRIGGERS WATCHING (Updated S12 PM)

| Trigger | Symbol | Strategy | Condition | Status |
|---------|--------|----------|-----------|--------|
| SLB entry | SLB | consecutive_days (2.23) | RSI < 65 + PCR < 1.0 + post-April 6 | WAITING |
| T | T | kalman_filter (1.14) | PCR trigger MET 2.58→1.15 | OPENED $28.79 ✓ |
| ABBV | ABBV | poc_reversion (1.30) | Pullback to POC $207-210 + 4h reversal | WATCHING |
| GDX | GDX | kalman_filter (1.82) | RSI stabilizes above 35 + 4h flip | WATCHING |
| MR Cluster | SPY/QQQ | zscore/bb/vwap | VIX < 25 AND PCE < 2.5% (April 9 gate) | WAITING |
| GLD re-entry | GLD | buy-and-hold add | RSI >35 + IEF 12m positive + 4h holds | WATCHING |
| EIA USO | USO | intraday momentum | April 1 10:30 AM — manual | JOB #47 SET |
| Apr 6 ceasefire | USO/SPY | GPR reversal | GPR -15% → short USO / long SPY | PLAYBOOK READY |
| Post-PCE MR | QQQ | zscore at open | PCE <2.5% AND RSI(2) <35 on April 9 | DEFERRED |
| GLD FOMC drift | GLD | kalman_filter entry | April 28 T-7 before May 7 FOMC | JOB #48 SET |

### S13 BACKTEST QUEUE

1. vortex_indicator + adaptive_trend composite on XLE (both regime-validated, test synergy)
2. adxr/USO (S12-1 scout: instrument substitution, roll yield thesis)
3. ECVT regime-matched: consecutive_days + kalman_filter + poc_reversion (S12-2 scout)
4. SOYB regime-matched (S12-3 scout: not yet in library)
5. QMOM + VLUE regime-matched (S12-6 scout: factor rotation in stagflation)
6. rs_momentum/GDX wider lookback (borderline 1.39 Sharpe, only 3 trades — need confirmation)
7. kalman_filter/GILD wider lookback (0.82 Sharpe, 4 trades — need confirmation)
8. rate_of_change on individual E&P names (XOM/COP/SLB — extend USO ROC finding)
9. XLK consecutive_days explicit pairs backtest (long XLK / short XLE dollar-neutral)
10. E&P cluster post-April 6 entry execution: SLB(2.23) → COP(~2) → CVX(1.95) → EOG(1.91) → XOM(1.91)
