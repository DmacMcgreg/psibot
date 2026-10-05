/**
 * Minimal Jev (TypeSafe System One) client for the OpenRouter alpha decisions
 * endpoint. Ported from the reference Python client
 * (~/Volaris/code/jev-2026-09-18/jev/client.py).
 *
 * - Wire format: POST {model, state, questions} to /api/alpha/decisions.
 *   Never chat-completions. Nothing outside this module knows the URL.
 * - Question types: noul (P(true) in [0,1], no confidence field), choice
 *   (option key + probabilities + confidence), score (float over ordered
 *   levels + probabilities keyed "0".."n-1" + confidence).
 * - Every live response is cached on disk keyed by a hash of the payload, so
 *   re-runs are free and deterministic.
 * - Cost is metered from `usage.cost` and a hard budget cap stops live calls.
 *
 * The key comes from OPENROUTER_API_KEY, injected by vaultd:
 *   ~/Volaris/code/jev-2026-09-18/tools/with_key.sh bun src/relevance/cli.ts ...
 * Without the key the client runs in `offline` mode: cache hits only; a miss
 * throws JevOfflineMiss.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OPENROUTER_ALPHA = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODEL = "~typesafe/jev-latest";
/** Fallback price when a response carries no usage.cost (input, output per Mtok). */
export const PRICE_PER_MTOK = { input: 0.042, output: 0 } as const;

// ─── question builders ──────────────────────────────────────────────────────

export interface NoulQ {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}
export interface ChoiceQ {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}
export interface ScoreQ {
  type: "score";
  instructions: string;
  criteria: string[];
}
export type Question = NoulQ | ChoiceQ | ScoreQ;
export type Questions = Record<string, Question>;

export function noul(instructions: string, criteria?: { true?: string; false?: string }): NoulQ {
  const q: NoulQ = { type: "noul", instructions };
  if (criteria && (criteria.true !== undefined || criteria.false !== undefined)) {
    q.criteria = { true: criteria.true ?? "", false: criteria.false ?? "" };
  }
  return q;
}

export function choice(instructions: string, criteria: Record<string, string>): ChoiceQ {
  const n = Object.keys(criteria).length;
  if (n < 2) throw new Error(`choice needs >= 2 options, got ${n}`);
  if (n > 255) throw new Error(`choice supports <= 255 options, got ${n}`);
  return { type: "choice", instructions, criteria: { ...criteria } };
}

export function score(instructions: string, levels: string[]): ScoreQ {
  if (levels.length < 2) throw new Error("score needs >= 2 levels");
  return { type: "score", instructions, criteria: [...levels] };
}

// ─── payload + cache key (pure) ─────────────────────────────────────────────

export interface Payload {
  state: unknown;
  questions: Questions;
}

/** JSON with object keys sorted recursively — the cache-key canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function buildBody(payload: Payload, model: string): Record<string, unknown> {
  return { model, state: payload.state, questions: payload.questions };
}

/** Cache key covers model + state + questions, so a model bump invalidates. */
export function cacheKey(payload: Payload, model: string): string {
  return createHash("sha256").update(canonicalJson(buildBody(payload, model))).digest("hex");
}

// ─── parsed response ────────────────────────────────────────────────────────

export interface RawAnswer {
  type?: string;
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface RawResponse {
  model?: string;
  id?: string;
  answers?: Record<string, RawAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
  error?: unknown;
}

export interface JevResult {
  answers: Record<string, RawAnswer>;
  source: "live" | "cache";
  cost: number;
  inputTokens: number;
  model: string | null;
}

export function costOf(raw: RawResponse): number {
  const u = raw.usage ?? {};
  if (typeof u.cost === "number") return u.cost;
  return ((u.input_tokens ?? 0) / 1e6) * PRICE_PER_MTOK.input
    + ((u.output_tokens ?? 0) / 1e6) * PRICE_PER_MTOK.output;
}

/** Expected level of a score answer from its probability distribution. */
export function expectedScore(a: RawAnswer | undefined): number | null {
  if (!a) return null;
  const p = a.probabilities;
  if (p && Object.keys(p).length > 0) {
    let s = 0;
    let tot = 0;
    for (const [k, v] of Object.entries(p)) {
      const lvl = Number(k);
      if (Number.isFinite(lvl)) {
        s += lvl * v;
        tot += v;
      }
    }
    if (tot > 0) return s / tot;
  }
  return typeof a.score === "number" ? a.score : null;
}

// ─── errors ─────────────────────────────────────────────────────────────────

export class JevBudgetExceeded extends Error {}
export class JevOfflineMiss extends Error {}

// ─── client ─────────────────────────────────────────────────────────────────

export interface JevClientOptions {
  model?: string;
  cacheDir?: string;
  /** Hard cap on live spend for this client's lifetime, US$. */
  budgetUsd?: number;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  /** Override the key (tests); defaults to process.env.OPENROUTER_API_KEY. */
  apiKey?: string | null;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

export class JevClient {
  readonly model: string;
  readonly cacheDir: string;
  readonly budgetUsd: number;
  readonly concurrency: number;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly mode: "live" | "offline";
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  totalCost = 0;
  liveCalls = 0;
  cacheHits = 0;
  inputTokens = 0;
  /** Cost committed by in-flight calls (estimate) so parallel calls respect the cap. */
  private reserved = 0;
  private lastCallCost = 0.0001;

  constructor(opts: JevClientOptions = {}) {
    this.model = opts.model ?? process.env.JEV_MODEL ?? DEFAULT_MODEL;
    this.cacheDir = opts.cacheDir ?? "data/jev-cache";
    this.budgetUsd = opts.budgetUsd ?? 1.0;
    this.concurrency = opts.concurrency ?? 8;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.retries = opts.retries ?? 2;
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : (process.env.OPENROUTER_API_KEY ?? null);
    this.mode = this.apiKey ? "live" : "offline";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private cachePath(key: string): string {
    return join(this.cacheDir, key.slice(0, 2), `${key}.json`);
  }

  private cacheGet(key: string): RawResponse | null {
    const p = this.cachePath(key);
    if (!existsSync(p)) return null;
    try {
      return (JSON.parse(readFileSync(p, "utf-8")) as { response: RawResponse }).response;
    } catch {
      return null;
    }
  }

  private cachePut(key: string, response: RawResponse): void {
    const p = this.cachePath(key);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ response, model: this.model, ts: Date.now() }));
    renameSync(tmp, p);
  }

  /** True when this payload is already cached (no spend needed). */
  isCached(payload: Payload): boolean {
    return existsSync(this.cachePath(cacheKey(payload, this.model)));
  }

  async ask(payload: Payload): Promise<JevResult> {
    const key = cacheKey(payload, this.model);
    const cached = this.cacheGet(key);
    if (cached) {
      this.cacheHits++;
      return {
        answers: cached.answers ?? {},
        source: "cache",
        cost: 0,
        inputTokens: cached.usage?.input_tokens ?? 0,
        model: cached.model ?? null,
      };
    }
    if (this.mode === "offline") {
      throw new JevOfflineMiss("No OPENROUTER_API_KEY and payload not cached");
    }
    const estimate = this.lastCallCost * 1.5;
    if (this.totalCost + this.reserved + estimate > this.budgetUsd) {
      throw new JevBudgetExceeded(
        `Jev budget cap $${this.budgetUsd.toFixed(4)} reached (spent $${this.totalCost.toFixed(4)})`,
      );
    }
    this.reserved += estimate;
    try {
      const raw = await this.callWithRetries(buildBody(payload, this.model));
      const cost = costOf(raw);
      this.totalCost += cost;
      this.liveCalls++;
      this.inputTokens += raw.usage?.input_tokens ?? 0;
      if (cost > 0) this.lastCallCost = Math.max(this.lastCallCost * 0.8, cost);
      this.cachePut(key, raw);
      return {
        answers: raw.answers ?? {},
        source: "live",
        cost,
        inputTokens: raw.usage?.input_tokens ?? 0,
        model: raw.model ?? null,
      };
    } finally {
      this.reserved -= estimate;
    }
  }

  /**
   * Bounded-parallel fan-out. Returns results aligned with `payloads`; a
   * failed item yields an Error in its slot (callers decide to skip or abort).
   * A budget-cap error stops scheduling further live calls.
   */
  async askMany(
    payloads: Payload[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Array<JevResult | Error>> {
    const out: Array<JevResult | Error> = new Array(payloads.length);
    let next = 0;
    let done = 0;
    let budgetHit = false;
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= payloads.length) return;
        if (budgetHit && !this.isCached(payloads[i])) {
          out[i] = new JevBudgetExceeded("budget cap reached earlier in this batch");
        } else {
          try {
            out[i] = await this.ask(payloads[i]);
          } catch (err) {
            if (err instanceof JevBudgetExceeded) budgetHit = true;
            out[i] = err instanceof Error ? err : new Error(String(err));
          }
        }
        done++;
        onProgress?.(done, payloads.length);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker));
    return out;
  }

  private async callWithRetries(body: Record<string, unknown>): Promise<RawResponse> {
    let last: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.http(body);
      } catch (err) {
        last = err;
        if (err instanceof JevFatalHttp) break;
        if (attempt < this.retries) await Bun.sleep(2000 * (attempt + 1));
      }
    }
    throw new Error(`Jev call failed after ${this.retries + 1} attempts: ${String(last)}`);
  }

  private async http(body: Record<string, unknown>): Promise<RawResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(OPENROUTER_ALPHA, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const msg = `HTTP ${res.status}: ${text.slice(0, 300)}`;
        // 4xx other than 408/429 won't succeed on retry.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
          throw new JevFatalHttp(msg);
        }
        throw new Error(msg);
      }
      const raw = JSON.parse(text) as RawResponse;
      if (raw.error) throw new Error(`API error: ${JSON.stringify(raw.error).slice(0, 300)}`);
      return raw;
    } finally {
      clearTimeout(timer);
    }
  }

  meter(): string {
    return `[jev ${this.mode} · ${this.liveCalls} live · ${this.cacheHits} cached · $${this.totalCost.toFixed(5)}]`;
  }
}

class JevFatalHttp extends Error {}
