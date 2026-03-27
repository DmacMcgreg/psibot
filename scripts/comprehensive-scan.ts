#!/usr/bin/env bun

const SYMBOLS = [
  // MEGA CAP TECH
  "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "NFLX", "ORCL", "ADBE",
  // GROWTH TECH
  "CRM", "PLTR", "NOW", "SNOW", "DDOG", "NET", "CRWD", "PANW", "ZS", "SHOP", "SQ", "COIN", "MELI", "SE",
  // SEMIS
  "AMD", "AVGO", "QCOM", "MU", "INTC", "MRVL", "LRCX", "KLAC", "AMAT", "ON", "ARM", "TSM", "ASML",
  // AI/ROBOTICS
  "SMCI", "DELL", "HPE", "VRT", "ASTS", "IONQ", "RGTI", "SERV",
  // FINANCE
  "JPM", "BAC", "GS", "MS", "V", "MA", "BRK-B", "C", "SCHW", "AXP", "BX", "KKR", "APO",
  // HEALTHCARE
  "UNH", "JNJ", "LLY", "PFE", "ABBV", "MRK", "TMO", "ISRG", "DXCM", "MRNA", "BIIB",
  // BIOTECH
  "AMGN", "GILD", "VRTX", "REGN", "BMY",
  // ENERGY
  "XOM", "CVX", "COP", "SLB", "OXY", "EOG", "DVN", "HAL", "MPC", "VLO", "PSX",
  // INDUSTRIALS
  "CAT", "GE", "BA", "HON", "UNP", "RTX", "LMT", "NOC", "DE", "WM", "RSG",
  // CONSUMER DISCRETIONARY
  "WMT", "COST", "HD", "MCD", "NKE", "SBUX", "TGT", "LULU", "CMG", "ABNB", "BKNG", "UBER", "LYFT",
  // CONSUMER STAPLES
  "PG", "KO", "PEP", "CL", "PM", "MO", "MDLZ",
  // REAL ESTATE
  "AMT", "PLD", "CCI", "EQIX", "SPG", "O",
  // UTILITIES
  "NEE", "DUK", "SO", "D", "AEP",
  // TELECOM/MEDIA
  "DIS", "CMCSA", "T", "VZ", "TMUS",
  // COMMODITIES
  "GLD", "SLV", "GDX", "USO", "UNG", "COPX", "WEAT", "DBA",
  // CRYPTO-ADJACENT
  "MSTR", "MARA", "RIOT", "CLSK", "HUT",
  // ETFS
  "SPY", "QQQ", "IWM", "XLF", "XLK", "XLE", "XLV", "XLI", "XLP", "XLU", "ARKK", "TLT"
];

const BASE_URL = "http://localhost:8000/api/v1";

interface ScanResult {
  symbol: string;
  timeframe: string;
  indicators: Array<{
    name: string;
    value: number;
    signal: string;
  }>;
  overall_signal: string;
  signal_strength: number;
  summary: string;
}

async function scanSymbol(symbol: string): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${BASE_URL}/analysis/batch?symbols=${symbol}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data[0] || null;
  } catch (e) {
    console.error(`Failed to scan ${symbol}:`, e);
    return null;
  }
}

async function main() {
  console.error(`Scanning ${SYMBOLS.length} symbols...`);

  const results: ScanResult[] = [];

  // Scan in small batches to avoid overwhelming the API
  for (let i = 0; i < SYMBOLS.length; i++) {
    const symbol = SYMBOLS[i];
    const result = await scanSymbol(symbol);
    if (result) {
      results.push(result);
    }

    // Progress indicator every 10 symbols
    if ((i + 1) % 10 === 0) {
      console.error(`Progress: ${i + 1}/${SYMBOLS.length}`);
    }

    // Small delay to be nice to the API
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.error(`\nCompleted: ${results.length}/${SYMBOLS.length} symbols scanned`);

  // Output JSON results to stdout
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
