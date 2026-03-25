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
    tools: [

      // --- Market Analysis ---

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
        "open_paper_position",
        "Open a paper trading position. Use this to act on strategy recommendations — put money where the research says to. Track performance over time to validate that research translates to real returns.",
        {
          symbol: z.string().describe("Stock ticker symbol"),
          shares: z.number().describe("Number of shares to buy"),
          cost_basis: z.number().describe("Price per share (use current market price)"),
          strategy: z.string().optional().describe("Which strategy/composite recommended this trade"),
          reason: z.string().optional().describe("Brief rationale for the trade"),
        },
        async (args) => {
          try {
            const data = await api("/portfolio/positions", {
              method: "POST",
              body: JSON.stringify({
                symbol: args.symbol,
                shares: args.shares,
                cost_basis: args.cost_basis,
              }),
            });
            return ok(JSON.stringify({ ...data, strategy: args.strategy, reason: args.reason }, null, 2));
          } catch (e) {
            return err(`Failed to open position: ${e}`);
          }
        }
      ),

      tool(
        "close_paper_position",
        "Close a paper trading position by ID. Use when a strategy signals exit or stop-loss is hit.",
        {
          position_id: z.number().describe("Position ID from trading_portfolio"),
        },
        async (args) => {
          try {
            await api(`/portfolio/positions/${args.position_id}`, { method: "DELETE" });
            return ok(`Position ${args.position_id} closed.`);
          } catch (e) {
            return err(`Failed to close position: ${e}`);
          }
        }
      ),

      tool(
        "update_paper_position",
        "Update shares or cost basis of an existing paper position (e.g., to add to a position).",
        {
          position_id: z.number().describe("Position ID from trading_portfolio"),
          shares: z.number().optional().describe("New total shares"),
          cost_basis: z.number().optional().describe("New cost basis per share"),
        },
        async (args) => {
          try {
            const data = await api(`/portfolio/positions/${args.position_id}`, {
              method: "PUT",
              body: JSON.stringify({
                shares: args.shares,
                cost_basis: args.cost_basis,
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Failed to update position: ${e}`);
          }
        }
      ),

      // --- Backtesting ---

      tool(
        "run_backtest",
        "Run a backtest for a strategy on given symbols. Returns performance metrics, trade log, and equity curve.",
        {
          strategy: z.string().describe("Strategy name (e.g. 'technical_momentum', 'rsi_mean_reversion', 'turtle_system1')"),
          symbols: z.array(z.string()).describe("Symbols to backtest on"),
          days: z.number().optional().describe("Lookback period in days (default 365). Converted to start_date/end_date."),
        },
        async (args) => {
          try {
            const end = new Date();
            const start = new Date(end.getTime() - (args.days ?? 365) * 86400000);
            const data = await api("/backtest/run", {
              method: "POST",
              body: JSON.stringify({
                strategy_name: args.strategy,
                symbols: args.symbols,
                start_date: start.toISOString().slice(0, 10),
                end_date: end.toISOString().slice(0, 10),
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Backtest failed: ${e}`);
          }
        }
      ),

      tool(
        "batch_backtest",
        "Run backtests for many strategies at once on the same symbols. Much more efficient than calling run_backtest in a loop. Returns a batch ID to poll results.",
        {
          strategies: z.array(z.object({
            name: z.string().describe("Strategy name"),
            parameters: z.record(z.union([z.number(), z.string(), z.boolean()])).optional().describe("Optional parameter overrides"),
          })).describe("Strategies to test"),
          symbols: z.array(z.string()).describe("Symbols to backtest on"),
          days: z.number().optional().describe("Lookback period in days (default 365)"),
        },
        async (args) => {
          try {
            const end = new Date();
            const start = new Date(end.getTime() - (args.days ?? 365) * 86400000);
            const data = await api("/backtest/batch", {
              method: "POST",
              body: JSON.stringify({
                strategies: args.strategies.map((s) => ({
                  name: s.name,
                  ...(s.parameters ? { strategy_parameters: s.parameters } : {}),
                })),
                symbols: args.symbols,
                start_date: start.toISOString().slice(0, 10),
                end_date: end.toISOString().slice(0, 10),
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Batch backtest failed: ${e}`);
          }
        }
      ),

      tool(
        "get_batch_results",
        "Get results for a batch backtest by batch ID.",
        {
          batch_id: z.string().describe("The batch ID returned by batch_backtest"),
        },
        async (args) => {
          try {
            const data = await api(`/backtest/batch/${args.batch_id}`);
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Failed to get batch results: ${e}`);
          }
        }
      ),

      tool(
        "compare_strategies",
        "Compare multiple strategies side-by-side on the same symbols. Returns comparative metrics.",
        {
          strategies: z.array(z.string()).describe("Strategy names to compare (2-10)"),
          symbols: z.array(z.string()).describe("Symbols to test on"),
          days: z.number().optional().describe("Lookback period in days (default 365)"),
        },
        async (args) => {
          try {
            const end = new Date();
            const start = new Date(end.getTime() - (args.days ?? 365) * 86400000);
            const data = await api("/backtest/compare", {
              method: "POST",
              body: JSON.stringify({
                strategy_names: args.strategies,
                symbols: args.symbols,
                start_date: start.toISOString().slice(0, 10),
                end_date: end.toISOString().slice(0, 10),
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Strategy comparison failed: ${e}`);
          }
        }
      ),

      tool(
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

      tool(
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

      tool(
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

      tool(
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

      tool(
        "regime_matched_backtest",
        "Backtest a strategy only on historical periods that match the current market regime. Fingerprints the current market (RSI, ATR, BB width, MACD, trend, volatility) and finds the most similar past periods to test on. Much more predictive than fixed-window backtesting.",
        {
          strategy: z.string().describe("Strategy name to test"),
          symbols: z.array(z.string()).describe("Symbols to test on"),
          reference_symbol: z.string().optional().describe("Symbol to fingerprint for regime (default: SPY)"),
          lookback_years: z.number().optional().describe("How far back to search for similar periods (default: 5)"),
          similar_periods: z.number().optional().describe("Top N similar periods to test on (default: 5)"),
          window_days: z.number().optional().describe("Size of each matching window in days (default: 60)"),
        },
        async (args) => {
          try {
            const data = await api("/backtest/regime-matched", {
              method: "POST",
              body: JSON.stringify({
                strategy_name: args.strategy,
                symbols: args.symbols,
                reference_symbol: args.reference_symbol ?? "SPY",
                lookback_years: args.lookback_years ?? 5,
                similar_periods: args.similar_periods ?? 5,
                window_days: args.window_days ?? 60,
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Regime-matched backtest failed: ${e}`);
          }
        }
      ),

      tool(
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

      // --- Composite Strategy ---

      tool(
        "composite_backtest",
        "Combine multiple strategies into an ensemble and backtest it. Test strategy combinations with different voting rules to find synergies between strategies.",
        {
          strategies: z.array(z.object({
            name: z.string().describe("Strategy name"),
            weight: z.number().describe("Weight for this strategy (e.g. 1.0)"),
          })).describe("Strategies to combine"),
          symbols: z.array(z.string()).describe("Symbols to test on"),
          days: z.number().optional().describe("Lookback period in days (default 365)"),
          voting_mode: z.enum(["weighted", "majority", "unanimous", "any"]).optional().describe("How to combine signals (default: weighted)"),
          buy_threshold: z.number().optional().describe("For weighted mode: threshold to trigger buy (default 0.5)"),
          sell_threshold: z.number().optional().describe("For weighted mode: threshold to trigger sell (default -0.5)"),
        },
        async (args) => {
          try {
            const end = new Date();
            const start = new Date(end.getTime() - (args.days ?? 365) * 86400000);
            const data = await api("/backtest/composite", {
              method: "POST",
              body: JSON.stringify({
                strategies: args.strategies,
                symbols: args.symbols,
                start_date: start.toISOString().slice(0, 10),
                end_date: end.toISOString().slice(0, 10),
                voting_mode: args.voting_mode ?? "weighted",
                buy_threshold: args.buy_threshold,
                sell_threshold: args.sell_threshold,
              }),
            });
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Composite backtest failed: ${e}`);
          }
        }
      ),

      // --- Universes ---

      tool(
        "list_universes",
        "List all stock universes (watchlists) with their symbol counts. Use to discover available symbol groups for backtesting.",
        {},
        async () => {
          try {
            const data = await api("/universes");
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Universe list failed: ${e}`);
          }
        }
      ),

      tool(
        "get_universe_symbols",
        "Get all symbols in a specific universe by ID. Use after list_universes to get the actual tickers.",
        {
          universe_id: z.number().describe("Universe ID from list_universes"),
        },
        async (args) => {
          try {
            const data = await api(`/universes/${args.universe_id}/symbols`);
            return ok(JSON.stringify(data, null, 2));
          } catch (e) {
            return err(`Universe symbols failed: ${e}`);
          }
        }
      ),

      // --- Reports ---

      tool(
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

    ],
  });
}
