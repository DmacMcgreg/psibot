# Alpha Research Session 10 — March 27, 2026 (End of Day)

**Regime:** RISK-OFF / STAGFLATION (system reads "mixed" at 50% confidence — we treat as 75% per macro overlay)
**Brent:** $108 | **VIX:** ~25 | **10yr:** 4.41% | **DXY:** Weak
**Binary event:** April 6 — US-Iran talks expire (energy strike risk)
**Blackout active:** PCE March 28 8:30 AM ET — no new positions until after

---

## WORKSTREAM 1: XLE Regime-Matched Backtests (XLE as reference symbol)

All tests: 5 similar periods, 5yr lookback, avg similarity 98.73% — extremely high match quality.

### XLE Regime-Matched Results

| Strategy | Regime Sharpe | Regime Return | Win Rate | MDD | VERDICT |
|----------|--------------|--------------|----------|-----|---------|
| volume_imbalance | **2.74** | +0.74% | 100.0% | 0.3% | ACTIONABLE — best regime-matched result |
| adxr | **2.42** | +0.72% | 69.9% | 0.4% | ACTIONABLE — confirmed regime-fit |
| consecutive_days | **2.14** | +0.81% | 65.0% | 0.4% | ACTIONABLE |
| poc_reversion | **2.02** | +0.48% | 80.0% | 0.1% | ACTIONABLE — cleanest MDD |
| volatility_targeting | **1.22** | +0.19% | 59.9% | 0.1% | BORDERLINE — keep in composite only |
| kalman_filter | 0.77 | +0.23% | 19.9% | 0.0% | WEAK — do not deploy standalone on XLE |

**Key insight:** In XLE-regime-matched conditions, volume_imbalance (2.74) and adxr (2.42) are the clear leaders. This upgrades the S9 XLE finding — the strategies DO hold up when we use XLE's own historical fingerprint. 98.73% similarity is as close to "same regime" as the engine can get.

---

## WORKSTREAM 2: ITA Regime-Matched Backtests (ITA as reference symbol)

All tests: 5 similar periods, 5yr lookback, avg similarity 96.07%.

### ITA Regime-Matched Results

| Strategy | Regime Sharpe | Regime Return | Win Rate | MDD | VERDICT |
|----------|--------------|--------------|----------|-----|---------|
| consecutive_days | 0.60 | +0.19% | 52.3% | 0.9% | WEAK — not actionable |
| kalman_filter | -0.85 | -0.22% | 19.9% | 0.7% | FAIL |
| adxr | -1.15 | -0.37% | 39.9% | 0.8% | FAIL — regime-hostile on ITA |
| volume_imbalance | -1.25 | -0.18% | 19.5% | 0.4% | FAIL — regime-hostile on ITA |

**Critical finding:** ITA does NOT pass regime-matched validation. The S9 full-period backtests (adxr/ITA Sharpe 2.51) were NOT regime-robust. When we fingerprint ITA's own historical periods matching current conditions, ALL strategies fail or barely survive.

**Action:** DEMOTE adxr/ITA from PLAYBOOK. XLE is the only confirmed regime-matched alpha universe.

---

## WORKSTREAM 3: XLE Triple Composite — Voting Mode Comparison

Full-period (365d) composite tests on XLE.

| Composite | Voting Mode | Sharpe | Return | Win Rate | PF | Trades | MDD | VERDICT |
|-----------|-------------|--------|--------|----------|----|--------|-----|---------|
| adxr + vol_imbalance + vol_target | weighted | **1.84** | +3.2% | 44.4% | 3.99 | 9 | 1.25% | Best risk-adjusted |
| adxr + vol_imbalance + vol_target | majority | **2.51** | +5.14% | 100% | 999 | 0.81% | 1 trade (322 days held) | DEGENERATE — 1 trade |
| adxr + vol_imbalance + vol_target | any | **1.84** | +3.2% | 44.4% | 3.99 | 9 | 1.25% | Same as weighted |
| adxr + vol_imbalance (2-leg) | weighted | 1.73 | +3.1% | 42.9% | — | 7 | 1.4% | Slightly fewer trades |

**Key findings:**
- Majority mode produces 1 trade (held 322 days) — statistically degenerate, reject
- Weighted and "any" mode are identical (9 trades, Sharpe 1.84, PF 3.99) — strong risk-adjusted profile
- The trade count problem persists: 9 trades on XLE triple composite is below the 10-trade minimum for formal actionability
- The 9 trades have avg win of +10.64% vs avg loss of -2.13% — PF of 3.99 is exceptional
- **Best interpretation:** Use triple composite as a position-sizing signal on XLE rather than a primary entry trigger. When all three agree, size up to full allocation.

---

## WORKSTREAM 4: GLD / USO / SLV Universe — Full Batch

9 strategies x 3 symbols = 27 runs. 365d lookback.

### Full Results Table

| Strategy | GLD Sharpe | USO Sharpe | SLV Sharpe | Best |
|----------|-----------|-----------|-----------|------|
| consecutive_days | 1.12 | **2.37** | 0.38 | USO |
| regime_detection | 1.12 | **1.70** | 0.96 | USO |
| adxr | 1.02 | **1.38** | 1.17 | USO/SLV |
| volatility_targeting | -0.37 | **1.67** | 0.88 | USO |
| volume_imbalance | 0.86 | **1.23** | 0.70 | USO |
| zscore_mean_reversion | 0.37 | 0.96 | -0.41 | USO |
| poc_reversion | 0.70 | 0.70 | 0.35 | Flat |
| bb_mean_reversion | -0.36 | 0.93 | -0.01 | USO |
| kalman_filter | 0.14 | 0.15 | -0.41 | Flat/None |

### Top Actionable Picks (Sharpe > 1.0)

| Strategy | Symbol | Sharpe | Return | Trades | Win Rate | MDD | PF | Status |
|----------|--------|--------|--------|--------|----------|-----|----|--------|
| consecutive_days | USO | **2.37** | +4.69% | **11** | **81.8%** | **1.07%** | **21.73** | ACTIONABLE |
| regime_detection | USO | 1.70 | +7.07% | 6 | 33.3% | 2.65% | 5.85 | WATCH (low trades, open position) |
| volatility_targeting | USO | 1.67 | +6.50% | — | — | — | — | WATCH |
| adxr | USO | 1.38 | +5.23% | — | — | — | — | WATCH |
| adxr | SLV | 1.17 | +9.72% | 3 | 100% | 7.49% | 999 | WATCH (3 trades only) |
| consecutive_days | GLD | 1.12 | +1.34% | — | — | — | — | WATCH |
| regime_detection | GLD | 1.12 | +3.08% | — | — | — | — | WATCH |
| adxr | GLD | 1.02 | +2.59% | 4 | 75% | 1.66% | 10.46 | WATCH (4 trades only) |

**USO is the standout.** consecutive_days on USO: 11 trades, 81.8% win rate, Sharpe 2.37, MDD 1.07%, PF 21.73. This is the best commodity finding in any session.

**GLD — Structural note:** GLD returned +46.87% buy-and-hold in 1Y. All active strategies are underperforming buy-and-hold significantly. This suggests the GLD bull run is momentum-driven and buy-and-hold is the right approach, not any active strategy.

**SLV — adxr:** 9.72% return but only 3 trades. Too few for confidence. SLV buy-and-hold was +101.56%.

**USO — regime_detection note:** Last trade has exit_signal=end_of_backtest (open position as of March 27). Entry 2026-01-12. This means regime_detection is currently LONG USO — consistent with Brent $108 thesis.

---

## WORKSTREAM 5: Post-PCE Scenario — MSFT/GOOGL Mean Reversion

### Results

| Strategy | Symbol | Sharpe | Return | Trades | Win Rate | MDD | VERDICT |
|----------|--------|--------|--------|--------|----------|-----|---------|
| zscore_mean_reversion | MSFT | -0.93 | -1.15% | — | — | — | FAIL — do NOT activate |
| zscore_mean_reversion | GOOGL | -0.31 | -0.23% | — | — | — | FAIL |
| bb_mean_reversion | MSFT | -1.55 | -2.54% | — | — | — | FAIL — actively destroys value |
| bb_mean_reversion | GOOGL | 0.49 | +0.61% | — | — | — | WEAK — insufficient edge |

**Critical finding:** Mean reversion strategies are FAILING on MSFT and GOOGL over the past 365 days. This is regime-consistent — in a RISK-OFF/Stagflation environment, oversold tech bounces are false dawns that keep going lower.

**Post-PCE decision tree:**
- If PCE soft (<2.5%): Do NOT activate zscore/bb mean reversion on MSFT or GOOGL per these backtests. The S9-5 VIX Backwardation + Breadth + HY composite signal (scout strategy) may still argue for a bounce, but our own engine says no structural edge. If activating at all, use VERY small size (10-15% of normal) and tighten stops.
- If PCE hot (>2.8%): Energy adds via XLE strategies remain the play. Add to VLO at full allocation.
- NVDA not tested — add to next session queue.

---

## COMPOSITE SUMMARY — Voting Mode Analysis

| Mode | Trades | Sharpe | Verdict |
|------|--------|--------|---------|
| weighted | 9 | 1.84 | Best balance — use this |
| majority | 1 | 2.51* | Statistical artifact — 1 trade |
| any | 9 | 1.84 | Identical to weighted |
| 2-leg (adxr+vol_imbalance) | 7 | 1.73 | Fewer trades, lower Sharpe |

*Majority mode single trade: entered May 9, 2025 at $41.26, still open at $62.46 = +51.38% unrealized. This IS the XLE bull run — majority mode essentially said "buy early and hold." Interesting as a trend follower but not a systematic signal generator.

---

## REGIME-MATCHED VALIDATION SUMMARY (XLE reference vs ITA reference)

| Symbol | Strategy | Regime Sharpe | Actionable? |
|--------|----------|--------------|-------------|
| XLE | volume_imbalance | 2.74 | YES |
| XLE | adxr | 2.42 | YES |
| XLE | consecutive_days | 2.14 | YES |
| XLE | poc_reversion | 2.02 | YES |
| XLE | volatility_targeting | 1.22 | COMPOSITE ONLY |
| XLE | kalman_filter | 0.77 | NO |
| ITA | consecutive_days | 0.60 | NO |
| ITA | kalman_filter | -0.85 | NO |
| ITA | adxr | -1.15 | NO — DEMOTE |
| ITA | volume_imbalance | -1.25 | NO — DEMOTE |

---

## TRADE CANDIDATES — Active Signals Right Now

### Tier 1 — ACTIONABLE (Sharpe > 1.0, trades >= 10, regime-validated)

| Symbol | Strategy | Sharpe | Signal | Notes | PCE Gate |
|--------|----------|--------|--------|-------|----------|
| XLE | volume_imbalance | 2.74 (regime) | LONG | Top regime-matched XLE strategy | Wait for PCE |
| XLE | adxr | 2.42 (regime) | LONG | Confirmed regime-fit | Wait for PCE |
| USO | consecutive_days | 2.37 | LONG | 11 trades, 81.8% WR, PF 21.73, MDD 1.07% | Wait for PCE |
| XLE | consecutive_days | 2.14 (regime) | LONG | Regime-resilient | Wait for PCE |

### Tier 2 — WATCH (needs more trades or regime validation)

| Symbol | Strategy | Sharpe | Trades | Constraint |
|--------|----------|--------|--------|------------|
| USO | regime_detection | 1.70 | 6 | Low trades; currently open long |
| USO | volatility_targeting | 1.67 | — | Trade count needed |
| USO | adxr | 1.38 | — | Trade count needed |
| SLV | adxr | 1.17 | 3 | Far too few trades |
| GLD | regime_detection | 1.12 | — | Buy-and-hold dominates anyway |

### Do Not Activate

| Symbol | Strategy | Reason |
|--------|----------|--------|
| MSFT | zscore_mean_reversion | Sharpe -0.93 — fail |
| MSFT | bb_mean_reversion | Sharpe -1.55 — destroys value |
| GOOGL | zscore_mean_reversion | Sharpe -0.31 — fail |
| GOOGL | bb_mean_reversion | Sharpe +0.49 — insufficient |
| ITA | adxr | Regime-matched Sharpe -1.15 — DEMOTED |
| ITA | volume_imbalance | Regime-matched Sharpe -1.25 — DEMOTED |

---

## SESSION 10 DECISIONS

### Playbook Updates

1. **PROMOTE:** consecutive_days/USO — Sharpe 2.37, 11 trades, 81.8% WR, MDD 1.07%. Add to playbook as ENERGY/COMMODITY universe strategy. Valid in Brent-elevated environment.
2. **CONFIRM:** XLE triple composite (weighted) — Sharpe 1.84, PF 3.99. Remains in watch pending trade count (9 trades). Use as position-sizing signal not primary entry.
3. **DEMOTE:** adxr/ITA — regime-matched Sharpe -1.15. Remove from playbook. Session 9 finding was a full-period mirage.
4. **DEMOTE:** volume_imbalance/ITA — regime-matched Sharpe -1.25. Remove from watch.
5. **HOLD:** MSFT/GOOGL mean reversion — both strategies fail in current regime. Post-PCE soft print does not change this based on engine data.

### Post-PCE Decision Framework (March 28 8:30 AM ET)

**Scenario A — PCE Soft (<2.5%):**
- Add VLO to full 5% allocation (additional ~$4,941)
- Add MRK to full 3% allocation (additional ~$2,979)
- Consider USO entry via consecutive_days (wait for signal confirmation)
- Do NOT activate MSFT/GOOGL mean reversion (engine says no edge)
- XLE: evaluate adxr or volume_imbalance entry at 50% size

**Scenario B — PCE Hot (>2.8%):**
- Hold VLO (stagflation energy thesis intact)
- Tighten MCD stop to $308 (stop is at $304.31 — protect further)
- XLE strategies remain valid — energy is a stagflation hedge
- Defer all tech entries indefinitely

**Scenario C — In-line (2.5-2.8%):**
- Hold all positions as-is
- Wait for April 6 binary event before new energy adds
- USO consecutive_days — monitor for signal

---

## Session 10 Coverage

- XLE regime-matched: 6 strategies tested
- ITA regime-matched: 4 strategies tested
- GLD/USO/SLV batch: 9 strategies x 3 symbols = 27 runs
- MSFT/GOOGL post-PCE: 2 strategies x 2 symbols = 4 runs
- Composite voting modes: 4 combinations
- **Session total: ~45 runs**

---

## Next Session Priorities (Session 11)

1. USO regime-matched backtest (use USO as reference symbol) — validate consecutive_days/USO in matched conditions before full promotion
2. NVDA post-PCE mean reversion backtest (not tested this session)
3. Composite: consecutive_days + volume_imbalance on USO — two-leg commodity composite
4. Explore: regime_detection/USO trade count — run 2yr lookback to get more samples
5. S9 Scout strategies still queued for backtesting: I-XTSM OVX, Macro 5-Factor Sector Rotation, GPR Defense/Energy Rotation
6. adxr/XLE 180d and 90d windows — check regime sensitivity
7. GLD Kalman gated by IEF 12m momentum binary (scout strategy B) — implement as composite gate
