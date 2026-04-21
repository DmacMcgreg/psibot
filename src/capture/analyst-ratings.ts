import { insertTradingSignal, getTradingSignalByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("capture:analyst-ratings");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const TIER_ONE_FIRMS = new Set([
  "GOLDMAN SACHS", "MORGAN STANLEY", "JP MORGAN", "JPMORGAN", "BANK OF AMERICA",
  "BOFA", "MERRILL LYNCH", "CITIGROUP", "CITI", "WELLS FARGO", "BARCLAYS",
  "DEUTSCHE BANK", "UBS", "CREDIT SUISSE", "HSBC", "JEFFERIES", "EVERCORE",
]);

interface AnalystRating {
  ticker: string;
  firm: string;
  action: string; // Upgrade, Downgrade, Initiates, Reiterates, Maintains
  ratingFrom: string;
  ratingTo: string;
  priceTargetFrom: number | null;
  priceTargetTo: number | null;
  date: string;
  source: "benzinga" | "finviz";
  sourceUrl: string;
}

function parseFloatOrNull(s: string): number | null {
  const cleaned = s.replace(/[\$,]/g, "").trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
}

function inferDirectionFromRating(action: string, ratingTo: string, ptDelta: number | null): "long" | "short" | "neutral" {
  const a = action.toLowerCase();
  const r = ratingTo.toLowerCase();
  const upgrades = ["upgrade", "buy", "outperform", "overweight", "strong buy", "accumulate", "add"];
  const downgrades = ["downgrade", "sell", "underperform", "underweight", "strong sell", "reduce"];
  const isUpgrade = a.includes("upgrade") || upgrades.some((u) => r.includes(u));
  const isDowngrade = a.includes("downgrade") || downgrades.some((d) => r.includes(d));
  if (isUpgrade && !isDowngrade) return "long";
  if (isDowngrade && !isUpgrade) return "short";
  if (ptDelta !== null && ptDelta > 10) return "long";
  if (ptDelta !== null && ptDelta < -10) return "short";
  return "neutral";
}

function strengthFromRating(rating: AnalystRating, ptDeltaPct: number | null): number {
  const firmUpper = rating.firm.toUpperCase();
  const tierOneMatch = Array.from(TIER_ONE_FIRMS).some((f) => firmUpper.includes(f));
  const tierMult = tierOneMatch ? 2.0 : 1.0;
  const actionMult = rating.action.toLowerCase().includes("upgrade") || rating.action.toLowerCase().includes("downgrade") ? 1.5 : 1.0;
  const ptMult = ptDeltaPct !== null ? Math.min(2.0, 1 + Math.abs(ptDeltaPct) / 20) : 1.0;
  return Math.min(1, (0.3 * tierMult * actionMult * ptMult) / 2);
}

async function fetchFinvizPage(): Promise<string> {
  const url = "https://finviz.com/news.ashx?v=4";
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Finviz HTTP ${res.status}`);
  return res.text();
}

async function fetchFinvizQuote(ticker: string): Promise<string> {
  const url = `https://finviz.com/quote.ashx?t=${ticker}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "text/html" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Finviz quote HTTP ${res.status} for ${ticker}`);
  return res.text();
}

function parseFinvizAnalystTable(html: string, ticker: string): AnalystRating[] {
  const rows: AnalystRating[] = [];
  const tableMatch = html.match(/<table[^>]*class="[^"]*fullview-ratings-outer[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return rows;
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(tableMatch[1])) !== null) {
    const tdMatches = Array.from(trMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi));
    if (tdMatches.length < 5) continue;
    const cells = tdMatches.map((m) => stripTags(m[1]));
    const [date, action, firm, ratingChange, ptChange] = cells;
    if (!date || !action || !firm) continue;

    let ratingFrom = "";
    let ratingTo = ratingChange ?? "";
    const ratingArrow = ratingChange?.split("→").map((s) => s.trim()) ?? [];
    if (ratingArrow.length === 2) {
      ratingFrom = ratingArrow[0];
      ratingTo = ratingArrow[1];
    }

    let ptFrom: number | null = null;
    let ptTo: number | null = null;
    const ptArrow = ptChange?.split("→").map((s) => s.trim()) ?? [];
    if (ptArrow.length === 2) {
      ptFrom = parseFloatOrNull(ptArrow[0]);
      ptTo = parseFloatOrNull(ptArrow[1]);
    } else if (ptChange) {
      ptTo = parseFloatOrNull(ptChange);
    }

    rows.push({
      ticker: ticker.toUpperCase(),
      firm,
      action,
      ratingFrom,
      ratingTo,
      priceTargetFrom: ptFrom,
      priceTargetTo: ptTo,
      date,
      source: "finviz",
      sourceUrl: `https://finviz.com/quote.ashx?t=${ticker}#${Buffer.from(`${date}|${firm}|${action}`).toString("base64").slice(0, 16)}`,
    });
  }
  return rows;
}

function extractTickersFromFinvizNews(html: string): string[] {
  const found = new Set<string>();
  const tickerRegex = /href="quote\.ashx\?t=([A-Z]{1,5})"/g;
  let m: RegExpExecArray | null;
  while ((m = tickerRegex.exec(html)) !== null) {
    found.add(m[1].toUpperCase());
  }
  return Array.from(found);
}

function isRecent(dateStr: string, hours = 36): boolean {
  // Finviz date format: "Apr-19-26 04:15PM" or just "04:15PM"
  const now = new Date();
  if (/^\d{1,2}:\d{2}(AM|PM)/i.test(dateStr.trim())) return true; // Today
  const dm = dateStr.match(/([A-Za-z]{3})-(\d{1,2})-(\d{2})/);
  if (!dm) return false;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const mon = months[dm[1].toLowerCase()];
  if (mon === undefined) return false;
  const day = parseInt(dm[2], 10);
  const year = 2000 + parseInt(dm[3], 10);
  const date = new Date(year, mon, day);
  const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
  return diffHours <= hours;
}

export async function pollAnalystRatings(tickers?: string[]): Promise<number> {
  let total = 0;

  // If no tickers specified, scrape Finviz news to find which tickers have fresh coverage
  let targetTickers: string[] = tickers ?? [];
  if (targetTickers.length === 0) {
    try {
      const newsHtml = await fetchFinvizPage();
      targetTickers = extractTickersFromFinvizNews(newsHtml).slice(0, 40);
      log.info("Analyst ratings: discovered tickers from Finviz news", { count: targetTickers.length });
    } catch (err) {
      log.error("Finviz news fetch failed", { error: String(err) });
      targetTickers = ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "AMD", "SPY", "QQQ"];
    }
  }

  for (const ticker of targetTickers) {
    try {
      const html = await fetchFinvizQuote(ticker);
      const ratings = parseFinvizAnalystTable(html, ticker).filter((r) => isRecent(r.date, 36));
      for (const rating of ratings) {
        if (getTradingSignalByUrl(rating.sourceUrl)) continue;
        const ptDeltaPct = rating.priceTargetFrom && rating.priceTargetTo
          ? ((rating.priceTargetTo - rating.priceTargetFrom) / rating.priceTargetFrom) * 100
          : null;
        const direction = inferDirectionFromRating(rating.action, rating.ratingTo, ptDeltaPct);
        if (direction === "neutral") continue; // Only capture directional calls
        const strength = strengthFromRating(rating, ptDeltaPct);
        const ptSuffix = rating.priceTargetTo ? ` PT $${rating.priceTargetTo}` : "";
        const deltaSuffix = ptDeltaPct !== null ? ` (${ptDeltaPct >= 0 ? "+" : ""}${ptDeltaPct.toFixed(1)}%)` : "";
        insertTradingSignal({
          source: "finviz-analyst",
          ticker: rating.ticker,
          direction,
          strength,
          reason: `${rating.firm} ${rating.action}: ${rating.ratingFrom ? `${rating.ratingFrom}→` : ""}${rating.ratingTo}${ptSuffix}${deltaSuffix}`,
          payload_json: JSON.stringify(rating),
          source_url: rating.sourceUrl,
        });
        total++;
      }
      // Small polite delay between tickers
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      log.warn("Analyst ratings fetch failed", { ticker, error: String(err) });
    }
  }

  log.info("Analyst ratings poll complete", { total, tickers: targetTickers.length });
  return total;
}
