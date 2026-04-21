import { insertTradingSignal, getTradingSignalByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { browserFetchContent, fetchJson, loadShadowWeights } from "./shadow-helper.ts";

const log = createLogger("capture:shadow-afterhour");

const AFTERHOUR_FAIL_THRESHOLD = 3;
let consecutiveFailures = 0;
let disabledUntil = 0;

interface QuiverCongressTrade {
  Representative: string;
  Ticker: string;
  TransactionDate: string;
  Transaction: "Purchase" | "Sale" | "Sale (Full)" | "Sale (Partial)" | string;
  Range?: string;
  House?: string;
}

interface AutopilotPortfolioHolding {
  ticker: string;
  portfolio: string;
  action?: string;
  weight?: number;
  lastUpdated?: string;
}

async function fetchQuiverCongressTrades(): Promise<QuiverCongressTrade[]> {
  const url = "https://api.quiverquant.com/beta/live/congresstrading";
  const data = await fetchJson<QuiverCongressTrade[]>(url);
  return Array.isArray(data) ? data.slice(0, 100) : [];
}

async function fetchAutopilotLeaderboard(): Promise<AutopilotPortfolioHolding[]> {
  // Autopilot has a public leaderboard page
  const content = await browserFetchContent("https://www.joinautopilot.com/pilots");
  if (!content) return [];
  const holdings: AutopilotPortfolioHolding[] = [];
  // Basic text extraction - looks for ticker patterns in the public text
  const patterns = [
    /(Nancy Pelosi|Warren Buffett|Michael Burry|Bill Ackman|Cathie Wood)[^\n]*?\$([A-Z]{1,5})/g,
  ];
  for (const pattern of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      holdings.push({
        ticker: m[2].toUpperCase(),
        portfolio: m[1],
        lastUpdated: new Date().toISOString().slice(0, 10),
      });
    }
  }
  return holdings;
}

async function pollAfterHour(): Promise<number> {
  if (Date.now() < disabledUntil) {
    log.info("afterhour still in cooldown, skipping");
    return 0;
  }
  // AfterHour is aggressively bot-protected — attempt once, if it fails 3×, disable for 24h
  const content = await browserFetchContent("https://afterhour.com/feed", 8000);
  if (!content || content.length < 500) {
    consecutiveFailures++;
    log.warn("afterhour fetch failed", { consecutiveFailures });
    if (consecutiveFailures >= AFTERHOUR_FAIL_THRESHOLD) {
      disabledUntil = Date.now() + 24 * 60 * 60 * 1000;
      log.warn("afterhour disabled for 24h — falling back to Autopilot/Quiver only");
    }
    return 0;
  }
  consecutiveFailures = 0;
  // Parse trades from the feed — basic pattern match for now
  const weights = await loadShadowWeights();
  let total = 0;
  const tradeMatches = content.matchAll(/@([a-zA-Z0-9_]+).{0,100}?(bought|sold|long|short|closing|opening)[^\n]{0,50}\$([A-Z]{1,5})/gi);
  for (const m of tradeMatches) {
    const user = m[1];
    const action = m[2].toLowerCase();
    const ticker = m[3].toUpperCase();
    const signalUrl = `https://afterhour.com/feed#${user}-${ticker}-${Date.now()}`;
    if (getTradingSignalByUrl(signalUrl)) continue;
    const direction = ["bought", "long", "opening"].includes(action) ? "long"
      : ["sold", "short", "closing"].includes(action) ? "short" : "neutral";
    if (direction === "neutral") continue;
    const weight = weights.afterhour[user] ?? weights.default;
    insertTradingSignal({
      source: "shadow-afterhour",
      ticker,
      direction,
      strength: weight,
      reason: `AfterHour @${user} ${action} ${ticker}`,
      payload_json: JSON.stringify({ user, action, ticker }),
      source_url: signalUrl,
    });
    total++;
  }
  return total;
}

export async function pollShadowAfterHourAndFallbacks(): Promise<number> {
  let total = 0;
  const weights = await loadShadowWeights();

  // AfterHour (may be disabled)
  try {
    total += await pollAfterHour();
  } catch (err) {
    log.error("afterhour poll failed", { error: String(err) });
  }

  // Quiver Quantitative: congressional trades (free public JSON)
  try {
    const trades = await fetchQuiverCongressTrades();
    log.info("quiver congress trades fetched", { count: trades.length });
    for (const t of trades) {
      if (!t.Ticker || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(t.Ticker)) continue;
      const signalUrl = `https://quiverquant.com/congresstrading#${t.Representative}-${t.Ticker}-${t.TransactionDate}`;
      if (getTradingSignalByUrl(signalUrl)) continue;
      const direction = t.Transaction === "Purchase" ? "long"
        : t.Transaction.startsWith("Sale") ? "short"
          : "neutral";
      if (direction === "neutral") continue;
      insertTradingSignal({
        source: "shadow-quiver",
        ticker: t.Ticker.toUpperCase(),
        direction,
        strength: weights.default,
        reason: `Quiver: ${t.Representative} ${t.Transaction} ${t.Ticker}${t.Range ? ` (${t.Range})` : ""}`,
        payload_json: JSON.stringify(t),
        source_url: signalUrl,
      });
      total++;
    }
  } catch (err) {
    log.error("quiver poll failed", { error: String(err) });
  }

  // Autopilot: celebrity/politician portfolios
  try {
    const holdings = await fetchAutopilotLeaderboard();
    log.info("autopilot holdings fetched", { count: holdings.length });
    for (const h of holdings) {
      const signalUrl = `https://joinautopilot.com/pilots#${h.portfolio}-${h.ticker}-${h.lastUpdated ?? ""}`;
      if (getTradingSignalByUrl(signalUrl)) continue;
      const direction = h.action?.toLowerCase().includes("sold") ? "short" : "long";
      insertTradingSignal({
        source: "shadow-autopilot",
        ticker: h.ticker,
        direction,
        strength: weights.default,
        reason: `Autopilot ${h.portfolio} holding ${h.ticker}`,
        payload_json: JSON.stringify(h),
        source_url: signalUrl,
      });
      total++;
    }
  } catch (err) {
    log.error("autopilot poll failed", { error: String(err) });
  }

  log.info("afterhour/fallbacks shadow poll complete", { total });
  return total;
}
