import { insertTradingSignal, getTradingSignalByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { fetchJson, fetchHtml, loadShadowWeights, stripTags } from "./shadow-helper.ts";

const log = createLogger("capture:shadow-c2zulu");

interface ZuluTraderEntry {
  id: number;
  name: string;
  alias?: string;
  sharpeRatio?: number;
  winRate?: number;
  followers?: number;
}

interface ZuluRecentTrade {
  ticker?: string;
  symbol?: string;
  side?: "BUY" | "SELL" | string;
  action?: string;
  openTime?: string;
  openDate?: string;
}

async function fetchZuluTopTraders(): Promise<ZuluTraderEntry[]> {
  const url = "https://www.zulutrade.com/api/v3/traders?pageSize=20&sortField=profit&sortOrder=desc";
  const data = await fetchJson<{ traders?: ZuluTraderEntry[] }>(url);
  return data?.traders ?? [];
}

async function fetchZuluTraderTrades(traderId: number): Promise<ZuluRecentTrade[]> {
  const url = `https://www.zulutrade.com/api/v3/traders/${traderId}/live-positions?pageSize=10`;
  const data = await fetchJson<{ positions?: ZuluRecentTrade[] }>(url);
  return data?.positions ?? [];
}

interface C2Entry {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

async function fetchC2Feed(): Promise<C2Entry[]> {
  const url = "https://www.collective2.com/rss";
  const xml = await fetchHtml(url);
  if (!xml) return [];
  const entries: C2Entry[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml)) !== null) {
    const titleMatch = match[1].match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = match[1].match(/<link>([\s\S]*?)<\/link>/);
    const descMatch = match[1].match(/<description>([\s\S]*?)<\/description>/);
    const dateMatch = match[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!titleMatch || !linkMatch) continue;
    entries.push({
      title: stripTags(titleMatch[1]),
      link: stripTags(linkMatch[1]),
      description: stripTags(descMatch?.[1] ?? ""),
      pubDate: stripTags(dateMatch?.[1] ?? ""),
    });
  }
  return entries;
}

function extractTickerFromText(text: string): string | null {
  const m = text.match(/\b([A-Z]{1,5})(?:\.[A-Z])?\b/);
  if (!m) return null;
  const ticker = m[1];
  if (ticker.length < 2) return null;
  const blocked = new Set(["BUY", "SELL", "LONG", "SHORT", "THE", "AT", "IN", "OF", "TO", "A", "I", "RSS", "TO"]);
  if (blocked.has(ticker)) return null;
  return ticker;
}

export async function pollShadowC2Zulu(): Promise<number> {
  const weights = await loadShadowWeights();
  let total = 0;

  // ZuluTrade top traders + their recent positions
  try {
    const traders = await fetchZuluTopTraders();
    log.info("zulu traders fetched", { count: traders.length });
    for (const trader of traders.slice(0, 10)) {
      try {
        const trades = await fetchZuluTraderTrades(trader.id);
        for (const t of trades) {
          const ticker = (t.ticker ?? t.symbol ?? "").toUpperCase();
          if (!ticker || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(ticker)) continue;
          const dateKey = t.openTime ?? t.openDate ?? "";
          const signalUrl = `https://zulutrade.com/trader/${trader.id}#${ticker}-${dateKey}`;
          if (getTradingSignalByUrl(signalUrl)) continue;
          const action = (t.side ?? t.action ?? "").toUpperCase();
          const direction = action.includes("BUY") ? "long" : action.includes("SELL") ? "short" : "neutral";
          if (direction === "neutral") continue;
          const weight = weights.c2zulu[trader.name] ?? weights.default;
          const sharpe = trader.sharpeRatio ?? 0;
          const strength = Math.min(1, weight * (1 + Math.max(0, sharpe) / 4));
          insertTradingSignal({
            source: "shadow-c2zulu",
            ticker,
            direction,
            strength,
            reason: `Zulu ${trader.name} (Sharpe ${sharpe.toFixed(2)}, WR ${((trader.winRate ?? 0) * 100).toFixed(0)}%) ${action} ${ticker}`,
            payload_json: JSON.stringify({ trader, trade: t, platform: "zulutrade" }),
            source_url: signalUrl,
          });
          total++;
        }
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        log.warn("zulu trader trades failed", { trader: trader.id, error: String(err) });
      }
    }
  } catch (err) {
    log.error("zulu traders fetch failed", { error: String(err) });
  }

  // Collective2 RSS feed
  try {
    const entries = await fetchC2Feed();
    log.info("c2 rss fetched", { count: entries.length });
    for (const entry of entries) {
      const signalUrl = entry.link;
      if (getTradingSignalByUrl(signalUrl)) continue;
      const ticker = extractTickerFromText(entry.title) ?? extractTickerFromText(entry.description);
      if (!ticker) continue;
      const text = `${entry.title} ${entry.description}`.toLowerCase();
      const direction = text.includes("buy") || text.includes("long") ? "long"
        : text.includes("sell") || text.includes("short") ? "short"
          : "neutral";
      if (direction === "neutral") continue;
      insertTradingSignal({
        source: "shadow-c2zulu",
        ticker,
        direction,
        strength: weights.default,
        reason: `C2: ${entry.title.slice(0, 100)}`,
        payload_json: JSON.stringify({ entry, platform: "collective2" }),
        source_url: signalUrl,
      });
      total++;
    }
  } catch (err) {
    log.error("c2 feed failed", { error: String(err) });
  }

  log.info("c2zulu shadow poll complete", { total });
  return total;
}
