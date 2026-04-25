# Layer 1 — Agent Context Catalogue Findings

**Date:** 2026-04-25
**Source:** First 500 Claude Code session JSONL files (most recent), of which 158 cross-reference to a `job_runs` row (jobs 24/30/31/36/37/38/39 — the trading jobs).
**Universe used for symbol filtering:** iShares IWV CSV → 2,584 Russell 3000 tickers, hash `0fd72e5b4e2895bf`.

---

## Top-line counts

| Metric | Value |
|---|---|
| Sessions cataloged | 500 |
| Trading-job sessions | 158 |
| Tool calls (excluding `_tool_result`) | 10,394 |
| Web searches | 912 |
| Knowledge-file reads | 415 |
| Symbol mentions (after Russell-3000 filter + finance-keyword co-occurrence) | 12,003 |

---

## Tool-use distribution (top 20, ex. `_tool_result`)

| Tool | Calls | Notes |
|---|---:|---|
| `mcp__trading-bot__market_scan` | 1,455 | Universe scanner — most-used trading tool |
| `Bash` | 1,121 | General shell — likely script triggers, not trading-specific |
| `WebSearch` | 912 | **Significantly higher than the prior "~8 searches" claim** — that estimate was wrong |
| `mcp__trading-bot__analyze_symbol` | 826 | Per-ticker analysis |
| `Read` | 774 | File reads (knowledge + scan files) |
| `ToolSearch` | 471 | Deferred-tool loader — overhead, not domain |
| `mcp__trading-bot__get_sentiment` | 387 | Sentiment per ticker |
| `mcp__trading-bot__get_options_flow` | 346 | Options unusual flow |
| `mcp__web-search-prime__web_search_prime` | 315 | Alternative web search |
| `mcp__agent-tools__knowledge_read` | 196 | Knowledge tool wrapper |
| `mcp__trading-bot__get_fundamentals` | 179 | Fundamentals lookups |
| `mcp__trading-bot__regime_matched_backtest` | 171 | Backtest scoped to current regime |
| `mcp__agent-tools__telegram_send_message` | 170 | Notification side-effects |
| `mcp__trading-bot__intelligence_scan` | 142 | News/sentiment scan |
| `mcp__agent-tools__knowledge_write` | 139 | Persisting findings |
| `mcp__web-reader__webReader` | 130 | Page-fetch tool |
| `mcp__trading-bot__get_market_regime` | 128 | Regime lookup |
| `mcp__trading-bot__get_calendar` | 115 | Economic calendar |
| `mcp__trading-bot__composite_backtest` | 113 | Multi-strategy backtest |
| `WebFetch` | 110 | Generic page fetch |

**Trading-bot MCP dominates** (~5,000 calls across that namespace). The agent leans heavily on the in-house tools rather than web search. But `WebSearch` is still substantial (912) — the early estimate of "~8" was off by two orders of magnitude.

---

## Top symbols (after Russell-3000 ticker-set filter + finance-keyword co-occurrence)

| Symbol | Mentions | Source mix | Note |
|---|---:|---|---|
| P | 5,598 | co_occurrence | Likely false positive — the letter "P" inside prose. **Demote single-letter tickers in v2 of extractor.** |
| JNJ | 4,805 | mixed | Healthcare bias |
| MRK | 4,204 | mixed | Healthcare bias |
| NVDA | 3,956 | mixed | AI megacap |
| GOOGL | 3,841 | mixed | Megacap tech |
| S | 3,614 | co_occurrence | Single-letter false positive (could be SentinelOne but most likely "S" in prose) |
| T | 3,153 | mixed | AT&T (dividend bias) — plausible high count |
| MSFT | 2,968 | mixed | |
| AMD | 2,499 | mixed | Semis |
| NEE | 2,312 | mixed | Utilities |
| XOM | 2,192 | mixed | Energy bias |
| HAL | 2,019 | mixed | Energy services |
| VLO | 1,959 | mixed | Refining |
| AMT | 1,930 | mixed | REIT (matches the historical AMT trade) |
| ABBV | 1,905 | mixed | Healthcare |
| TSLA | 1,850 | mixed | |
| WTI | 1,729 | co_occurrence | Crude oil mention vs. ticker WTI Inc — ambiguous |
| AMZN | 1,652 | mixed | |
| GILD | 1,544 | mixed | Healthcare |
| L | 1,529 | co_occurrence | Loews (single-letter, likely noise) |

**Bias signals visible:**
- **Healthcare obsession**: JNJ, MRK, ABBV, GILD all in top 20 — mirrors the prior comment about the agent over-weighting dividend/defensive names.
- **Energy cluster**: XOM, HAL, VLO, EOG (off-list) — consistent with the "consecutive days strategy" + USO trade in JOURNAL.md.
- **Megacap tech is present but not dominant** vs healthcare/dividend.
- **Single-letter false positives** (P, S, L, U) suggest the extractor needs further tightening — recommend min length = 2 for "co_occurrence" path in v2.

---

## Web search queries — sample (912 total)

The agent IS doing real research. Sample queries (these are NOT the prior "8 searches across all sessions" claim — that was wrong):

```
CRWD CrowdStrike Reddit wallstreetbets sentiment April 2026
AAPL Apple leadership Tim Cook John Ternus sentiment StockTwits April 2026
NVDA NVIDIA earnings catalyst Reddit April 2026
AMD Advanced Micro Devices social media sentiment April 2026
WMT JPM AAPL GS insider trading April 2026
"earnings calendar" "April 28" "April 29" "April 30" 2026
SPY VIX market close April 24 2026
```

**Pattern:** Most searches are "{ticker(s)} {qualifier} April 2026" — sentiment/Reddit/insider/earnings. The agent IS reaching outside the trading-bot MCP for sentiment/news context.

---

## Knowledge-file reads (top 10)

| File | Reads |
|---|---:|
| `knowledge/trading/REGIME.md` | 65 |
| `knowledge/trading/SCOREBOARD.md` | 51 |
| `knowledge/trading/RESEARCH.md` | 36 |
| `knowledge/trading/LESSONS.md` | 35 |
| `knowledge/trading/PLAYBOOK.md` | 34 |
| `knowledge/trading/JOURNAL.md` | 13 |
| `knowledge/MORNING-BRIEF.md` | 9 |
| `knowledge/trading/MODELS.md` | 6 |
| `knowledge/trading/scans/scan-2026-04-07-0200.md` | 4 |
| `knowledge/trading/scans/2026-04-16-0200.md` | 4 |

**REGIME.md** is the most-read knowledge file — the agent does check the regime context before deciding. `SCOREBOARD.md` and `PLAYBOOK.md` also reasonably high. `JOURNAL.md` is read only 13 times across 500 sessions, despite being the lessons-learned log — possible bias finding for prompt revision.

There's also some duplicate read paths (`2-Code` vs `2_Code`) — early sessions were on a different path. Will dedupe in IC analysis.

---

## Job → session distribution

| Job ID | Job name | Sessions in last 500 |
|---:|---|---:|
| 39 | Alpha Researcher | 62 |
| 24 | Overnight Stock Screener | 29 |
| 30 | Portfolio Manager | 21 |
| 36 | Afternoon Market Scanner | 20 |
| 31 | Morning Brief | 17 |
| 38 | ML Trainer | 5 |
| 37 | Strategy Reviewer | 4 |

Alpha Researcher is the single most-active job. Strategy Reviewer is the rarest — possible candidate for more frequent runs.

---

## Findings to feed into Phase D (agent eval)

1. **Bias toward healthcare + energy + dividend names.** Top 20 symbols are dominated by JNJ/MRK/ABBV/GILD/XOM/HAL/VLO/T/AMT — many are not in current high-IC factor strategies. Once factor IC numbers exist (EPIC C), check whether these names actually score well on the IC-discovered factors, or whether the agent is biased toward a stale playbook.
2. **WebSearch is 912 calls** — useful, but worth checking what fraction are sentiment-related vs catalyst/news vs other. Future extractor enhancement.
3. **Knowledge-file reads concentrate on REGIME.md** — the agent IS regime-aware. Good. But JOURNAL.md (the lessons file) is rarely read. Worth flagging in prompt redesign.
4. **High-precision symbol extraction is undercounting** (only 42 tool_arg-source rows). Reason: most MCP calls have `symbol` nested inside an `input` dict; the shallow walk misses some. Already partially fixed in v2 of extractor but more work could yield cleaner data.
5. **Single-letter "tickers"** (P, S, L, U) need to be excluded from co-occurrence path. Easy v2 fix.

---

## Reproducibility

```bash
cd trading-bot/backend
uv run python -m app.research.cli universe-load
uv run python -m app.research.cli catalogue-traces --max-sessions 500
sqlite3 data/research.db "SELECT name, COUNT(*) FROM context_tool_calls WHERE name != '_tool_result' GROUP BY name ORDER BY 2 DESC LIMIT 30;"
sqlite3 data/research.db "SELECT symbol, source, SUM(mention_count) AS m FROM context_symbols GROUP BY symbol ORDER BY m DESC LIMIT 30;"
```
