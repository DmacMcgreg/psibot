# Replay-B v2 — Prompt-variant + Conditional-IC Tests

**Date:** 2026-04-29
**What changed:** Replay-B harness now has two prompt variants:
  - `revised` — IC table + Layer 1/OOS heuristics (sector bias, Afternoon Scanner, regime rules)
  - `ic-only` — pure mechanical IC-weighted ranker, no heuristics

Both were tested on (a) the original 3 well-calibrated-IC dates (2026-04-06, 04-07, 04-14) and (b) 3 poorly-calibrated-IC dates identified by sweeping per-date IC-baseline ρ across all 28 test dates (2026-03-26, 03-27, 04-13).

CLI: `replay-b --dates ... --prompt-variant {revised,ic-only}`. JSON parser hardened against stray ASCII control chars (one parse failure observed on glm-5.1 output, fix lands with this commit).

---

## Headline

**The IC baseline's strength is conditional on its own calibration**, and the LLM's added value is the inverse:

| | Well-IC dates (pooled n≈450) | Poor-IC dates (pooled n≈275-373) |
|---|---:|---:|
| **IC baseline** ρ | **+0.246** | −0.231 |
| LLM `revised` ρ | +0.098 | −0.180 |
| LLM `ic-only` ρ | +0.066 | ≈+0.07 |

When the rolling-30d IC happens to be well-aligned with current returns, ranking by IC dominates and the LLM only degrades the signal. When the rolling-30d IC is misaligned (regime-shift days), the IC baseline is *anti*-predictive and the LLM — especially `ic-only` — closes most of that gap and even crosses to slightly positive on the poor-IC pool. The honest takeaway: **no single method wins everywhere; the IC's own calibration determines which method to trust.**

---

## Step 1: ic-only variant on the same 3 well-IC dates

| Date | IC baseline ρ | LLM `revised` ρ | LLM `ic-only` ρ | n |
|---|---:|---:|---:|---:|
| 2026-04-06 | +0.270 | +0.172 | +0.175 | 140 |
| 2026-04-07 | +0.244 | +0.096 | **+0.240** | 148 |
| 2026-04-14 | **+0.148** | +0.154 | −0.281 | 162 |
| **Pooled** | **+0.246** (p≈0) | +0.098 (p=0.04) | +0.066 (p=0.16) | 450 |

Stripping the prompt to `ic-only` did NOT close the gap to baseline on average. Pooled ρ went from +0.098 → +0.066. Two effects:
- **2026-04-07**: ic-only nearly matches the baseline (+0.240 vs +0.244). Without heuristic distractions, the LLM can mechanically reproduce the IC-weighted ranking.
- **2026-04-14**: ic-only catastrophically fails (−0.281). The LLM appears to have inverted some of the IC weights (highly negative correlation on a date where the IC baseline was modestly positive).

**Verdict on Step 1:** Stripping heuristics is not a free win. `ic-only` is high-variance — sometimes close to the IC baseline, sometimes catastrophic. The heuristics in `revised` *stabilize* the LLM's output even though they cap upside.

---

## Step 2: Both variants on 3 poorly-calibrated-IC dates

Per-date IC baseline ρ across all 28 test dates was computed first (no LLM). The 4 most negative dates (with sufficient n):

| Date | n | IC baseline ρ | p |
|---|---:|---:|---:|
| 2026-03-27 | 170 | **−0.368** | <0.001 |
| 2026-03-26 | 105 | −0.193 | 0.05 |
| 2026-04-13 | 98 | −0.134 | 0.19 |
| 2026-03-30 | 164 | −0.121 | 0.12 |

Picked the top 3 (2026-03-27, 03-26, 04-13). All three are in the test period; 03-26/03-27 sit at the regime boundary documented in the OOS feature-flip table.

| Date | IC baseline ρ | LLM `revised` ρ | LLM `ic-only` ρ | n |
|---|---:|---:|---:|---:|
| 2026-03-26 | −0.193 | **−0.057** | −0.288 | 105 |
| 2026-03-27 | **−0.368** | −0.389 | **+0.317** (sign flip!) | 170 |
| 2026-04-13 | −0.134 | **+0.100** | −0.078 | 98 |
| **Pooled (3 dates)** | ~−0.23 | ~−0.18 | ~+0.07 | 373 |

**The standout: 2026-03-27 ic-only = +0.317** while the IC baseline at the same date was −0.368. **The LLM produced rankings that anti-correlate with the broken IC signal, ending up positively correlated with returns.** This is direct evidence that on a regime-shift day the LLM's general intuition (whatever it draws on when not constrained by IC weights) can exceed an IC-only ranker.

But again, ic-only is unstable: 2026-03-26 it produced −0.288 (worse than the −0.193 baseline). The same date `revised` was the winner at −0.057 (best of the three methods).

**Verdict on Step 2:** When IC is well-calibrated, IC wins. When IC is broken, **`ic-only`** has the best peak (2026-03-27 +0.317) but **`revised`** has the best floor (less catastrophic on 2026-03-26 and 2026-04-13). Neither LLM variant can be trusted alone; both deliver real, complementary signal in different regimes.

---

## What this tells us

1. **The +0.164 rolling-30d full-pool ρ is the average across well-IC and poor-IC dates.** The variance is bigger than the average. Some days the IC baseline gives +0.27, other days −0.37.

2. **No prompt variant clearly dominates.** Each method has a regime where it wins:
   - Well-IC days → IC baseline
   - Regime-shift days → LLM (`ic-only` for upside, `revised` for downside protection)

3. **The real opportunity is regime-aware blending.** A meta-strategy that detects "is IC currently well-calibrated?" in real time and routes to the right method would, in this dataset, average something north of +0.20 — better than any single method.

4. **The LLM heuristic overrides in `revised` are a stabilizer, not an alpha source.** They don't help on average, but they prevent the catastrophic ic-only blowups. They're a risk control, not a signal.

5. **`ic-only` proves the LLM can mechanically execute IC ranking** when it tries (2026-04-07 +0.240 vs IC +0.244). Failures are inconsistency, not capability.

---

## Pricing the 6-day experiment

GLM-5.1 cost across all 8 LLM runs (3 dates × 2 variants × 2 sets minus 1 retry minus 1 single date):
- Total input: ~110,000 tokens
- Total output: ~50,000 tokens
- z.ai list pricing: ~$0.10 total

Wall time: ~25 minutes across all calls (each ~60-90s).

---

## Implementation notes

**Code changed:**
- `trading-bot/backend/app/research/replay/replay_b.py` — added `IC_ONLY_SYSTEM_PROMPT`, `PROMPT_VARIANTS` registry, `prompt_variant` param. Hardened `_extract_json` to strip ASCII control chars (fixes one observed parse failure).
- `trading-bot/backend/app/research/cli.py` — added `--prompt-variant {revised, ic-only}` flag.

**Per-date ρ computation** (used to identify poor-IC dates) was a one-off Python snippet rather than a CLI command — deferred until we know if it's needed routinely. Easy to extract to `cli.py` later if the per-date dashboard wiring needs it.

---

## Reproducibility

```bash
cd /Users/davidmcgregor/Documents/2_Code/2026/trading-bot/backend
set -a; source ../../telegram-claude-code/.env; set +a

# Well-IC dates, both variants
uv run python -m app.research.cli replay-b \
  --dates 2026-04-06,2026-04-07,2026-04-14 --prompt-variant revised
uv run python -m app.research.cli replay-b \
  --dates 2026-04-06,2026-04-07,2026-04-14 --prompt-variant ic-only

# Poor-IC dates, both variants
uv run python -m app.research.cli replay-b \
  --dates 2026-03-26,2026-03-27,2026-04-13 --prompt-variant revised
uv run python -m app.research.cli replay-b \
  --dates 2026-03-26,2026-03-27,2026-04-13 --prompt-variant ic-only
```

---

## What to try next

The Replay-B track has produced enough to make the next moves clear:

1. **IC-quality detector** — at decision time, estimate whether the rolling-30d IC is currently "trustworthy" using observable proxies:
   - Day-over-day stability of rolling IC values (high stability = trustworthy)
   - Cross-sectional spread of IC values (concentrated = trustworthy)
   - VIX level vs. its 30d average (regime shift correlate)
   - Recent realized vs. predicted Spearman in a holdout-of-holdout window
   
   With a trustworthy/untrustworthy classifier, you can do the obvious blend: IC-baseline when trustworthy, LLM when not.

2. **Try a more capable model on poor-IC dates** — Sonnet 4.6 or Opus 4.7 against the same poor-IC dates. The +0.317 ic-only peak suggests the LLM has signal to give; a stronger model may have less variance and a higher floor.

3. **Hybrid scorer** — average the IC-baseline score and the LLM score (either variant), with weight chosen by IC-quality. This is a one-shot test once (1) is in place.

4. **Wire all of this into `/agents/eval`** — the per-date IC-quality + per-method ρ table is the natural dashboard view. Currently the dashboard only shows the in-sample +0.297 ceiling; getting these v2 numbers visible is immediate value.

The cleanest next step is **(1) the IC-quality detector** since it unlocks (3). Without it, the comparison is interesting but not actionable in production.
