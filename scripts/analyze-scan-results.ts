#!/usr/bin/env bun

interface Indicator {
  name: string;
  value: number;
  signal: string;
}

interface ScanResult {
  symbol: string;
  timeframe: string;
  indicators: Indicator[];
  overall_signal: string;
  signal_strength: number;
  summary: string;
}

interface RankedSignal {
  symbol: string;
  signal: string;
  strength: number;
  rsi: number;
  macd: number;
  sma_cross: number;
  bb_position: number;
  ema_trend: number;
  score: number;
}

function calculateScore(result: ScanResult): number {
  const { overall_signal, signal_strength, indicators } = result;

  // Base score from signal strength
  let score = signal_strength;

  // Find key indicators
  const rsi = indicators.find(i => i.name === "RSI");
  const macd = indicators.find(i => i.name === "MACD");
  const bbPos = indicators.find(i => i.name === "BB_Position");

  // Bonus for extreme RSI
  if (rsi) {
    if (overall_signal === "buy" && rsi.value < 35) score += 0.15; // Oversold bounce
    if (overall_signal === "sell" && rsi.value > 65) score += 0.15; // Overbought decline
  }

  // Bonus for BB extremes (reversals)
  if (bbPos) {
    if (overall_signal === "buy" && bbPos.value < 0.2) score += 0.1;
    if (overall_signal === "sell" && bbPos.value > 0.8) score += 0.1;
  }

  // Bonus for MACD alignment
  if (macd) {
    if (overall_signal === "buy" && macd.signal === "bullish") score += 0.1;
    if (overall_signal === "sell" && macd.signal === "bearish") score += 0.1;
  }

  return Math.min(score, 1.0); // Cap at 100%
}

function getIndicatorValue(indicators: Indicator[], name: string): number {
  return indicators.find(i => i.name === name)?.value ?? 0;
}

async function main() {
  const input = await Bun.stdin.text();
  const results: ScanResult[] = JSON.parse(input);

  console.error(`Analyzing ${results.length} scan results...`);

  // Create ranked list
  const ranked: RankedSignal[] = results.map(r => ({
    symbol: r.symbol,
    signal: r.overall_signal,
    strength: r.signal_strength,
    rsi: getIndicatorValue(r.indicators, "RSI"),
    macd: getIndicatorValue(r.indicators, "MACD"),
    sma_cross: getIndicatorValue(r.indicators, "SMA_Crossover"),
    bb_position: getIndicatorValue(r.indicators, "BB_Position"),
    ema_trend: getIndicatorValue(r.indicators, "EMA_Trend"),
    score: calculateScore(r)
  }));

  // Sort by score descending
  ranked.sort((a, b) => b.score - a.score);

  // Output top 30
  const top30 = ranked.slice(0, 30);

  console.log(JSON.stringify(top30, null, 2));

  // Summary stats
  console.error(`\nTop 30 Signals:`);
  console.error(`Bullish: ${top30.filter(s => s.signal === "buy").length}`);
  console.error(`Bearish: ${top30.filter(s => s.signal === "sell").length}`);
}

main().catch(console.error);
