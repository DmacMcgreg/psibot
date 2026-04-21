import { createLogger } from "../shared/logger.ts";

const log = createLogger("capture:ticker-filter");

const COMMON_FALSE_POSITIVES = new Set([
  "A", "I", "DD", "YOLO", "FD", "ATH", "ATL", "IV", "OI", "PE", "PT", "AH", "PM",
  "ETF", "IPO", "SEC", "FDA", "CEO", "CFO", "COO", "CTO", "CIO", "USD", "EUR",
  "GDP", "CPI", "PPI", "PCE", "FOMC", "GMT", "EST", "PST", "ET", "UK", "US",
  "AI", "ML", "LLM", "AR", "VR", "API", "CEO", "ESG", "EV", "ICE", "LNG", "OPEC",
  "OP", "UP", "DOWN", "BUY", "SELL", "HOLD", "LONG", "SHORT", "PUTS", "CALLS",
  "ITM", "OTM", "ATM", "MOD", "POST", "EDIT", "DAY", "MON", "TUE", "WED", "THU",
  "FRI", "SAT", "SUN", "JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG",
  "SEP", "OCT", "NOV", "DEC", "Q1", "Q2", "Q3", "Q4", "EOD", "BOE", "Y2K",
  "RIP", "LOL", "TLDR", "IMO", "IMHO", "OMG", "WTF", "FYI", "DM", "PSA", "ELI",
  "ELI5", "OC", "SAFE", "HUGE", "BIG", "NEW", "OLD", "ALL", "ANY", "MAX", "MIN",
  "YES", "NO", "WAS", "ARE", "OUR", "HER", "HIS", "YOU", "YOUR", "MINE", "ONE",
  "TWO", "WTH", "TBH", "GTFO", "AFAIK", "ROI", "PNL", "PL", "WSB", "REIT",
  "HODL", "BTFD", "MOASS", "FOMO", "HYSA", "CDS", "CDO", "MBS",
  "NYSE", "NYC", "LA", "SF", "DC", "VP", "SVP", "EVP", "GOP", "DEM",
  "AM", "PM", "OK", "TV", "PC", "PS", "PS5", "XR", "VR", "OS",
]);

let cachedUniverse: Set<string> | null = null;

export async function loadTickerUniverse(): Promise<Set<string>> {
  if (cachedUniverse) return cachedUniverse;
  try {
    const res = await fetch("http://localhost:8000/api/v1/universes/sp500", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json() as { symbols?: string[] };
      if (Array.isArray(data.symbols)) {
        cachedUniverse = new Set(data.symbols.map((s) => s.toUpperCase()));
        log.info("Loaded ticker universe from backend", { count: cachedUniverse.size });
        return cachedUniverse;
      }
    }
  } catch (err) {
    log.warn("Failed to load ticker universe from backend, using fallback", { error: String(err) });
  }
  cachedUniverse = new Set(FALLBACK_UNIVERSE);
  return cachedUniverse;
}

const FALLBACK_UNIVERSE = [
  "SPY","QQQ","DIA","IWM","VXX","UVXY","TQQQ","SQQQ","SOXL","SOXS","TMF","TLT",
  "AAPL","MSFT","GOOGL","GOOG","AMZN","META","NVDA","TSLA","AMD","NFLX","INTC",
  "AVGO","ORCL","CSCO","CRM","ADBE","PYPL","SHOP","SQ","PLTR","SNOW","COIN",
  "JPM","BAC","WFC","C","GS","MS","BRK.B","V","MA","AXP","SCHW","BLK",
  "JNJ","PFE","MRK","UNH","LLY","ABBV","TMO","ABT","BMY","GILD","CVS","CI",
  "WMT","COST","TGT","HD","LOW","NKE","SBUX","MCD","DIS","CMCSA","T","VZ",
  "XOM","CVX","COP","OXY","SLB","EOG","PSX","VLO","MPC","HAL","BKR","DVN",
  "F","GM","BA","CAT","DE","GE","HON","MMM","UPS","FDX","LMT","RTX","NOC","GD",
  "DUK","SO","NEE","AEP","EXC","XEL","D","SRE","EIX","PEG","AWK",
  "AMT","PLD","CCI","EQIX","SPG","O","WELL","PSA","DLR","EQR","AVB","ESS",
  "GLD","SLV","IAU","GDX","GDXJ","DBA","USO","UNG","UCO","SCO","BOIL","KOLD",
  "XLE","XLF","XLK","XLV","XLP","XLY","XLI","XLB","XLU","XLRE","XLC",
  "ARKK","ARKG","ARKF","ARKW","ARKQ","ARKX","SMH","SOXX","SOXQ","ITB","XHB",
  "HYG","LQD","AGG","BND","SHY","IEF","TIP","MUB","EMB",
  "EEM","EFA","FXI","ASHR","KWEB","EWZ","EWJ","INDA","VWO","IEMG",
  "GME","AMC","BBBY","BB","PLTR","HOOD","SOFI","RIVN","LCID","NIO","XPEV","LI",
  "MU","TSM","ASML","QCOM","TXN","MRVL","AMAT","LRCX","KLAC","ON","ADI",
  "NEM","FCX","AA","X","CLF","NUE","STLD","MP","LAC","ALB","SQM","MOS","CF",
  "DAL","UAL","AAL","LUV","SAVE","JBLU","ALK","CCL","RCL","NCLH","MAR","HLT",
  "UBER","LYFT","DASH","ABNB","BKNG","EXPE","TRIP","Z","ZG","REDFIN",
  "CRM","WDAY","NOW","INTU","ADP","PAYC","OKTA","CRWD","PANW","FTNT","ZS","NET",
  "ROKU","SPOT","TTD","PINS","SNAP","TWLO","FSLR","ENPH","SEDG","PLUG","FCEL",
  "NVAX","MRNA","BNTX","REGN","VRTX","BIIB","AMGN","CELG","ISRG","SYK","MDT",
  "BABA","JD","PDD","BIDU","NTES","BILI","IQ","HUYA","DIDI","TCOM",
  "GS","MS","CS","DB","UBS","BARC","HSBC","BCS","ING","SAN","RY","TD","BMO",
  "PM","MO","BTI","KO","PEP","KDP","MDLZ","KHC","CL","PG","CLX","CHD","EL",
  "WBA","CVS","RAD","HUM","CI","ANTM","CNC","MOH","HCA","UHS","THC","DVA",
  "LMT","NOC","RTX","BA","GD","HEI","TDG","LHX","HII","TXT","SPR",
];
export function extractTickers(text: string, universe: Set<string>): string[] {
  const found = new Set<string>();
  const matches = text.match(/\$?[A-Z]{1,5}(?:\.[A-Z])?\b/g);
  if (!matches) return [];
  for (const raw of matches) {
    const sym = raw.replace(/^\$/, "").toUpperCase();
    if (sym.length < 2 || sym.length > 5) continue;
    if (COMMON_FALSE_POSITIVES.has(sym)) continue;
    if (universe.has(sym)) {
      found.add(sym);
    } else if (raw.startsWith("$") && sym.length >= 2 && sym.length <= 5) {
      // Dollar-sign prefix is strong signal even for non-S&P names (small caps)
      found.add(sym);
    }
  }
  return Array.from(found);
}

export function inferDirection(text: string): "long" | "short" | "neutral" {
  const lower = text.toLowerCase();
  const longSignals = [
    "\\bcalls?\\b", "\\bbull", "\\blong\\b", "\\bbuy\\b", "\\bmoon", "\\brocket",
    "\\byolo\\b", "\\bsqueeze\\b", "\\bbreakout\\b", "\\bbuying\\b", "\\bholding\\b",
  ];
  const shortSignals = [
    "\\bputs?\\b", "\\bbear", "\\bshort\\b", "\\bsell\\b", "\\bcrash\\b", "\\bdump\\b",
    "\\bdumping\\b", "\\bselling\\b", "\\bshorting\\b", "\\bcollapse\\b",
  ];
  let longScore = 0;
  let shortScore = 0;
  for (const p of longSignals) {
    const m = lower.match(new RegExp(p, "g"));
    if (m) longScore += m.length;
  }
  for (const p of shortSignals) {
    const m = lower.match(new RegExp(p, "g"));
    if (m) shortScore += m.length;
  }
  if (longScore === 0 && shortScore === 0) return "neutral";
  if (longScore > shortScore * 1.5) return "long";
  if (shortScore > longScore * 1.5) return "short";
  return "neutral";
}
