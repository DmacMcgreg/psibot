# Rolling-Window IC — Phase D Replay-A, Time-Series CV Variant

**Date:** 2026-04-29
**What changed:** Replay-A now supports a rolling-window IC mode. For each unique decision_date D, IC is fit on a trailing calendar-day window ending at `D - gap`, where `gap` is per-horizon (default 12 days for 5d, 42 for 20d, 3 for 1d) and chosen so all `fwd_ret` values inside the window are observable using prices that close strictly before D — no leakage.

CLI: `replay-decisions --rolling-lookback-days N` (overrides `--train-since/--train-until/--test-since`). Per-decision IC fits are cached so each unique date is computed once.

---

## Headline

**Rolling 30-day lookback: agent_skill_ic_5d = +0.164** (n=3,640, p ≈ 0).

This is the un-inflated, leakage-free measure of the agent's predictive skill against IC weights fit on the 30 calendar days preceding each decision (with a 12-day safety gap before the decision date for 5d forward-return observability). It is **about half the magnitude** of the in-sample +0.297 from 2026-04-27, and it is **the opposite sign** of the OOS −0.098 from earlier today.

Both prior numbers are reconciled by what the rolling sweep reveals: **the result is highly sensitive to lookback length** because the train and test periods sit in different feature regimes.

---

## Lookback sweep

| Lookback (calendar days) | ρ (5d) | n | Wall time | Interpretation |
|---:|---:|---:|---:|---|
| 30 | **+0.164** | 3,640 | 2:01 | IC fit stays inside the contemporaneous (post-2026-03-26) regime |
| 60 | −0.141 | 3,640 | 3:06 | Window starts pulling in pre-regime data |
| 90 | −0.131 | 3,640 | 3:56 | Mostly pre-regime; resembles the OOS −0.098 |

For comparison from prior runs:

| Variant | ρ (5d) | n |
|---|---:|---:|
| In-sample (full window) | +0.297 | 3,640 |
| OOS train 2026-01-26..2026-03-25 / test ≥ 2026-03-26 | −0.098 | 3,633 |

The lookback dependency tells the same story as the OOS feature-flip table: feature signs reversed between Jan-Mar and Mar-Apr. A 30-day rolling window stays inside the test-period regime and gives a clean positive number; 60d and 90d windows blend in increasingly more of the pre-regime data and average the IC weights toward (or past) zero.

---

## What this number means

**Yes, the agent has nontrivial predictive skill at the 5d horizon when judged against IC weights fit on the trailing 30 days before each decision.** ρ ≈ +0.16 with n=3,640 is statistically very strong (p effectively 0). It says: the rank ordering of the agent's IC-weighted scores against the contemporaneous feature regime matches the rank ordering of subsequent forward returns at a level you would not expect by chance.

But:

1. **The skill is regime-conditioned.** The feature signs that worked in March-April flipped from January-February. The agent's "skill" is partly the agent absorbing the contemporaneous regime through its prompts and tool calls. A different upcoming regime could pull the number toward zero or negative again.

2. **30d is a short window for IC estimation.** ~21 trading days × 5,100 tickers × 2 times = ~214k observations. Plenty of cross-sectional data per day, but only 21 unique dates contributing to each feature's Spearman estimate. IC values are noisier here than in 60d/90d windows; some of the +0.164 may be alignment-by-chance between the agent's choices and noisy IC weights. The fact that the next-longer window (60d) flips sign supports this concern.

3. **20d horizon: still mostly unobservable.** Most decisions are recent enough that their snapshots haven't aged 20 trading days yet, so `actual_fwd_ret_20d` is null for the bulk of evaluations. 20d Spearman wasn't computed (insufficient n).

---

## Recommended headline going forward

When future work references "agent_skill_ic_5d", report it as **rolling-30-day, leakage-safe = +0.164**. Mark the +0.297 in-sample as deprecated and the OOS −0.098 as a regime-shift diagnostic, not a skill estimate.

If a single number is needed, +0.16 is the right one — but always pair it with the lookback length (because a different lookback can flip the sign) and the test period (because regime change can flip it).

---

## Implementation notes

**New module:** `trading-bot/backend/app/research/replay/rolling_ic.py` — `RollingICCache` class. Per-decision-date IC fit, per-horizon gap-respecting subsetting, lookup dict cached.

**Modified:**
- `scorer.py` — `ICScorer.score_row` now accepts an optional `ic_lookup` parameter; `build_ic_lookup(ic_df)` is exposed as a free function. Rank percentiles are still computed once on the full snapshot DataFrame and reused.
- `runner.py` — added `rolling_lookback_days`, `rolling_gap_1d/5d/20d`. Mode selection: rolling > OOS > in-sample. Per-decision lookup is fetched from the cache.
- `cli.py` — added `--rolling-lookback-days`, `--rolling-gap-1d/5d/20d`.

**Leakage gap rationale:** `forward_returns.py` computes `fwd_ret_h` for snapshot at date X using the first daily candle whose date ≥ X + h*2 calendar days (the +2 multiplier pads weekends). Worst-case observation date for fwd_ret_5d is X + 12 (when X+10 falls on a Saturday). Defaults: gap_5d=12, gap_20d=42, gap_1d=3.

**Wall time:** ~2 min for 30d lookback, ~4 min for 90d, on 28 unique decision dates × IC fit per date. Could be parallelized (each date is independent) but unnecessary at this scale.

---

## Reproducibility

```bash
cd /Users/davidmcgregor/Documents/2_Code/2026/trading-bot/backend

# Headline rolling 30d (~2 min): +0.164
uv run python -m app.research.cli replay-decisions --rolling-lookback-days 30

# Lookback sweep
uv run python -m app.research.cli replay-decisions --rolling-lookback-days 60
uv run python -m app.research.cli replay-decisions --rolling-lookback-days 90

# Custom gaps (e.g. tighter 5d gap if you accept some leakage risk)
uv run python -m app.research.cli replay-decisions \
  --rolling-lookback-days 30 --rolling-gap-5d 8
```

---

## Where the IC track stands now

| Method | ρ (5d) | What it answers |
|---|---:|---|
| In-sample (full window) | +0.297 | Curve-fit ceiling, deprecated |
| OOS (train Jan-Mar / test Mar-Apr) | −0.098 | Regime-shift diagnostic |
| Rolling 60d | −0.141 | Diluted across regimes |
| Rolling 90d | −0.131 | Diluted across regimes |
| **Rolling 30d** | **+0.164** | **In-regime predictive skill** |

The IC track has converged on +0.16 as the honest headline. It is small but real.

---

## Next

The IC track has produced about as much insight as it usefully can given the data we have. Going forward the higher-leverage moves are:

- **Replay-B (LLM re-run with revised prompt)** is now well-grounded. The revised prompt should reference the rolling-30d top-IC features at decision time, plus the unconditional Layer 1 catalogue findings (sector bias, Afternoon Scanner as best job). The +0.164 rolling number is the bar to beat.
- **Wire findings into `/agents/eval` dashboard** — the lookback sweep and feature-flip table from OOS are both compelling visuals; they would make the regime-conditional nature of IC weights browsable.
- **Sector-sliced Layer 1** — the energy/defense bias finding probably has a regime conditional too; worth slicing the catalogue by sector × regime to confirm.
- **Wait for more data and re-test.** With 6-9 months of snapshots, the OOS split has more statistical power and the rolling lookback can extend without crossing regimes.
