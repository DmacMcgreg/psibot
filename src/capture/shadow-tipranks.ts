import { insertTradingSignal, getTradingSignalByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { fetchJson, loadShadowWeights } from "./shadow-helper.ts";

const log = createLogger("capture:shadow-tipranks");

interface TopExpertEntry {
  expertUID: string;
  expertName: string;
  stars: number;
  actionType?: string;
  ticker?: string;
  priceTarget?: number | null;
  lastRating?: string;
  lastRatingDate?: string;
  action?: string;
  firmName?: string;
}

interface InsiderEntry {
  expertUID: string;
  name: string;
  rank: number;
  stars: number;
  lastTransactionDate: string;
  ticker: string;
  transactionType: "Buy" | "Sell" | string;
  amount: number;
  company: string;
}

async function fetchTopAnalysts(): Promise<TopExpertEntry[]> {
  const url = "https://www.tipranks.com/api/experts/GetTopStockExperts?expertType=analyst&pageSize=50&page=1";
  const data = await fetchJson<{ Experts?: TopExpertEntry[] }>(url);
  return data?.Experts ?? [];
}

async function fetchTopInsiders(): Promise<InsiderEntry[]> {
  const url = "https://www.tipranks.com/api/insiders/GetTopInsiders?pageSize=30&page=1";
  const data = await fetchJson<{ Insiders?: InsiderEntry[] }>(url);
  return data?.Insiders ?? [];
}

function expertStrength(stars: number, weights: Record<string, number>, name: string, defaultW: number): number {
  const override = weights[name];
  const base = override ?? defaultW;
  const starBoost = Math.max(1, stars) / 5;
  return Math.min(1, base * starBoost);
}

export async function pollShadowTipRanks(): Promise<number> {
  const weights = await loadShadowWeights();
  let total = 0;

  // Top analysts' recent ratings
  try {
    const experts = await fetchTopAnalysts();
    log.info("tipranks analysts fetched", { count: experts.length });
    for (const e of experts) {
      if (!e.ticker || !e.action) continue;
      const signalUrl = `https://tipranks.com/experts/analysts/${e.expertUID}#${e.ticker}-${e.lastRatingDate ?? ""}`;
      if (getTradingSignalByUrl(signalUrl)) continue;
      const action = (e.action ?? "").toLowerCase();
      const direction = action.includes("buy") || action.includes("outperform") || action.includes("overweight")
        ? "long"
        : action.includes("sell") || action.includes("underperform") || action.includes("underweight")
          ? "short"
          : "neutral";
      if (direction === "neutral") continue;
      const strength = expertStrength(e.stars, weights.tipranks, e.expertName, weights.default);
      insertTradingSignal({
        source: "shadow-tipranks",
        ticker: e.ticker,
        direction,
        strength,
        reason: `TipRanks ${e.stars}★ analyst ${e.expertName} (${e.firmName ?? "?"}) ${e.action} ${e.ticker}${e.priceTarget ? ` PT $${e.priceTarget}` : ""}`,
        payload_json: JSON.stringify(e),
        source_url: signalUrl,
      });
      total++;
    }
  } catch (err) {
    log.error("tipranks analysts failed", { error: String(err) });
  }

  // Top insiders' recent transactions
  try {
    const insiders = await fetchTopInsiders();
    log.info("tipranks insiders fetched", { count: insiders.length });
    for (const i of insiders) {
      if (!i.ticker) continue;
      const signalUrl = `https://tipranks.com/experts/insiders/${i.expertUID}#${i.ticker}-${i.lastTransactionDate}`;
      if (getTradingSignalByUrl(signalUrl)) continue;
      const direction = i.transactionType === "Buy" ? "long" : i.transactionType === "Sell" ? "short" : "neutral";
      if (direction === "neutral") continue;
      const strength = expertStrength(i.stars, weights.tipranks, i.name, weights.default);
      insertTradingSignal({
        source: "shadow-tipranks",
        ticker: i.ticker,
        direction,
        strength,
        reason: `TipRanks top insider ${i.name} ${i.transactionType} $${i.amount.toLocaleString()} ${i.ticker} (${i.company})`,
        payload_json: JSON.stringify(i),
        source_url: signalUrl,
      });
      total++;
    }
  } catch (err) {
    log.error("tipranks insiders failed", { error: String(err) });
  }

  log.info("tipranks shadow poll complete", { total });
  return total;
}
