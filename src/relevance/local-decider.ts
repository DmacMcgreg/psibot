/**
 * Local replacement for JevClient (cc-j8ti). Same ask/askMany/model surface and
 * the same answer shape, scored by a local decider checkpoint through MLX:
 * no OpenRouter key, no vault grant, no spend.
 *
 * One `uv run local-decider.py` process per askMany batch (load, score all,
 * exit). Answers are cached on disk keyed by payload hash, like Jev's.
 */

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { JevClient, cacheKey, type JevClientOptions, type JevResult, type Payload, type RawAnswer, type RawResponse } from "./jev.ts";

export interface RelevanceModelConfig {
  /** "local" (default) scores with the decider; "jev" keeps the hosted client. */
  backend?: "local" | "jev";
  small: string;
}

const CONFIG_PATH = "config/relevance-model.json";
const SCRIPT = new URL("./local-decider.py", import.meta.url).pathname;

export function loadRelevanceConfig(path = CONFIG_PATH): RelevanceModelConfig {
  const fallback: RelevanceModelConfig = { backend: "local", small: "midium-ai/decider-4b-dwq-4bit" };
  if (!existsSync(path)) return fallback;
  return { ...fallback, ...(JSON.parse(readFileSync(path, "utf-8")) as Partial<RelevanceModelConfig>) };
}

/** Run the Python scorer over payloads; returns answers aligned with the input, or an Error per slot. */
export async function runLocalDecider(
  payloads: Payload[],
  model: string,
  python: string[] = ["uv", "run", SCRIPT],
): Promise<Array<RawResponse | Error>> {
  const out: Array<RawResponse | Error> = payloads.map(() => new Error("no answer from local decider"));
  if (payloads.length === 0) return out;
  const [cmd, ...rest] = python;
  const child = spawn(cmd, [...rest, "--model", model], { stdio: ["pipe", "pipe", "inherit"] });
  const input = payloads.map((p, i) => JSON.stringify({ id: i, state: p.state, questions: p.questions })).join("\n") + "\n";
  child.stdin.end(input);
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      const rec = JSON.parse(line) as { id: number; answers?: Record<string, RawAnswer>; error?: string; model?: string; usage?: RawResponse["usage"] };
      out[rec.id] = rec.error ? new Error(rec.error) : { answers: rec.answers, model: rec.model, usage: rec.usage };
    }
  });
  const code: number = await new Promise((res) => child.on("close", (c) => res(c ?? 1)));
  if (code !== 0) {
    const err = new Error(`local-decider.py exited ${code}`);
    return out.map((o) => (o instanceof Error ? err : o));
  }
  return out;
}

export class LocalDeciderClient extends JevClient {
  private readonly runner: typeof runLocalDecider;

  constructor(opts: JevClientOptions & { runner?: typeof runLocalDecider } = {}) {
    super({
      ...opts,
      model: opts.model ?? loadRelevanceConfig().small,
      cacheDir: opts.cacheDir ?? "data/decider-cache",
      apiKey: "local", // mode "live": there is no key and no network
      budgetUsd: Number.MAX_SAFE_INTEGER,
    });
    this.runner = opts.runner ?? runLocalDecider;
  }

  async ask(payload: Payload): Promise<JevResult> {
    const [r] = await this.askMany([payload]);
    if (r instanceof Error) throw r;
    return r;
  }

  async askMany(payloads: Payload[], onProgress?: (done: number, total: number) => void): Promise<Array<JevResult | Error>> {
    const results: Array<JevResult | Error> = new Array(payloads.length);
    const todo: number[] = [];
    payloads.forEach((p, i) => {
      const hit = this.cacheRead(p);
      if (hit) {
        this.cacheHits++;
        results[i] = { answers: hit.answers ?? {}, source: "cache", cost: 0, inputTokens: hit.usage?.input_tokens ?? 0, model: hit.model ?? null };
      } else todo.push(i);
    });
    if (todo.length > 0) {
      const raws = await this.runner(todo.map((i) => payloads[i]), this.model);
      todo.forEach((i, k) => {
        const raw = raws[k];
        if (raw instanceof Error) {
          results[i] = raw;
          return;
        }
        this.liveCalls++;
        this.inputTokens += raw.usage?.input_tokens ?? 0;
        this.cacheWrite(payloads[i], raw);
        results[i] = { answers: raw.answers ?? {}, source: "live", cost: 0, inputTokens: raw.usage?.input_tokens ?? 0, model: raw.model ?? null };
      });
    }
    onProgress?.(payloads.length, payloads.length);
    return results;
  }
}
