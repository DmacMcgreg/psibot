import { insertTradingSignal, getTradingSignalByUrl } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("capture:openinsider");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

interface InsiderRow {
  filingDate: string;
  tradeDate: string;
  ticker: string;
  companyName: string;
  insiderName: string;
  title: string;
  tradeType: string;
  price: number;
  qty: number;
  owned: number;
  valueUsd: number;
  filingId: string;
}

function normalizeWhitespace(html: string): string {
  return html.replace(/<br\s*\/?>/gi, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return normalizeWhitespace(html.replace(/<[^>]+>/g, ""));
}

function parseMoney(text: string): number {
  const cleaned = text.replace(/[\$,+]/g, "").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseInsiderTable(html: string): InsiderRow[] {
  const rows: InsiderRow[] = [];
  const tableMatch = html.match(/<table[^>]*class="tinytable"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return rows;
  const tbodyMatch = tableMatch[1].match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const body = tbodyMatch ? tbodyMatch[1] : tableMatch[1];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch: RegExpExecArray | null;
  while ((trMatch = trRegex.exec(body)) !== null) {
    const cells: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch: RegExpExecArray | null;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(tdMatch[1]);
    }
    if (cells.length < 13) continue;
    const filingIdMatch = cells[0].match(/track\/(\d+)/);
    const filingId = filingIdMatch ? filingIdMatch[1] : stripTags(cells[0]);
    const row: InsiderRow = {
      filingDate: stripTags(cells[1]),
      tradeDate: stripTags(cells[2]),
      ticker: stripTags(cells[3]).toUpperCase(),
      companyName: stripTags(cells[4]),
      insiderName: stripTags(cells[5]),
      title: stripTags(cells[6]),
      tradeType: stripTags(cells[7]),
      price: parseMoney(cells[8]),
      qty: parseMoney(cells[9]),
      owned: parseMoney(cells[10]),
      valueUsd: parseMoney(cells[12]),
      filingId,
    };
    if (!row.ticker || !/^[A-Z]{1,5}$/.test(row.ticker)) continue;
    rows.push(row);
  }
  return rows;
}

function titleMultiplier(title: string): number {
  const t = title.toLowerCase();
  if (t.includes("ceo") || t.includes("chief executive")) return 2.5;
  if (t.includes("cfo") || t.includes("chief financial")) return 2.0;
  if (t.includes("coo") || t.includes("chief operating")) return 1.8;
  if (t.includes("president")) return 1.6;
  if (t.includes("director")) return 1.3;
  if (t.includes("10%") || t.includes("beneficial owner")) return 1.2;
  return 1.0;
}

function buildStrength(row: InsiderRow, isCluster: boolean): number {
  const base = Math.min(1, Math.log10(Math.max(10000, row.valueUsd)) / 7);
  const mult = titleMultiplier(row.title);
  const clusterBoost = isCluster ? 1.3 : 1.0;
  return Math.min(1, base * mult * clusterBoost / 3);
}

async function fetchPage(path: string): Promise<string> {
  const url = `http://openinsider.com/${path}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept": "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function pollOpenInsider(): Promise<number> {
  let total = 0;

  // Top insider purchases (weekly) - individual high-conviction buys
  try {
    const html = await fetchPage("top-insider-purchases-of-the-week");
    const rows = parseInsiderTable(html);
    log.info("OpenInsider top purchases fetched", { count: rows.length });
    for (const row of rows) {
      if (!row.tradeType.toUpperCase().includes("P")) continue; // P = Purchase
      const signalUrl = `https://openinsider.com/track/${row.filingId}`;
      if (getTradingSignalByUrl(signalUrl)) continue;
      const strength = buildStrength(row, false);
      insertTradingSignal({
        source: "openinsider",
        ticker: row.ticker,
        direction: "long",
        strength,
        reason: `Insider buy: ${row.insiderName} (${row.title}) purchased $${Math.round(row.valueUsd).toLocaleString()} of ${row.ticker} @ $${row.price}`,
        payload_json: JSON.stringify({
          type: "top_purchase",
          company: row.companyName,
          insider: row.insiderName,
          title: row.title,
          trade_date: row.tradeDate,
          filing_date: row.filingDate,
          price: row.price,
          qty: row.qty,
          value: row.valueUsd,
          owned_after: row.owned,
        }),
        source_url: signalUrl,
      });
      total++;
    }
  } catch (err) {
    log.error("Top insider purchases fetch failed", { error: String(err) });
  }

  // Cluster buys (3+ insiders at same co within 30d) - strongest signal
  try {
    const html = await fetchPage("latest-cluster-buys");
    const rows = parseInsiderTable(html);
    log.info("OpenInsider cluster buys fetched", { count: rows.length });

    // Group by ticker to aggregate cluster strength
    const byTicker = new Map<string, InsiderRow[]>();
    for (const row of rows) {
      if (!row.tradeType.toUpperCase().includes("P")) continue;
      const existing = byTicker.get(row.ticker) ?? [];
      existing.push(row);
      byTicker.set(row.ticker, existing);
    }

    for (const [ticker, tickerRows] of byTicker.entries()) {
      if (tickerRows.length < 3) continue; // Only real clusters
      for (const row of tickerRows) {
        const signalUrl = `https://openinsider.com/track/${row.filingId}`;
        if (getTradingSignalByUrl(signalUrl)) continue;
        const strength = buildStrength(row, true);
        insertTradingSignal({
          source: "openinsider",
          ticker,
          direction: "long",
          strength,
          reason: `Cluster buy (${tickerRows.length} insiders): ${row.insiderName} (${row.title}) $${Math.round(row.valueUsd).toLocaleString()}`,
          payload_json: JSON.stringify({
            type: "cluster_buy",
            cluster_size: tickerRows.length,
            company: row.companyName,
            insider: row.insiderName,
            title: row.title,
            trade_date: row.tradeDate,
            filing_date: row.filingDate,
            price: row.price,
            qty: row.qty,
            value: row.valueUsd,
          }),
          source_url: signalUrl,
        });
        total++;
      }
    }
  } catch (err) {
    log.error("Cluster buys fetch failed", { error: String(err) });
  }

  log.info("OpenInsider poll complete", { total });
  return total;
}
