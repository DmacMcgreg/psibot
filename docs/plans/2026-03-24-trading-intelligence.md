# Trading Intelligence System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect psibot to the trading bot backend (localhost:8000) via an MCP server, add specialized trading subagents with visual chart analysis, create focused scheduled jobs, and build a self-improving knowledge feedback loop.

**Architecture:** A Trading Bot MCP server wraps the backend's 100+ API endpoints into typed Claude tools. Five trading subagents (Technical Analyst, Fundamental Analyst, Macro Strategist, Sentiment Scout, Quant Researcher) run in parallel during market scans. Scheduled jobs orchestrate daily analysis, portfolio management, strategy review, ML training, and alpha research. A `knowledge/trading/` directory stores evolving playbooks, journals, and lessons that feed back into all jobs.

**Tech Stack:** Bun, Claude Agent SDK (MCP server + subagents + query), Trading Bot API (localhost:8000, FastAPI/Python), agent-browser (chart screenshots), Grammy (Telegram delivery)

**Backend API reference:** http://localhost:8000/docs (Swagger UI)

**Key paths:**
- Trading MCP server: `src/agent/trading-mcp.ts`
- Trading subagents: `src/agent/subagents.ts` (extend existing)
- Knowledge: `knowledge/trading/` (PLAYBOOK.md, JOURNAL.md, REGIME.md, LESSONS.md, RESEARCH.md, MODELS.md)
- Existing portfolio tools: `src/agent/tools.ts:773+`
- Existing jobs: DB jobs table (IDs 24, 30, 31)

**Depends on:** Trading bot backend running at localhost:8000 (already running), existing paper portfolio schema in DB.

---

## Task 1: Trading Bot MCP Server — Core Tools

**Files:**
- Create: `src/agent/trading-mcp.ts`

**Step 1: Create the MCP server with core trading tools**

This wraps the most-used backend endpoints. The agent can `fetch()` any other endpoint directly for ad-hoc analysis.

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("mcp:trading");
const BASE_URL = "http://localhost:8000/api/v1";

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Trading API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

export function createTradingMcpServer() {
  return createSdkMcpServer({
    name: "trading-bot",
    version: "1.0.0",
    tools: {

      // --- Market Analysis ---

      ...tool(
        "market_scan",
        "Run batch technical analysis on multiple symbols. Returns RSI, MACD, Bollinger Bands, SMAs, ATR, volume, trend assessment, and signals for each symbol.",
        {
          symbols: z.array(z.string()).describe("Stock ticker symbols to analyze"),
        },
        async (args) => {
          try {
            const query = args.symbols.map((s) => `symbols=${s}`).join("&");
            const data = await api(`/analysis/batch?${query}`);
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Market scan failed: ${e}`);
          }
        }
      ),

      ...tool(
        "analyze_symbol",
        "Deep analysis of a single symbol: confluence scoring (multi-timeframe alignment), technical analysis, support/resistance levels, and unified signal strength.",
        {
          symbol: z.string().describe("Stock ticker symbol"),
        },
        async (args) => {
          try {
            const [confluence, signal] = await Promise.all([
              api(`/analysis/confluence/${args.symbol}`),
              api(`/signals/${args.symbol}`),
            ]);
            return ok(JSON.stringify({ confluence, signal }, null, 2));
          } catch (e) {
            return err(`Symbol analysis failed: ${e}`);
          }
        }
      ),

      ...tool(
        "get_opportunities",
        "Get today's ranked trading opportunities from the backend's opportunity scanner. Returns scored and ranked setups across the stock universe.",
        {},
        async () => {
          try {
            const data = await api("/opportunities/today");
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Opportunities fetch failed: ${e}`);
          }
        }
      ),

      ...tool(
        "get_briefing",
        "Get today's market briefing: market regime, sector analysis, notable movers, economic calendar, and key levels.",
        {},
        async () => {
          try {
            const data = await api("/briefings/today");
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Briefing fetch failed: ${e}`);
          }
        }
      ),

      // --- Sentiment & Intelligence ---

      ...tool(
        "get_sentiment",
        "Get sentiment analysis for a symbol: news sentiment, social sentiment, aggregated score, and recent headlines.",
        {
          symbol: z.string().describe("Stock ticker symbol"),
        },
        async (args) => {
          try {
            const [aggregated, news] = await Promise.all([
              api(`/sentiment/${args.symbol}/aggregated`),
              api(`/sentiment/${args.symbol}/news`),
            ]);
            return ok(JSON.stringify({ aggregated, news }, null, 2));
          } catch (e) {
            return err(`Sentiment fetch failed: ${e}`);
          }
        }
      ),

      ...tool(
        "get_trending",
        "Get trending tickers from social media and news sources. Shows what retail and institutions are watching.",
        {},
        async () => {
          try {
            const data = await api("/sentiment/trending");
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Trending fetch failed: ${e}`);
          }
        }
      ),

      ...tool(
        "intelligence_scan",
        "Run a cross-source intelligence scan: news, sentiment, calendar events, and market signals combined into actionable intelligence.",
        {
          symbols: z.array(z.string()).optional().describe("Optional symbols to focus on"),
        },
        async (args) => {
          try {
            const data = await api("/intelligence/scan", {
              method: "POST",
              body: JSON.stringify({ symbols: args.symbols ?? [] }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Intelligence scan failed: ${e}`);
          }
        }
      ),

      // --- Calendar & Macro ---

      ...tool(
        "get_calendar",
        "Get upcoming economic events: Fed meetings, jobs reports, CPI, GDP, earnings. Includes impact ratings and affected sectors.",
        {
          days: z.number().optional().describe("Days ahead to look (default 7)"),
        },
        async (args) => {
          try {
            const data = await api(`/calendar/upcoming?days=${args.days ?? 7}`);
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Calendar fetch failed: ${e}`);
          }
        }
      ),

      ...tool(
        "get_market_regime",
        "Get current market regime assessment: risk-on/off, volatility state, sector rotation, and event attribution.",
        {},
        async () => {
          try {
            const data = await api("/calendar/attribution/enhanced");
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Market regime fetch failed: ${e}`);
          }
        }
      ),

      // --- Fundamentals ---

      ...tool(
        "get_fundamentals",
        "Get fundamental data for symbols: revenue, margins, earnings, P/E, PEG, analyst ratings, insider activity.",
        {
          symbols: z.array(z.string()).describe("Stock ticker symbols"),
        },
        async (args) => {
          try {
            const query = args.symbols.map((s) => `symbols=${s}`).join("&");
            const data = await api(`/fundamentals/batch?${query}`);
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Fundamentals fetch failed: ${e}`);
          }
        }
      ),

      // --- Options ---

      ...tool(
        "get_options_flow",
        "Get options analysis for a symbol: unusual flow, put/call ratio, max pain, IV percentile, GEX regime.",
        {
          symbol: z.string().describe("Stock ticker symbol"),
        },
        async (args) => {
          try {
            const [analysis, flow, pcr, maxpain, iv, gex] = await Promise.all([
              api(`/options/analysis/${args.symbol}`).catch(() => null),
              api(`/options/flow/${args.symbol}`).catch(() => null),
              api(`/options/pcr/${args.symbol}`).catch(() => null),
              api(`/options/maxpain/${args.symbol}`).catch(() => null),
              api(`/options/iv/${args.symbol}`).catch(() => null),
              api(`/options/gex/${args.symbol}`).catch(() => null),
            ]);
            return ok(JSON.stringify({ analysis, flow, pcr, maxpain, iv, gex }, null, 2));
          } catch (e) {
            return err(`Options flow failed: ${e}`);
          }
        }
      ),

      // --- Portfolio ---

      ...tool(
        "trading_portfolio",
        "Get current portfolio status from the trading bot backend: positions, exposure, P/L.",
        {},
        async () => {
          try {
            const [portfolio, exposure] = await Promise.all([
              api("/portfolio"),
              api("/portfolio/exposure"),
            ]);
            return ok(JSON.stringify({ portfolio, exposure }, null, 2));
          } catch (e) {
            return err(`Portfolio fetch failed: ${e}`);
          }
        }
      ),

      // --- Backtesting ---

      ...tool(
        "run_backtest",
        "Run a backtest for a strategy on given symbols. Returns performance metrics, trade log, and equity curve.",
        {
          strategy: z.string().describe("Strategy name (e.g. 'technical_momentum', 'rsi_mean_reversion', 'turtle_system1')"),
          symbols: z.array(z.string()).describe("Symbols to backtest on"),
          days: z.number().optional().describe("Lookback period in days (default 365)"),
        },
        async (args) => {
          try {
            const data = await api("/backtest/run", {
              method: "POST",
              body: JSON.stringify({
                strategy_name: args.strategy,
                symbols: args.symbols,
                lookback_days: args.days ?? 365,
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Backtest failed: ${e}`);
          }
        }
      ),

      ...tool(
        "compare_strategies",
        "Compare multiple strategies side-by-side on the same symbols. Returns comparative metrics.",
        {
          strategies: z.array(z.string()).describe("Strategy names to compare"),
          symbols: z.array(z.string()).describe("Symbols to test on"),
          days: z.number().optional().describe("Lookback period in days (default 365)"),
        },
        async (args) => {
          try {
            const data = await api("/backtest/compare", {
              method: "POST",
              body: JSON.stringify({
                strategy_names: args.strategies,
                symbols: args.symbols,
                lookback_days: args.days ?? 365,
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Strategy comparison failed: ${e}`);
          }
        }
      ),

      ...tool(
        "list_strategies",
        "List all available backtest strategies with descriptions and parameters.",
        {},
        async () => {
          try {
            const data = await api("/backtest/strategies");
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Strategy list failed: ${e}`);
          }
        }
      ),

      // --- ML Pipeline ---

      ...tool(
        "ml_predict",
        "Get ML model predictions for symbols: direction, confidence, contributing features.",
        {
          symbols: z.array(z.string()).describe("Symbols to predict"),
        },
        async (args) => {
          try {
            const query = args.symbols.map((s) => `symbols=${s}`).join("&");
            const data = await api(`/ml/predict/batch?${query}`);
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`ML prediction failed: ${e}`);
          }
        }
      ),

      ...tool(
        "ml_train",
        "Trigger ML model training cycle with latest data. Returns training metrics and accuracy changes.",
        {},
        async () => {
          try {
            const data = await api("/ml/pipeline/train", { method: "POST" });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`ML training failed: ${e}`);
          }
        }
      ),

      ...tool(
        "ml_accuracy",
        "Get ML model accuracy report: overall accuracy, accuracy by confidence level, accuracy by indicator, feature importances.",
        {},
        async () => {
          try {
            const [accuracy, byConfidence, byIndicator, features] = await Promise.all([
              api("/accuracy/overall"),
              api("/accuracy/by-confidence"),
              api("/accuracy/by-indicator"),
              api("/ml/pipeline/features"),
            ]);
            return ok(JSON.stringify({ accuracy, byConfidence, byIndicator, features }, null, 2));
          } catch (e) {
            return err(`ML accuracy report failed: ${e}`);
          }
        }
      ),

      // --- Strategy Evaluation ---

      ...tool(
        "evaluate_strategies",
        "Run strategy evaluation: rankings, benchmarks, and performance history. Shows which strategies are currently performing best.",
        {},
        async () => {
          try {
            const [rankings, benchmarks] = await Promise.all([
              api("/evaluation/rankings"),
              api("/evaluation/benchmarks"),
            ]);
            return ok(JSON.stringify({ rankings, benchmarks }, null, 2));
          } catch (e) {
            return err(`Strategy evaluation failed: ${e}`);
          }
        }
      ),

      // --- Reports ---

      ...tool(
        "generate_report",
        "Generate a comprehensive analysis report for a symbol combining all data sources.",
        {
          symbol: z.string().describe("Stock ticker symbol"),
        },
        async (args) => {
          try {
            const data = await api(`/reports/analyze/${args.symbol}`, { method: "POST" });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Report generation failed: ${e}`);
          }
        }
      ),

    },
  });
}
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/agent/trading-mcp.ts
git commit -m "feat: add trading bot MCP server wrapping localhost:8000 API"
```

---

## Task 2: Trading Subagent Definitions

**Files:**
- Modify: `src/agent/subagents.ts`

**Step 1: Add five trading subagents after the existing `researcher` definition**

```typescript
    "technical-analyst": {
      description:
        "Analyzes stock charts visually and quantitatively. Takes screenshots of TradingView charts, identifies patterns, support/resistance levels, divergences, and price action signals. Cross-references visual analysis with quantitative TA data.",
      prompt: `You are an expert technical analyst. Your workflow:

1. Use the trading-bot MCP tools to get quantitative data: analyze_symbol, market_scan, get_options_flow
2. Use agent-browser via Bash to screenshot TradingView charts at multiple timeframes:
   - agent-browser open "https://www.tradingview.com/chart/?symbol=SYMBOL" then agent-browser screenshot
   - Switch timeframes: daily, 4h, 1h
3. Analyze the chart images: candlestick patterns, trendlines, volume bars, gaps, support/resistance zones
4. Cross-reference what you see visually with the quantitative data
5. Flag discrepancies: "algorithm says buy but chart shows bearish engulfing at resistance"

Return structured findings: key levels, pattern identification, trend assessment, buy/sell zones with confidence.`,
      model: "sonnet",
      maxTurns: 99999,
    },
    "fundamental-analyst": {
      description:
        "Deep dives financial statements, earnings, analyst ratings, insider activity. Compares metrics across sector peers and flags inflection points or red flags.",
      prompt: `You are a fundamental analyst. Your workflow:

1. Use get_fundamentals to pull financial data for the target symbol and its sector peers
2. Use generate_report for a comprehensive analysis
3. Use web search for recent earnings call transcripts, analyst notes, SEC filings
4. Evaluate: revenue growth, margin trends, earnings surprises, debt levels, FCF yield
5. Compare P/E, PEG, EV/EBITDA against sector averages
6. Check insider buying/selling patterns and institutional ownership changes
7. Flag: accounting red flags, management changes, guidance revisions

Return structured findings: valuation assessment, growth trajectory, peer comparison, risk factors, catalyst timeline.`,
      model: "sonnet",
      maxTurns: 99999,
    },
    "macro-strategist": {
      description:
        "Monitors Fed policy, economic data, yield curves, sector rotation, and market regime. Determines which trading strategies should be weighted higher or lower given current conditions.",
      prompt: `You are a macro strategist. Your workflow:

1. Use get_calendar to review upcoming economic events and their expected impact
2. Use get_market_regime for current regime assessment (risk-on/off, volatility state)
3. Use intelligence_scan for cross-source macro signals
4. Use web search for Fed commentary, Treasury yields, DXY, VIX analysis
5. Assess: sector rotation (where money is flowing), yield curve shape, credit spreads
6. Determine current regime: risk-on/risk-off, high/low volatility, growth/value rotation

Return: regime classification, sector recommendations (overweight/underweight), strategy adjustments (which strategies work in this regime), key risk events on the horizon.`,
      model: "sonnet",
      maxTurns: 99999,
    },
    "sentiment-scout": {
      description:
        "Scans news, Reddit, social media for sentiment shifts, narrative changes, and retail/institutional flow signals. Detects early momentum before it shows in price.",
      prompt: `You are a sentiment scout. Your workflow:

1. Use get_trending to see what's trending on social/news
2. Use get_sentiment for target symbols — news and social sentiment scores
3. Use intelligence_scan for cross-source signal aggregation
4. Use web search to check Reddit (r/wallstreetbets, r/stocks), fintwit, StockTwits
5. Detect: narrative shifts, unusual retail interest, institutional accumulation signals
6. Flag: "NVDA sentiment turning negative on AI regulation fears" or "small cap XYZ getting WSB attention"

Return: sentiment scores, narrative summary, unusual activity flags, momentum signals, contrarian indicators.`,
      model: "sonnet",
      maxTurns: 99999,
    },
    "quant-researcher": {
      description:
        "Backtests strategies, evaluates ML models, proposes new signals and features. The agent that actually improves the trading system over time.",
      prompt: `You are a quantitative researcher. Your workflow:

1. Use list_strategies to see available strategies (175+)
2. Use evaluate_strategies to see current rankings and performance
3. Use run_backtest to test specific strategies on specific symbols
4. Use compare_strategies to pit strategies against each other
5. Use ml_accuracy to check model performance and feature importances
6. Use ml_train to retrain models when you find improvements
7. Use web search to research new quantitative strategies and signals

Your goal is continuous improvement:
- Find which strategies work best in current market conditions
- Identify new signal combinations that improve prediction accuracy
- Propose modifications to strategy parameters based on backtest results
- Track what's working and what's degrading over time

Return: performance rankings, improvement proposals, backtest results, model accuracy trends, recommended strategy rotations.`,
      model: "sonnet",
      maxTurns: 99999,
    },
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/agent/subagents.ts
git commit -m "feat: add 5 trading subagents (technical, fundamental, macro, sentiment, quant)"
```

---

## Task 3: Wire Trading MCP into AgentService

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/index.ts`

**Step 1: Import and register the trading MCP server**

In `src/agent/index.ts`, add the import:
```typescript
import { createTradingMcpServer } from "./trading-mcp.ts";
```

Then add it to the MCP servers record alongside existing servers (find where `agent-tools` and `media-tools` are registered). Add:
```typescript
"trading-bot": createTradingMcpServer(),
```

**Step 2: Typecheck**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/agent/index.ts
git commit -m "feat: wire trading-bot MCP server into AgentService"
```

---

## Task 4: Knowledge Directory Setup

**Files:**
- Create: `knowledge/trading/PLAYBOOK.md`
- Create: `knowledge/trading/JOURNAL.md`
- Create: `knowledge/trading/REGIME.md`
- Create: `knowledge/trading/LESSONS.md`
- Create: `knowledge/trading/RESEARCH.md`
- Create: `knowledge/trading/MODELS.md`

**Step 1: Create seed knowledge files**

`knowledge/trading/PLAYBOOK.md`:
```markdown
# Trading Playbook

Last updated: (auto-updated by Strategy Reviewer)

## Active Strategies

### Primary: Technical Momentum
- **Entry:** RSI < 30 + MACD bull cross + price near lower Bollinger Band
- **Exit:** RSI > 70 OR stop loss (2x ATR) OR take profit (8%)
- **Regime:** Works best in trending markets, avoid in choppy/range-bound
- **Confidence:** Medium (backtest win rate ~58%)

### Secondary: Mean Reversion
- **Entry:** RSI < 25 + price at/below VPOC + volume declining
- **Exit:** RSI > 50 OR price reaches upper value area
- **Regime:** Works best in range-bound markets
- **Confidence:** Medium (backtest win rate ~55%)

## Strategy Weights by Regime
| Regime | Momentum | Mean Reversion | Breakout | Notes |
|--------|----------|----------------|----------|-------|
| Risk-on trending | 60% | 20% | 20% | Favor momentum |
| Range-bound | 20% | 60% | 20% | Favor reversion |
| High volatility | 10% | 30% | 60% | Favor breakouts with tight stops |
| Risk-off | 0% | 0% | 0% | Cash / defensive only |

## Rules
- Max 15 positions, min 25% cash reserve
- No broad ETFs (SPY, QQQ) — only individual stocks + commodity ETFs
- STRONG_BUY: 5% position size, BUY: 3% position size
- Always check options flow before entry (unusual put buying = red flag)
```

`knowledge/trading/JOURNAL.md`:
```markdown
# Trade Journal

Auto-updated after each Portfolio Manager run.

## Format
Each entry: Date | Ticker | Action | Price | Signal | Reasoning | Outcome (filled on close)

---
(entries will be appended here)
```

`knowledge/trading/REGIME.md`:
```markdown
# Market Regime

Last updated: (auto-updated by Macro Strategist)

## Current Regime
- Classification: (pending first scan)
- VIX level: —
- Yield curve: —
- Sector rotation: —
- Fed stance: —

## Sector Weights
(pending first analysis)

## Key Upcoming Events
(pending first calendar scan)
```

`knowledge/trading/LESSONS.md`:
```markdown
# Trading Lessons

Extracted patterns from wins and losses. Auto-updated by Strategy Reviewer.

## Entry Lessons
(pending — will be populated after first strategy review)

## Exit Lessons
(pending)

## Regime Lessons
(pending)
```

`knowledge/trading/RESEARCH.md`:
```markdown
# Alpha Research

New strategies, signals, and ideas being explored. Auto-updated by Alpha Researcher.

## Under Investigation
(pending first research run)

## Tested & Approved
(moved to PLAYBOOK.md when validated)

## Tested & Rejected
(kept here with reasoning for why it failed)
```

`knowledge/trading/MODELS.md`:
```markdown
# ML Model Tracking

Performance and feature importance tracking. Auto-updated by ML Trainer.

## Current Models
(pending first training run)

## Accuracy Trends
(pending)

## Feature Importance
(pending)
```

**Step 2: Commit**

```bash
git add knowledge/trading/
git commit -m "feat: seed trading knowledge directory with playbook, journal, regime, lessons, research, models"
```

---

## Task 5: Market Scanner Job (Replace Overnight Stock Screener)

**Files:**
- Modify: DB — update job 24 prompt, add new 5pm job

**Step 1: Update the Overnight Stock Screener job prompt and add 5pm run**

Create a script to update the job and add the new one:

```typescript
// scripts/seed-trading-jobs.ts
import { loadConfig } from "../src/config.ts";
import { initDatabase } from "../src/db/index.ts";
import { createJob, updateJob, getJob } from "../src/db/queries.ts";

loadConfig();
initDatabase();

const SCANNER_PROMPT = `You are the Market Scanner. Run a comprehensive multi-dimensional analysis of the stock universe.

READ CONTEXT FIRST:
1. Read knowledge/trading/PLAYBOOK.md for active strategies and regime weights
2. Read knowledge/trading/REGIME.md for current market regime
3. Read knowledge/trading/LESSONS.md for past mistakes to avoid

PHASE 1: MACRO CONTEXT
Dispatch the macro-strategist subagent to assess current conditions:
- Economic calendar, Fed stance, sector rotation, regime classification
- Update knowledge/trading/REGIME.md with findings

PHASE 2: PARALLEL SCAN
Dispatch subagents in parallel on the stock universe:

A) technical-analyst: Run market_scan on all 50 symbols. For the top 10 signals, take TradingView chart screenshots (daily + 4h timeframes). Identify key levels, patterns, and buy/sell zones.

B) fundamental-analyst: Run get_fundamentals on any symbol with a strong technical signal. Check earnings dates, analyst ratings, insider activity.

C) sentiment-scout: Run get_trending + get_sentiment on top signal symbols. Check for unusual social/news activity, narrative shifts.

STOCK UNIVERSE:
TECH: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, AMD, CRM, PLTR
FINANCE: JPM, BAC, GS, V, MA, BRK-B, C, SCHW
HEALTHCARE: UNH, JNJ, LLY, PFE, ABBV, MRK
ENERGY: XOM, CVX, COP, SLB, OXY
INDUSTRIALS: CAT, GE, BA, HON, UNP
CONSUMER: WMT, COST, HD, MCD, NKE, SBUX
COMMODITIES: GLD, SLV, GDX, USO
SEMIS: AVGO, QCOM, MU, INTC, MRVL
ETFS (reference only): SPY, QQQ, IWM, XLF

PHASE 3: COMPOSITE SCORING
Merge all subagent results. For each symbol with signals, compute a composite score:
- Technical score (40%): confluence, multi-timeframe alignment, volume confirmation
- Fundamental score (20%): valuation, growth, analyst consensus
- Sentiment score (20%): news + social sentiment, unusual activity
- Options flow (10%): put/call ratio, unusual flow, GEX regime
- ML prediction (10%): ml_predict confidence and direction

Also check: get_opportunities from the backend for any additional setups.

PHASE 4: OUTPUT
1. Save full detailed results to knowledge/trading/scans/YYYY-MM-DD-HHMM.md
2. Send ONE concise Telegram message (under 3000 chars) with:
   - Market regime summary (1 line)
   - Top 5 buy setups: ticker, price, composite score, key signal, buy/stop/target levels
   - Top 5 avoid/sell: ticker, price, why
   - Notable: earnings this week, unusual options flow, sentiment shifts
   - Next key event on calendar
   - Use plain text, no markdown`;

// Update existing job 24
const job24 = getJob(24);
if (job24) {
  updateJob(24, { schedule: "0 6 * * *" }); // 2am ET = 6 UTC
  // We'll need to update the prompt via direct SQL since updateJob may not support prompt
}

// Create 5pm ET scanner (21:00 UTC)
const existingPm = getJob(33); // Check if already exists
if (!existingPm) {
  createJob({
    name: "Afternoon Market Scanner",
    prompt: SCANNER_PROMPT,
    type: "cron",
    schedule: "0 21 * * 1-5", // 5pm ET weekdays
    max_budget_usd: 5.0,
    model: "claude-sonnet-4-5-20250929",
  });
}

console.log("Trading jobs seeded.");
```

Note: The exact `updateJob` / `createJob` signatures should match what exists in `src/db/queries.ts`. Read that file to confirm parameter names.

**Step 2: Run the seed script**

```bash
bun run scripts/seed-trading-jobs.ts
```

**Step 3: Commit**

```bash
git add scripts/seed-trading-jobs.ts
git commit -m "feat: add market scanner job prompts with multi-agent analysis and 5pm run"
```

---

## Task 6: Portfolio Manager Job (Fix + Enhance)

**Step 1: Update job 30 prompt to use MCP tools instead of Python scripts**

Add to the seed script from Task 5 (or create a separate one). The new prompt should:

```
PORTFOLIO MANAGER PROMPT (summary — full prompt in seed script):

1. Read knowledge/trading/PLAYBOOK.md for strategy rules
2. Read knowledge/trading/REGIME.md for current regime
3. Read latest scan from knowledge/trading/scans/
4. Call trading_portfolio to get current positions + exposure
5. For each open position:
   - Call analyze_symbol for current technicals
   - Call get_options_flow for options signals
   - Check exit rules from PLAYBOOK against current data
   - Process exits BEFORE entries
6. For new entries:
   - Use top buy candidates from latest scan
   - Verify with analyze_symbol + get_sentiment
   - Check options flow (unusual put buying = skip)
   - Open positions via portfolio_open_position (existing psibot tool)
7. Log every trade to knowledge/trading/JOURNAL.md with full reasoning
8. Send Telegram portfolio update
```

**Step 2: Run the seed script**

**Step 3: Commit**

---

## Task 7: Strategy Reviewer Job (Weekly)

**Step 1: Create weekly strategy review job**

Add to seed script. Schedule: Sunday 8pm ET (Monday 00:00 UTC).

```
STRATEGY REVIEWER PROMPT (summary):

1. Read knowledge/trading/JOURNAL.md — all trades this week
2. Read knowledge/trading/PLAYBOOK.md — current strategies
3. Call evaluate_strategies for strategy rankings
4. Call ml_accuracy for model performance
5. For each closed trade this week:
   - Was the entry signal correct? Did it hit target or stop?
   - What was the actual vs predicted outcome?
   - Were there warning signs we missed?
6. Compute: win rate, avg win/loss ratio, best/worst strategy
7. Update PLAYBOOK.md:
   - Increase weight for outperforming strategies
   - Decrease weight for underperforming ones
   - Add specific lessons learned
8. Update LESSONS.md with new patterns
9. Send Telegram weekly review summary
```

---

## Task 8: ML Trainer Job (Weekly)

**Step 1: Create weekly ML training job**

Schedule: Saturday 3am ET (Saturday 07:00 UTC).

```
ML TRAINER PROMPT (summary):

1. Call ml_accuracy for current baseline metrics
2. Call ml_train to retrain with latest data
3. Call ml_accuracy again for new metrics
4. Compare: did accuracy improve, degrade, or stay flat?
5. Call ml_pipeline/features for feature importances
6. Read knowledge/trading/MODELS.md
7. Update MODELS.md with:
   - Accuracy trend (append new data point)
   - Feature importance changes
   - Model recommendations
8. If accuracy dropped significantly, flag in Telegram
9. If new features became important, note for Alpha Researcher
```

---

## Task 9: Alpha Researcher Job (Daily)

**Step 1: Create daily alpha research job**

Schedule: 1pm ET daily (17:00 UTC).

```
ALPHA RESEARCHER PROMPT (summary):

Dispatch the quant-researcher subagent to:

1. Read knowledge/trading/RESEARCH.md for ongoing investigations
2. Read knowledge/trading/LESSONS.md for areas needing improvement
3. Read knowledge/trading/MODELS.md for model performance gaps
4. One of these research tasks (rotate daily):
   a) Strategy comparison: pick 5 strategies from the 175+ available, backtest them on current market conditions, compare against the playbook strategies
   b) Signal research: use web search to find new quantitative trading ideas, test via run_backtest
   c) Parameter optimization: take a working strategy, test parameter variations
   d) Regime analysis: study how strategies perform across different regimes
   e) Feature hunting: look for new ML features that could improve predictions
5. Update RESEARCH.md with findings
6. If a finding shows >10% improvement in backtest, flag for promotion to PLAYBOOK.md
7. Send brief Telegram update on what was researched and any notable findings
```

---

## Task 10: Seed All Jobs + Wire MCP + Integration Test

**Step 1: Create comprehensive seed script**

Combine all job prompts from Tasks 5-9 into a single `scripts/seed-trading-jobs.ts` with the full prompt text for each job.

**Step 2: Wire MCP server**

Ensure `src/agent/index.ts` includes the trading-bot MCP server.

**Step 3: Update the prompt builder**

In `src/agent/prompts.ts`, add the trading knowledge files to the system prompt so the agent always has access to the playbook and regime context. Read files from `knowledge/trading/PLAYBOOK.md` and `knowledge/trading/REGIME.md` and include in the prompt.

**Step 4: Run seed script**

```bash
bun run scripts/seed-trading-jobs.ts
```

**Step 5: Restart daemon**

```bash
psibot restart
```

**Step 6: Verify**

```bash
psibot logs | grep -iE "(trading|scanner|portfolio|strategy|alpha|ml.train)"
```

Check that:
- Trading MCP server loads without errors
- New jobs appear in scheduler logs
- Next run times are correct

**Step 7: Manual trigger test**

Trigger the market scanner manually:
```bash
sqlite3 data/app.db "SELECT id FROM jobs WHERE name='Afternoon Market Scanner'"
```
Then use Telegram: tell the bot to trigger job N.

**Step 8: Commit any fixes**

```bash
git add -A
git commit -m "feat: complete trading intelligence system — MCP, subagents, jobs, knowledge loop"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Trading Bot MCP Server (18 tools) | `src/agent/trading-mcp.ts` |
| 2 | 5 Trading Subagents | `src/agent/subagents.ts` |
| 3 | Wire MCP into AgentService | `src/agent/index.ts` |
| 4 | Knowledge directory (6 seed files) | `knowledge/trading/*.md` |
| 5 | Market Scanner job (2am + 5pm) | `scripts/seed-trading-jobs.ts` |
| 6 | Portfolio Manager (enhanced) | DB job update |
| 7 | Strategy Reviewer (weekly) | DB job creation |
| 8 | ML Trainer (weekly) | DB job creation |
| 9 | Alpha Researcher (daily) | DB job creation |
| 10 | Wire + test + verify | Integration |
