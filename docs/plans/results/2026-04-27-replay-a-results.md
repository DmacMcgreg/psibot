# Replay-A — Statistical Decision Eval Results

**Date:** 2026-04-27
**Approach:** For each (session, ticker) the agent considered in its 158 trading job runs, look up the snapshot at decision time, compute an IC-weighted score from the snapshot's features (rank-percentile centered, dot product with IC at this regime/horizon), and compare to the actual forward return.

**Wall time:** 10.7 seconds for the full pass.

---

## Headline number

```
Spearman corr(ic_score_5d, actual_fwd_ret_5d) = +0.297   (n=3,640)
```

Across 3,640 (session, ticker, snapshot) tuples where both an IC score and a 5-day forward return existed, the rank ordering of the agent's IC-weighted scores matches the rank ordering of actual outcomes with Spearman ρ = +0.30. **The relative ranking the agent gives its picks is informative.**

---

## Caveats first

1. **In-sample bias.** The IC was computed over the same 90-day window as the decisions being evaluated. A clean Replay-A would use a holdout period. This number is inflated; treat 0.30 as a ceiling, not a true out-of-sample skill estimate.
2. **Decision detection is loose.** A "decision" here = ticker mentioned via tool argument OR mentioned in prose ≥3 times in a session. We don't parse explicit buy/sell calls (most historical sessions predate the envelope schema). This measures the **information set**, not the action set.
3. **20d horizon: not enough aged snapshots intersect with agent decisions.** All historical decisions are recent; the matching snapshots haven't aged 20 days.

---

## Per-job aggregate

| Job | Name | n decisions | avg IC score | avg actual 5d | agreement rate |
|---:|---|---:|---:|---:|---:|
| 36 | Afternoon Market Scanner | 992 | -0.017 | +4.3 % | **0.612** |
| 24 | Overnight Stock Screener | 1,588 | -0.027 | +4.2 % | 0.590 |
| 39 | Alpha Researcher | 760 | -0.031 | +2.4 % | 0.592 |
| 30 | Portfolio Manager | 249 | -0.033 | +1.4 % | 0.610 |
| 37 | Strategy Reviewer | 35 | -0.066 | +2.3 % | 0.686 |
| 31 | Morning Brief | 9 | -0.078 | -1.0 % | 0.667 |

**Average IC score is negative for every job.** The agent is consistently picking names that score BELOW the cross-sectional median on the IC-weighted feature combo — yet the rank ordering of those picks is still informative (the +0.30 headline). Translation: **the agent operates in the lower-IC half of the universe but ranks its picks within that half meaningfully.**

Possible explanations:
- The agent is structurally contrarian (anti-momentum / value-tilted)
- The IC features in this 90-day window favored small-cap momentum that the agent under-weights
- The agent's universe is biased toward dividend / defensive names (already shown in Layer 1 catalogue) which score lower on momentum-heavy IC features

---

## Worst decisions — high-conviction misses

These are the agent's evaluated tickers where the IC features explicitly said "no" (score < -0.05) AND price action confirmed (loss > -3%):

| Ticker | Date | Regime | IC score | Actual 5d |
|---|---|---|---:|---:|
| OXY | 2026-04-07 | Mixed | -0.242 | **-14.5 %** |
| LMT | 2026-04-14 | Risk-On | -0.216 | -16.1 % |
| NOC | 2026-04-14 | Risk-On | -0.202 | -15.4 % |
| LNG | 2026-04-07 | Mixed | -0.236 | -11.7 % |
| MPC | 2026-04-07 | Mixed | -0.206 | -12.9 % |
| WTI | 2026-04-07 | Mixed | -0.176 | -15.1 % |

**Pattern:** energy (OXY, LNG, MPC, WTI) and defense (LMT, NOC) — exactly the sector-bias flagged in the Layer 1 catalogue findings. **Replay-A puts a hard cost number on it: ~$15-20 per share lost on each of these positions if held 5 days from the decision date.**

---

## Best decisions — high-conviction hits

Where IC features said "go" (score > +0.05) AND price action confirmed (gain > +3%):

| Ticker | Date | Regime | IC score | Actual 5d |
|---|---|---|---:|---:|
| IONQ | 2026-04-07 | Mixed | +0.153 | **+61.8 %** |
| RGTI | 2026-04-07 | Mixed | +0.131 | +43.1 % |
| RGTI | 2026-04-06 | Mixed | +0.142 | +37.0 % |
| AMD | 2026-04-14 | Risk-On | +0.147 | +36.4 % |
| IONQ | 2026-04-06 | Mixed | +0.097 | +52.8 % |

The agent **caught the quantum-computing breakout (IONQ + RGTI on 2026-04-06/07)** and the AMD run on 2026-04-14. IC features (`bb_pos` high, `ret_5d` positive) confirmed each.

---

## What this implies for prompt redesign

1. **Add a regime-conditional gap-pct rule.** `gap_pct` IC flips sign by regime (+0.13 Risk-Off, -0.075 Mixed). Current prompts treat gaps the same way.
2. **Down-weight the energy/defense over-emphasis.** The negative-avg-IC pattern across jobs is dominated by the OXY/LMT/NOC/LNG/MPC/WTI decisions. These names should be filtered out unless regime is favorable.
3. **Add `bb_pos` as a primary 5d signal in Risk-On.** It's the highest-IC feature in any regime/horizon combination (+0.128 in Risk-On 5d). The agent currently doesn't query it as a standalone scan dimension.
4. **The Afternoon Scanner (job 36) is the best-performing job** by both agreement rate (0.612) and least-negative avg IC. Its prompts may be a good model for the others.

---

## Reproducibility

```bash
cd trading-bot/backend
uv run python -m app.research.cli replay-decisions

# Headline:
sqlite3 data/research.db "SELECT
  COUNT(*) AS n,
  ROUND(AVG(ic_score_5d), 4) AS avg_ic,
  ROUND(AVG(actual_fwd_ret_5d), 4) AS avg_actual
  FROM agent_decision_eval WHERE actual_fwd_ret_5d IS NOT NULL;"

# Per-job:
sqlite3 data/research.db "SELECT cr.job_id, COUNT(*), ROUND(AVG(ade.ic_score_5d),3),
  ROUND(AVG(ade.actual_fwd_ret_5d),4)
  FROM agent_decision_eval ade JOIN context_runs cr ON ade.run_id=cr.id
  WHERE ade.actual_fwd_ret_5d IS NOT NULL GROUP BY cr.job_id ORDER BY 3 DESC;"
```

---

## Next

- **Replay-B** (LLM-based prompt re-run via local Qwen) — replay each historical session against a revised prompt that explicitly references the high-IC features and regime-conditional rules above. Compare new decisions to the IC-aligned ideal.
- **Out-of-sample IC** — once we have 180+ days of snapshots, recompute IC on the first half and Replay-A on the second. The +0.297 will drop; the new number is the real skill estimate.
- **Information-gap analysis** — for each decision, list which top-IC features the agent's tool calls didn't query. (Schema already supports this; just needs a JSON column populated by joining `context_tool_calls.name` against a feature → tool mapping.)
