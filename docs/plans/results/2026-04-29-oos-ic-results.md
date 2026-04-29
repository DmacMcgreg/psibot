# Out-of-Sample IC — Phase D Replay-A, OOS Variant

**Date:** 2026-04-29
**What changed:** Replay-A now supports a train/test split. IC weights can be fit on a date-windowed subset of `universe_snapshots` (in-memory, not persisted), then used to score decisions whose `decision_date` falls in a separate test window. Run via `replay-decisions --train-since/--train-until/--test-since`. Headline summary now includes a Spearman p-value via `scipy.stats.spearmanr`.

---

## Headline

**Out-of-sample agent_skill_ic_5d = −0.0978** (n=3,633, p ≈ 0).

The +0.297 Spearman from 2026-04-27 was a curve-fit artifact of fitting IC on the same window the decisions were drawn from. Out of sample — train IC on 2026-01-26 → 2026-03-25, score test decisions on 2026-03-26 → 2026-04-25 — **the agent's IC-weighted ranking anti-correlates with forward returns**, with very high statistical confidence (n=3,633).

---

## Four-cell decomposition

| Variant | IC source | Decision dates | ρ (5d) | n |
|---|---|---|---:|---:|
| Original Replay-A (in-sample) | Full window 2026-01-26..2026-04-24 | All | **+0.2972** | 3,640 |
| Full-window IC, test decisions only | Full window | ≥ 2026-03-26 | +0.2987 | 3,633 |
| Train-window IC, all decisions | Train 2026-01-26..2026-03-25 | All | −0.0975 | 3,640 |
| **True OOS** | **Train** | **≥ 2026-03-26** | **−0.0978** | **3,633** |

The sign flip is entirely caused by the IC source, not by the decision sub-period. Restricting to test-period decisions while keeping full-window IC keeps the +0.30 result. Switching to train-window IC flips it to −0.10 regardless of decision filter. The original +0.297 is a mirror artifact: the IC weights "knew" how the test period would unfold because they were fit on it.

---

## Why it flipped — feature-level diagnosis

Of the 13 features with a stable train-window IC at the 5d horizon (regime='all'), **11 sign-flip in the test window**:

| Feature | Train IC | Test IC | Δ |
|---|---:|---:|---:|
| bb_pos | +0.069 | −0.101 | −0.169 |
| ema_distance_200 | +0.061 | −0.114 | −0.174 |
| ema_distance_50 | +0.060 | −0.156 | −0.216 |
| distance_to_resistance | −0.060 | +0.131 | +0.191 |
| rsi_14 | +0.059 | −0.154 | −0.213 |
| macd_hist | +0.039 | −0.111 | −0.150 |
| ret_20d | +0.037 | −0.141 | −0.178 |
| distance_to_support | −0.036 | +0.084 | +0.120 |
| ret_5d | +0.058 | −0.031 | −0.089 |
| ret_1d | +0.030 | −0.053 | −0.082 |
| gap_pct | +0.067 | +0.015 | (no flip) |
| atr_14 | +0.004 | −0.020 | −0.024 |

**This is a textbook regime shift.** In the train window (Jan 26 – Mar 25), the top-IC features describe long-trend / momentum continuation: high `bb_pos`, far above EMA-200, high RSI, positive `ret_20d`, far from resistance (i.e. broken out). In the test window (Mar 26 – Apr 25), every one of these reverses. What worked as a *continuation* signal in train became a *fade* signal in test.

The agent's prompts that lean on momentum continuation (Afternoon Scanner, Overnight Screener) would have been net wrong in this period, and the IC weights from the full window mathematically encoded the right-side outcome — that's what produced the spurious +0.297.

---

## What this changes

**1. The +0.297 number is retired.** Any future reference to "agent skill IC" should use the OOS protocol or be marked clearly as in-sample / descriptive only.

**2. The "agent caught the quantum-computing breakout (IONQ +61.8%, RGTI +43.1%)" narrative still stands.** That's a Layer 1 catalogue finding (the agent considered them) plus a forward-return fact (they ran). It does NOT depend on the IC weights — the IC weights only scored *why* the agent should have liked them, and that "why" is fragile.

**3. The energy/defense bias finding (OXY/LMT/NOC/LNG/MPC/WTI all losing 10-15%) also stands.** The "IC said no" half of that finding is fragile (train-window IC may not have agreed), but the *outcome* — those tickers lost — is unconditional.

**4. Replay-B and prompt rewrites should NOT use the full-window IC weights.** They were curve-fit. Use Layer 1 catalogue findings (which jobs / tickers / sectors the agent over-weights) plus simple raw-feature filters (e.g. "skip energy in Risk-Off") instead.

**5. The proper next step on the IC track is rolling-window IC** — fit on a trailing 30-60 day window decayed older data, only use IC values whose train period strictly precedes the decision being scored. That's standard time-series cross-validation.

---

## Reproducibility

```bash
cd /Users/davidmcgregor/Documents/2_Code/2026/trading-bot/backend

# In-sample (original): +0.2972
uv run python -m app.research.cli replay-decisions

# True OOS: -0.0978
uv run python -m app.research.cli replay-decisions \
  --train-since 2026-01-26 --train-until 2026-03-25 \
  --test-since 2026-03-26

# Decomposition variants
uv run python -m app.research.cli replay-decisions --test-since 2026-03-26          # full IC, test decisions
uv run python -m app.research.cli replay-decisions \
  --train-since 2026-01-26 --train-until 2026-03-25                                 # train IC, all decisions
```

Run time: ~7 seconds for OOS, ~5 seconds for in-sample (extra cost is computing IC on 222k train snapshots in pandas).

---

## Files changed

- `trading-bot/backend/app/research/factor_ic.py` — extracted pure `compute_ic_rows(df)` from `compute_factor_ic()`; the latter now wraps the former for the persisted full-window path.
- `trading-bot/backend/app/research/replay/runner.py` — `run_replay()` accepts `train_since`, `train_until`, `test_since`, `persist`, `min_periods`. OOS path computes IC in-memory and skips the `agent_decision_eval` write by default to preserve the in-sample table.
- `trading-bot/backend/app/research/cli.py` — `replay-decisions` learns `--train-since`, `--train-until`, `--test-since`, `--persist`/`--no-persist`, `--min-periods`.
- Spearman p-values added to summary via `scipy.stats.spearmanr`.

---

## Next

- **Rolling-window IC** — implement trailing 30/60-day IC computed at each decision date. Replay-A then scores each decision against IC fit strictly before its date. This is the right way to know whether the agent has any predictive skill (the OOS result above is the lower bound of that question).
- **Sector-resolved Layer 1** — go back to the Layer 1 catalogue findings and slice by sector × period. The energy/defense bias is robust; the question is whether the agent over-weights defensive sectors specifically when the regime shifts away from them.
- **Replay-B should now lean on raw feature filters and Layer 1 patterns**, not the full-window IC. The first prompt revision should encode "skip energy in Risk-Off; treat momentum continuation as fade signal in Mixed/Risk-Off" — both findings present in raw catalogue data, neither depending on IC weights.
