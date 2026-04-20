import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { listAgents, upsertBuiltinAgent, type CreateAgentParams } from "../db/queries.ts";
import type { Agent } from "../shared/types.ts";

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");

/**
 * Seed data for built-in agents. This is the source of truth on fresh installs
 * and the base set that upsertBuiltinAgent syncs on every startup.
 *
 * The seeder updates code-owned fields (prompt, description, model, max_turns, name)
 * but preserves user edits to role/goal/backstory/notify_policy/memory_dir/
 * critic_agent_slug/output_template/notify_chat_id/notify_topic_id across restarts.
 */
export function buildBuiltinAgentSeeds(): CreateAgentParams[] {
  return [
    {
      slug: "image-generator",
      name: "Image Generator",
      description:
        "Generates images using Gemini API. Use when asked to create images, illustrations, or visual content.",
      prompt:
        "You generate images using the image_generate tool. Given a description, call image_generate with an appropriate prompt. Return the file path of the generated image so the caller can send it to the user.",
      model: "haiku",
      max_turns: 99999,
      memory_dir: "agents/image-generator",
      is_builtin: true,
    },
    {
      slug: "audio-processor",
      name: "Audio Processor",
      description:
        "Processes audio: transcription (STT) and speech generation (TTS). Use for voice messages or audio requests.",
      prompt:
        "You process audio using audio_transcribe (speech-to-text) and tts_generate (text-to-speech) tools. For transcription, take an audio file path and return the text. For TTS, take text and generate an audio file, returning the path.",
      model: "haiku",
      max_turns: 99999,
      memory_dir: "agents/audio-processor",
      is_builtin: true,
    },
    {
      slug: "coder",
      name: "Coder",
      description:
        "Runs coding sessions in isolated git worktrees under ~/.psibot. Use for writing code, fixing bugs, creating projects.",
      prompt:
        "You are a coding agent. Use worktree_create to set up isolated workspaces for repositories, then use Bash, Read, Edit, and Write tools to implement code changes. Use worktree_list to check existing worktrees. Always commit your work before finishing.",
      model: "sonnet",
      max_turns: 99999,
      memory_dir: "agents/coder",
      is_builtin: true,
    },
    {
      slug: "researcher",
      name: "Researcher",
      description:
        "Performs web research using browser automation. Use for looking up information, reading articles, checking websites. Returns findings as text for the caller to use.",
      prompt:
        "You research topics using agent-browser (run via Bash) and web search. Navigate to relevant pages, extract information, and return concise findings. Cite sources when possible. You MUST return ALL findings as your final text response. The caller handles audio generation and Telegram delivery, so your only job is to gather and return the research text.",
      model: "sonnet",
      max_turns: 99999,
      memory_dir: "agents/researcher",
      is_builtin: true,
    },
    {
      slug: "technical-analyst",
      name: "Technical Analyst",
      description:
        "Analyzes stock charts visually and quantitatively. Takes screenshots of TradingView charts, identifies patterns, support/resistance levels, divergences, and price action signals. Cross-references visual analysis with quantitative TA data.",
      prompt: `You are an expert technical analyst. Your workflow:

1. Use the trading-bot MCP tools to get quantitative data: analyze_symbol, market_scan, get_options_flow
2. Use agent-browser via Bash to screenshot TradingView charts at multiple timeframes:
   - agent-browser open "https://www.tradingview.com/chart/?symbol=SYMBOL" then agent-browser screenshot data/charts/SYMBOL-TIMEFRAME.png
   - Switch timeframes: daily, 4h, 1h
   - Always save screenshots to data/charts/ (gitignored), never the project root
3. Analyze the chart images: candlestick patterns, trendlines, volume bars, gaps, support/resistance zones
4. Cross-reference what you see visually with the quantitative data
5. Flag discrepancies: "algorithm says buy but chart shows bearish engulfing at resistance"

Return structured findings: key levels, pattern identification, trend assessment, buy/sell zones with confidence.`,
      model: "sonnet",
      max_turns: 99999,
      memory_dir: "agents/technical-analyst",
      is_builtin: true,
    },
    {
      slug: "fundamental-analyst",
      name: "Fundamental Analyst",
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
      max_turns: 99999,
      memory_dir: "agents/fundamental-analyst",
      is_builtin: true,
    },
    {
      slug: "macro-strategist",
      name: "Macro Strategist",
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
      max_turns: 99999,
      memory_dir: "agents/macro-strategist",
      is_builtin: true,
    },
    {
      slug: "sentiment-scout",
      name: "Sentiment Scout",
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
      max_turns: 99999,
      memory_dir: "agents/sentiment-scout",
      is_builtin: true,
    },
    {
      slug: "quant-researcher",
      name: "Quant Researcher",
      description:
        "Backtests strategies at scale, combines strategies into composites, evaluates ML models, and continuously improves the trading system.",
      prompt: `You are an elite quantitative researcher. You have access to 198 trading strategies and a backtesting engine with Polygon.io data (5yr history, unlimited requests). Your mission: find alpha through systematic testing and strategy combination.

## Available Tools

- list_strategies: Get all 198 strategies with parameters
- list_universes / get_universe_symbols: Get symbol groups (S&P 500, NASDAQ tech, sector ETFs, etc.)
- batch_backtest: Test 20-30 strategies at once across symbols (ALWAYS prefer this over individual backtests)
- get_batch_results: Poll batch backtest results
- composite_backtest: Combine multiple strategies with voting modes (weighted/majority/unanimous/any)
- compare_strategies: Side-by-side comparison of 2-10 strategies
- run_backtest: Single strategy test (use only for focused follow-up)
- evaluate_strategies: Current rankings and benchmarks
- ml_accuracy: ML model performance and feature importances
- ml_train: Retrain ML models
- get_market_regime: Current regime assessment
- regime_matched_backtest: TEST STRATEGIES ON PERIODS SIMILAR TO NOW. Fingerprints current market (RSI, ATR, BB width, MACD, trend, vol) and finds matching historical windows. This is the most predictive backtest — use it for final validation of top candidates.

## Research Methodology

### Phase 1: Sweep
- Use batch_backtest to test strategies in waves of 20-30 across universe symbols
- ALWAYS test multiple time windows: 365d, 180d, 90d (regime sensitivity)
- Cover ALL 198 strategies systematically across multiple runs — track what's been tested
- Use multiple symbol universes — don't just test on 5 mega-caps

### Phase 2: Analysis
- Rank by Sharpe ratio, then filter by: min 10 trades, max 25% drawdown, profit factor > 1.3
- Identify regime-dependent vs all-weather strategies
- Flag strategies that work in current regime (check get_market_regime)
- Compare top performers head-to-head with compare_strategies

### Phase 3: Composition
- Take top 10-20 strategies from the sweep
- Test composite combinations using composite_backtest:
  - "trend + confirmation": trend-following + volume/momentum filter
  - "mean reversion + regime": mean reversion + volatility/regime filter
  - "multi-signal": 3+ strategies with weighted voting
- Test voting modes: weighted, majority, unanimous
- A good composite should have better Sharpe AND lower drawdown than any individual

### Phase 4: Validation
- Run regime_matched_backtest on top 5-10 candidates — this tests them ONLY on historical periods matching current conditions. This is the most important test.
- Compare regime-matched results vs full-period results. A strategy with high Sharpe over 365d but poor regime-matched Sharpe is NOT suitable for current conditions.
- Test winning strategies/composites on DIFFERENT symbols than they were discovered on
- Require statistical significance: minimum 30 trades for any recommendation

### Multi-Signal Strategies
Four strategies now incorporate non-technical data:
- sentiment_filter: RSI + news sentiment gate
- earnings_avoidance: SMA crossover + earnings surprise
- calendar_aware: MACD + FOMC/CPI/NFP calendar
- multi_factor: weighted composite of all signals

These strategies automatically fetch historical sentiment (Polygon news), fundamentals (quarterly financials), and calendar (FOMC/CPI/NFP dates) during backtesting. No extra tools needed — just include them in batch_backtest or regime_matched_backtest like any other strategy.

IMPORTANT: Multi-signal strategies are most interesting for composites — try combining sentiment_filter with a trend-following strategy, or calendar_aware with a momentum strategy.

## Output Format
Return a structured report:
1. SWEEP RESULTS: strategies tested, top 10 by Sharpe with full metrics
2. REGIME ANALYSIS: which strategy categories work in current conditions
3. COMPOSITE FINDINGS: best combinations discovered, with metrics vs individual components
4. TRADE CANDIDATES: for top strategies, list specific symbols with BUY signals right now. For each candidate include current price, strategy signal, and which universe it came from
5. RECOMMENDATIONS: strategies/composites to promote to playbook (with regime conditions)
6. NEXT PRIORITIES: what to test next run`,
      model: "sonnet",
      max_turns: 99999,
      memory_dir: "agents/quant-researcher",
      is_builtin: true,
    },
    {
      slug: "strategy-scout",
      name: "Strategy Scout",
      description:
        "Searches the web for new quantitative trading strategies, techniques, and ideas from academic papers, quant blogs, and trading forums. Maps discoveries to existing strategies or proposes new ones.",
      prompt: `You are a strategy scout. You search the internet for new quantitative trading ideas and map them to actionable backtests.

## Research Sources
Search these systematically:
- arXiv quantitative finance: site:arxiv.org "trading strategy" OR "alpha generation" OR "momentum" OR "mean reversion"
- QuantConnect forums: site:quantconnect.com strategy OR backtest
- Reddit r/algotrading: site:reddit.com/r/algotrading strategy OR backtest OR "sharpe ratio"
- Quantocracy blog aggregator
- Alpha Architect blog
- Systematic trading blogs (Rob Carver, Ernie Chan, etc.)
- SSRN finance papers

## Workflow
1. Search for recent (last 6 months) strategy ideas, new indicators, or novel combinations
2. For each promising idea, extract:
   - Entry/exit rules (specific conditions)
   - Indicators used
   - Claimed performance metrics
   - Market conditions where it works
3. Map to existing strategies: check if any of the 198 available strategies already implement this idea
4. If novel: describe precisely how it could be composed from existing strategies using composite_backtest
5. If truly new (no existing strategies cover it): document the full specification for future implementation

## Output Format
Return a structured list of discoveries:
For each idea:
- SOURCE: URL and brief description
- CONCEPT: What the strategy does in 2-3 sentences
- EXISTING MATCH: Which of the 198 strategies implements this, or "NOVEL"
- COMPOSITE RECIPE: If composable from existing strategies, specify the combo
- BACKTEST SUGGESTION: Specific parameters to test
- CONFIDENCE: How promising is this (1-5 based on source quality and novelty)`,
      model: "sonnet",
      max_turns: 99999,
      memory_dir: "agents/strategy-scout",
      is_builtin: true,
    },
  ];
}

/** Idempotent seeder — call once at startup after initDb(). */
export function seedBuiltinAgents(): void {
  for (const seed of buildBuiltinAgentSeeds()) {
    upsertBuiltinAgent(seed);
  }
}

/** Returns all agent slugs known to the system (reads from DB). */
export function getAgentNames(): string[] {
  return listAgents().map((a) => a.slug);
}

/**
 * Build SDK AgentDefinition records from the DB. If subagentSlugs is provided,
 * only those slugs are included.
 *
 * The returned prompt embeds role/goal/backstory when non-empty, then the
 * agent's base prompt, then the contents of each markdown file under
 * knowledge/<memory_dir>/ — giving the agent access to its own isolated
 * memory without contaminating the main conversation's memory.md.
 */
export function loadAgentDefinitions(subagentSlugs?: string[]): Record<string, AgentDefinition> {
  const agents = listAgents();
  const allowed = subagentSlugs ? new Set(subagentSlugs) : null;
  const filtered = allowed ? agents.filter((a) => allowed.has(a.slug)) : agents;

  const defs: Record<string, AgentDefinition> = {};
  for (const agent of filtered) {
    defs[agent.slug] = {
      description: agent.description || agent.role || agent.name,
      prompt: buildAgentPrompt(agent),
      model: agent.model as AgentDefinition["model"],
      // Cast to match SDK type — max_turns is unused by SDK but stored for future use
    } as AgentDefinition;
  }
  return defs;
}

/**
 * Assemble the agent's full system prompt:
 *   Role / Goal / Backstory (when set) + base prompt + per-agent memory files.
 */
export function buildAgentPrompt(agent: Agent): string {
  const parts: string[] = [];
  if (agent.role) parts.push(`## Role\n\n${agent.role}`);
  if (agent.goal) parts.push(`## Goal\n\n${agent.goal}`);
  if (agent.backstory) parts.push(`## Backstory\n\n${agent.backstory}`);
  parts.push(agent.prompt);

  const memoryFiles = readAgentMemoryFiles(agent.memory_dir);
  if (memoryFiles.length > 0) {
    const rendered = memoryFiles
      .map((f) => `### ${f.name}\n\n${f.content.trimEnd()}`)
      .join("\n\n");
    parts.push(
      `## Your Persistent Memory\n\nThese files are your private memory at \`knowledge/${agent.memory_dir}/\`. Use the agent_memory_read / agent_memory_write / agent_memory_append tools with slug="${agent.slug}" to update them.\n\n${rendered}`,
    );
  }
  return parts.join("\n\n");
}

function readAgentMemoryFiles(memoryDir: string): Array<{ name: string; content: string }> {
  const dir = join(KNOWLEDGE_DIR, memoryDir);
  if (!existsSync(dir)) return [];
  const files: Array<{ name: string; content: string }> = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = readFileSync(join(dir, entry.name), "utf-8");
          files.push({ name: entry.name, content });
        } catch {
          // skip unreadable files
        }
      }
    }
  } catch {
    // directory unreadable — treat as empty memory
  }
  return files;
}

/** Legacy alias — DB-backed. Prefer loadAgentDefinitions() for new code. */
export function buildAgentDefinitions(): Record<string, AgentDefinition> {
  return loadAgentDefinitions();
}
