# Replay-B v1 — GLM-5.1 with revised prompt vs IC-weighted baseline

**Date:** 2026-04-29
**What changed:** Replay-B harness shipped. For each of N decision dates, it pulls the candidate tickers the agent considered, computes rolling-30d IC at that date (leakage-safe), feeds the LLM a revised prompt with the IC table + candidate snapshots + Layer 1 / OOS heuristics (sector-bias correction, Afternoon Scanner pattern, regime-conditional rules), and asks for a per-ticker score in [-1, +1]. The same universe is also scored by the existing IC-weighted scorer — apples-to-apples baseline. Spearman ρ vs actual `fwd_ret_5d` for both methods, per date and pooled.

CLI: `replay-b --dates 2026-04-06,2026-04-07,2026-04-14 --model glm-5.1`. Reuses the repo's GLM-5.1 setup at z.ai's Anthropic-compatible endpoint (`GLM_BASE_URL`, `GLM_AUTH_TOKEN`).

---

## Headline

**The IC-weighted baseline beats GLM-5.1 with the revised prompt** at 2 of 3 dates and in the pooled aggregate.

| | LLM ρ | IC baseline ρ | n | LLM beats IC? |
|---|---:|---:|---:|---|
| 2026-04-06 (good case — IONQ/RGTI breakout) | +0.172 (p=0.04) | **+0.270** (p<0.01) | 140 | No |
| 2026-04-07 (bad case — OXY/LMT/NOC down 15%) | +0.096 (p=0.24) | **+0.244** (p<0.01) | 148 | No |
| 2026-04-14 (bad case — LMT/NOC) | **+0.154** (p=0.05) | +0.148 (p=0.06) | 162 | Marginally |
| **Pooled** | **+0.098** (p=0.04) | **+0.246** (p≈0) | 450 | No |

Both methods are statistically positive, so the LLM does have real predictive signal — but it is substantially weaker than just ranking by the rolling-30d IC-weighted score.

---

## Why the IC baseline wins (at these dates)

The 3 selected dates all happen to have favorable rolling-30d IC alignment. From the lookback sweep result earlier today, the rolling-30d Spearman over the full 28-date test period was +0.164. At these 3 specific dates, the in-window IC happens to be higher (averaging +0.22). The IC weights at those dates were not the regime-shifted ones the OOS analysis flagged — they were already adapted to the contemporaneous regime.

The LLM was given that same IC table as context and was instructed to weight features by |IC|. But it was *also* instructed to apply heuristic overrides:
- Sector bias correction (energy / defense down-weight in Risk-On / Mixed)
- Quantum/AI compute uplift (IONQ / RGTI / AMD / NVDA)
- Afternoon Scanner pattern preference

When the rolling IC is well-calibrated to current returns (as here), these heuristic overrides DEGRADE the signal — they pull the LLM's score away from the optimal IC-weighted ranking. The LLM is essentially second-guessing a good signal.

This matches what you'd expect from a small open-weights model (GLM-5.1) given a complex multi-rule prompt: it tries to apply all the rules, doesn't pick which to follow when, and ends up with a noisier ranking than the bare IC math.

---

## What this changes for the IC track

**The +0.164 rolling-30d headline is now the operating skill estimate, and it's the upper benchmark Replay-B would need to beat to justify a prompt-driven scorer over an IC-driven scorer.** At these 3 dates, +0.246 is what an IC-only ranker delivered; the LLM with a revised prompt delivered +0.098.

This is informative even though it's a "negative" result for Replay-B v1:

1. **The IC-weighted scorer is a stronger baseline than I expected.** When the rolling IC is regime-aligned, it produces ρ ≈ +0.25 with n ≈ 150 per date and p < 0.01. That is real, useful skill.

2. **A prompt that overrides a working signal makes things worse.** If we want the LLM to add value, the heuristic overrides need to be regime-conditional themselves — only activate the sector-bias correction when it's needed (e.g., at the start of a regime shift), not on every Risk-On / Mixed day.

3. **A more capable model might do better.** GLM-5.1 is small (production-tier but not frontier). The same prompt against Claude Opus 4.7 or Sonnet 4.6 would likely produce a tighter, more consistently calibrated scoring across 150 tickers. But that costs ~50× more per call.

---

## Implementation notes

**New module:** `trading-bot/backend/app/research/replay/replay_b.py` — `run_replay_b(dates, model, rolling_lookback_days)`. Loads snapshots, builds rolling IC cache, fetches candidates per date, builds prompt, calls z.ai endpoint via httpx, parses strict JSON, computes per-date and pooled Spearman for both LLM picks and IC baseline.

**CLI:** `replay-b --dates ... --model glm-5.1 [--max-candidates N]`. The `--max-candidates` flag is useful for fast smoke tests.

**Prompt design:** The system prompt embeds the full set of Layer 1 + OOS findings as calibration rules. The user message has three sections — decision date / inferred regime, top-15 IC table at this date, candidate ticker table with 13 features. Output schema is strict JSON with one entry per candidate.

**LLM cost (per date):**
- Input: ~10,500 tokens (regime + IC table + 150-ticker feature table + system)
- Output: ~5,000 tokens (150 picks × ~30 tokens each)
- Wall: ~90s per date on glm-5.1

**Endpoint:** z.ai's Anthropic-compatible endpoint (`https://api.z.ai/api/anthropic/v1/messages`). Reuses the `GLM_AUTH_TOKEN` env var the agent SDK already uses for fallback runs.

---

## Reproducibility

```bash
cd /Users/davidmcgregor/Documents/2_Code/2026/trading-bot/backend
set -a; source ../../telegram-claude-code/.env; set +a
uv run python -m app.research.cli replay-b \
  --dates 2026-04-06,2026-04-07,2026-04-14 \
  --model glm-5.1
```

Wall time: ~5–6 minutes for 3 dates. Cost: ~$0.04 total at GLM-5.1 list pricing.

---

## What to try next on this track

1. **Replay-B with Claude Sonnet 4.6** — same prompt, run side-by-side. Expensive (~50× the LLM cost) but will tell us whether the LLM's failure here is "small model can't follow complex calibration" or "the prompt's heuristic overrides are intrinsically wrong."

2. **Simplify the prompt** — strip the Layer 1 / OOS heuristics, give the LLM ONLY the IC table and the candidate features. See if a "pure IC reasoner" can match the IC baseline (i.e., is the LLM useful at all when its job is just "do the IC math").

3. **Make the heuristics regime-conditional** — only invoke the sector-bias correction when the rolling-30d IC for sector-correlated features (e.g. macd_hist, bb_pos for energy) is contradictory or near zero. Currently the prompt applies the heuristic unconditionally.

4. **Reverse the bar test** — at dates where the rolling IC is poorly calibrated (the 60d/90d sweep showed many such days), does the LLM do better than the IC baseline? Pick 2-3 such dates and re-run.

The cleanest next move is **(2) — strip the prompt down to "use the IC table"** and see if the LLM can at least match the IC baseline when its instructions don't fight it. If yes, we have the lowest-power LLM ranker. If no, prompt-driven LLM scoring isn't competitive with direct IC math at this scale.

---

## Files changed

- `trading-bot/backend/app/research/replay/replay_b.py` — new
- `trading-bot/backend/app/research/cli.py` — added `replay-b` subcommand

No persistence yet (results print as JSON and live in this doc + the local log). If the harness becomes routine, add a `replay_b_runs` table for run history.
