import { createLogger } from "../shared/logger.ts";

const log = createLogger("capture:shadow-helper");

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export async function fetchHtml(url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn("HTTP error", { url, status: res.status });
      return null;
    }
    return res.text();
  } catch (err) {
    log.warn("Fetch failed", { url, error: String(err) });
    return null;
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 20000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log.warn("JSON HTTP error", { url, status: res.status });
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.warn("JSON fetch failed", { url, error: String(err) });
    return null;
  }
}

export async function browserFetchContent(url: string, waitMs = 5000): Promise<string | null> {
  try {
    const openProc = Bun.spawn(
      ["agent-browser", "open", url, "--wait", "networkidle"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await openProc.exited;
    if (openProc.exitCode !== 0) {
      log.warn("browser open failed", { url, code: openProc.exitCode });
      return null;
    }
    await new Promise((r) => setTimeout(r, waitMs));
    const readProc = Bun.spawn(
      ["agent-browser", "read"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(readProc.stdout).text();
    await readProc.exited;
    if (readProc.exitCode !== 0) return null;
    return text;
  } catch (err) {
    log.warn("browser fetch failed", { url, error: String(err) });
    return null;
  }
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ShadowWeights {
  tipranks: Record<string, number>;
  c2zulu: Record<string, number>;
  afterhour: Record<string, number>;
  default: number;
}

let cachedWeights: ShadowWeights | null = null;

export async function loadShadowWeights(): Promise<ShadowWeights> {
  if (cachedWeights) return cachedWeights;
  try {
    const file = Bun.file("knowledge/trading/shadow-weights.yaml");
    if (await file.exists()) {
      const text = await file.text();
      cachedWeights = parseYamlWeights(text);
      return cachedWeights;
    }
  } catch (err) {
    log.warn("shadow-weights.yaml load failed, using defaults", { error: String(err) });
  }
  cachedWeights = { tipranks: {}, c2zulu: {}, afterhour: {}, default: 0.5 };
  return cachedWeights;
}

function parseYamlWeights(text: string): ShadowWeights {
  const result: ShadowWeights = { tipranks: {}, c2zulu: {}, afterhour: {}, default: 0.5 };
  const lines = text.split("\n");
  let section: keyof ShadowWeights | null = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^(tipranks|c2zulu|afterhour):\s*$/.test(line)) {
      section = line.split(":")[0].trim() as keyof ShadowWeights;
      continue;
    }
    const defaultMatch = line.match(/^default:\s*([\d.]+)/);
    if (defaultMatch) {
      result.default = parseFloat(defaultMatch[1]);
      continue;
    }
    if (section && section !== "default") {
      const entryMatch = line.match(/^\s+"?([^":]+)"?:\s*([\d.]+)/);
      if (entryMatch) {
        const bucket = result[section] as Record<string, number>;
        bucket[entryMatch[1].trim()] = parseFloat(entryMatch[2]);
      }
    }
  }
  return result;
}
