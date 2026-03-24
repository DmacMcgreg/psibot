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

      // --- Backtesting ---

      tool(
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

      tool(
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
