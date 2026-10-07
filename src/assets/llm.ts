/**
 * One tool-less model call that must return JSON. Shared by the asset
 * extractor, feed scorers and the skill forge.
 *
 * Tools are disabled (`tools: []`) so the model cannot open with a web call:
 * that is how GLM tool traces leaked into research notes before.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig, GLM_CLI_ENV } from "../config.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("assets-llm");

export type Tier = "haiku" | "sonnet" | "opus";
export type Backend = "glm" | "claude";

export interface AskOptions {
  tier?: Tier;         // default "opus" (glm-5.3 on the GLM backend)
  backend?: Backend;   // default "glm"; "claude" uses the daemon's Claude Max login
  timeoutMs?: number;  // default 180 s
}

export function modelName(tier: Tier, backend: Backend): string {
  const c = getConfig();
  if (backend === "claude") return tier;
  return tier === "opus" ? c.GLM_OPUS_MODEL : tier === "sonnet" ? c.GLM_SONNET_MODEL : c.GLM_HAIKU_MODEL;
}

function glmEnv(): Record<string, string> {
  const c = getConfig();
  if (!c.GLM_AUTH_TOKEN) throw new Error("GLM_AUTH_TOKEN not configured");
  // Drop inherited Claude/Anthropic session vars: when a script runs from inside
  // a Claude Code session, its host-auth vars override the GLM token (401).
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => v != null && !/^(CLAUDE|ANTHROPIC)_?/.test(k) && k !== "CLAUDECODE"),
  ) as Record<string, string>;
  return {
    ...base,
    ANTHROPIC_BASE_URL: c.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: c.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: c.GLM_HAIKU_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: c.GLM_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: c.GLM_OPUS_MODEL,
    ...GLM_CLI_ENV,
  };
}

/** Plain text reply from one tool-less turn. */
export async function askText(prompt: string, opts: AskOptions = {}): Promise<string> {
  const tier = opts.tier ?? "opus";
  const backend = opts.backend ?? "glm";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 180_000);
  let text = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: tier,
        tools: [],
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        abortController: ac,
        ...(backend === "glm" ? { env: glmEnv() } : {}),
      },
    })) {
      if (msg.type === "assistant" && msg.message) {
        text += msg.message.content
          .map((b: { type: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : ""))
          .join("");
      } else if (msg.type === "result") {
        log.debug("ask complete", { model: modelName(tier, backend), ms: msg.duration_ms });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

/** Pull the first JSON object or array out of a model reply. */
export function parseJsonReply<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const body = (fenced ?? text).trim();
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in reply");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  if (end <= start) throw new Error("unterminated JSON in reply");
  return JSON.parse(body.slice(start, end + 1)) as T;
}

/** askText + parseJsonReply, with one retry that shows the model its parse error. */
export async function askJson<T>(prompt: string, opts: AskOptions = {}): Promise<T> {
  const first = await askText(prompt, opts);
  try {
    return parseJsonReply<T>(first);
  } catch (e) {
    const retry = await askText(
      `${prompt}\n\nYour previous reply could not be parsed (${(e as Error).message}). Reply with ONLY the JSON, no prose, no code fence.`,
      opts,
    );
    return parseJsonReply<T>(retry);
  }
}
