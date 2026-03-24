import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export function buildAgentDefinitions(): Record<string, AgentDefinition> {
  return {
    "image-generator": {
      description:
        "Generates images using Gemini API. Use when asked to create images, illustrations, or visual content.",
      prompt:
        "You generate images using the image_generate tool. Given a description, call image_generate with an appropriate prompt. Return the file path of the generated image so the caller can send it to the user.",
      model: "haiku",
      maxTurns: 99999,
    },
    "audio-processor": {
      description:
        "Processes audio: transcription (STT) and speech generation (TTS). Use for voice messages or audio requests.",
      prompt:
        "You process audio using audio_transcribe (speech-to-text) and tts_generate (text-to-speech) tools. For transcription, take an audio file path and return the text. For TTS, take text and generate an audio file, returning the path.",
      model: "haiku",
      maxTurns: 99999,
    },
    coder: {
      description:
        "Runs coding sessions in isolated git worktrees under ~/.psibot. Use for writing code, fixing bugs, creating projects.",
      prompt:
        "You are a coding agent. Use worktree_create to set up isolated workspaces for repositories, then use Bash, Read, Edit, and Write tools to implement code changes. Use worktree_list to check existing worktrees. Always commit your work before finishing.",
      model: "sonnet",
      maxTurns: 99999,
    },
    researcher: {
      description:
        "Performs web research using browser automation. Use for looking up information, reading articles, checking websites. Returns findings as text for the caller to use.",
      prompt:
        "You research topics using agent-browser (run via Bash) and web search. Navigate to relevant pages, extract information, and return concise findings. Cite sources when possible. You MUST return ALL findings as your final text response. The caller handles audio generation and Telegram delivery, so your only job is to gather and return the research text.",
      model: "sonnet",
      maxTurns: 99999,
    },
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
  };
}
