/**
 * Jev relevance gate for discovery: ask Jev how David would rate a candidate
 * BEFORE the transcript fetch and Claude summary (about $0.44 per video,
 * measured from the analyzer's own cost log). A Jev call costs about
 * $0.0005, so one summary skipped pays for ~900 gate calls.
 *
 * The rubric is the one the /discover triage uses (src/relevance/discover-triage.ts):
 * David's Discover ratings with his reasons and notes, plus a stratified
 * sample of videos he chose himself. Only the item facts differ: a candidate
 * has no summary yet, so the gate sends title, channel, duration, tags and
 * the YouTube description.
 *
 * Nothing here writes to discover_feedback, feedback_log or
 * discover_jev_triage. Decisions land on discovery_candidates (status,
 * reason, score_breakdown_json) only.
 */

import type { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildQuestions,
  decide,
  DEFAULT_THRESHOLDS,
  excerptOf,
  loadChosenVideos,
  loadRubric,
  probsFrom,
  reasonFor,
  sampleChosen,
  type Decision,
  type ItemFacts,
  type Probs,
  type Thresholds,
  type TriageQuestionSet,
} from "../relevance/discover-triage.ts";
import { JevBudgetExceeded, JevClient, type JevResult, type Payload } from "../relevance/jev.ts";
import { createLogger } from "../shared/logger.ts";
import { decodeHtmlEntities } from "./prefilter.ts";

const log = createLogger("discovery:jev-gate");

export interface GateCandidate {
  id: number;
  videoId: string;
  title: string;
  channelTitle: string | null;
  durationSeconds: number | null;
  description?: string | null;
  tags?: string[];
}

export interface GateResult {
  candidateId: number;
  decision: Decision;
  probs: Probs;
  reason: string;
}

export interface GateRun {
  results: GateResult[];
  /** Candidates Jev could not answer (budget, network); they stay `candidate`. */
  errors: Array<{ candidateId: number; error: string }>;
  budgetHit: boolean;
  cost: number;
  liveCalls: number;
}

/** Anything that can answer Jev payloads: the in-process client or the vault subprocess. */
export interface JevAsker {
  readonly model: string;
  readonly kind: "in-process" | "vault";
  askMany(payloads: Payload[]): Promise<{ answers: Array<JevResult | Error>; cost: number; liveCalls: number }>;
}

export interface GateContext {
  qs: TriageQuestionSet;
  /** Channel title → videos David chose from it, minus channels he rejected on Discover. */
  chosenByChannel: Map<string, number>;
  rejectedChannels: Set<string>;
}

/**
 * Build the rubric once per run. Throws when David has not rated at least
 * one item each way (buildQuestions' own precondition).
 */
export function buildGateContext(db: Database, chosenSample = 40): GateContext {
  const rubric = loadRubric(db);
  const chosen = loadChosenVideos(db);
  const rejectedChannels = new Set(rubric.filter((e) => e.verdict === "not_interested" && e.by).map((e) => e.by as string));
  const chosenByChannel = new Map<string, number>();
  for (const v of chosen) chosenByChannel.set(v.channel, (chosenByChannel.get(v.channel) ?? 0) + 1);
  const sample = sampleChosen(chosen, chosenSample, new Set(rubric.map((e) => e.atlasId)));
  return { qs: buildQuestions(rubric, sample), chosenByChannel, rejectedChannels };
}

/** The facts Jev sees for a not-yet-processed candidate. */
export function candidateFacts(c: GateCandidate, chosenByChannel: Map<string, number>): ItemFacts {
  const tags = (c.tags ?? []).filter((t) => t && t.length <= 40).slice(0, 6);
  return {
    atlasId: -c.id, // not an atlas item; only used as an example-exclusion key
    title: decodeHtmlEntities(c.title),
    source: "youtube_discovery",
    topicGroup: null,
    by: c.channelTitle,
    tags,
    durationMin: c.durationSeconds ? Math.round(c.durationSeconds / 6) / 10 : null,
    hasTranscript: null,
    excerpt: excerptOf(c.description ?? "", 300),
    chosenFromChannel: c.channelTitle ? chosenByChannel.get(c.channelTitle) ?? 0 : 0,
  };
}

/** Ask Jev about each candidate and map the answers to hide / pick / unsure. */
export async function runJevGate(
  ctx: GateContext,
  candidates: GateCandidate[],
  asker: JevAsker,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<GateRun> {
  const run: GateRun = { results: [], errors: [], budgetHit: false, cost: 0, liveCalls: 0 };
  if (candidates.length === 0) return run;
  const facts = candidates.map((c) => candidateFacts(c, ctx.chosenByChannel));
  const { answers, cost, liveCalls } = await asker.askMany(facts.map((f) => ctx.qs.payloadFor(f)));
  run.cost = cost;
  run.liveCalls = liveCalls;
  candidates.forEach((c, i) => {
    const a = answers[i];
    if (!a || a instanceof Error) {
      if (a instanceof JevBudgetExceeded || (a && /budget/i.test(a.message))) run.budgetHit = true;
      else run.errors.push({ candidateId: c.id, error: (a?.message ?? "no answer").slice(0, 200) });
      return;
    }
    const f = facts[i];
    const probs = probsFrom(a.answers);
    const knownChannel = !!f.chosenFromChannel && !ctx.rejectedChannels.has(f.by ?? "");
    const decision = decide(probs, thresholds, { knownChannel });
    const keptBy = decision === "hide" || probs.pNot < thresholds.hide ? null : probs.pProtected >= thresholds.guard ? "guard" : knownChannel ? "channel" : null;
    run.results.push({
      candidateId: c.id,
      decision,
      probs,
      reason: reasonFor(decision, probs, a.answers, ctx.qs.examples, keptBy, f, knownChannel),
    });
  });
  return run;
}

// ─── askers ─────────────────────────────────────────────────────────────────

/** In-process: needs OPENROUTER_API_KEY in this process's env (cache hits work without it). */
export function inProcessAsker(budgetUsd: number, client?: JevClient): JevAsker {
  const c = client ?? new JevClient({ budgetUsd });
  return {
    model: c.model,
    kind: "in-process",
    async askMany(payloads) {
      const before = { cost: c.totalCost, live: c.liveCalls };
      const answers = await c.askMany(payloads);
      return { answers, cost: c.totalCost - before.cost, liveCalls: c.liveCalls - before.live };
    },
  };
}

const CHILD_SCRIPT = join(import.meta.dir, "jev-gate-cli.ts");

interface ChildOutput {
  answers: Array<JevResult | { error: string; budget?: boolean }>;
  cost: number;
  liveCalls: number;
  model: string;
}

/**
 * The daemon has no OpenRouter key in its env. vaultd injects it into a
 * short-lived child (`vault run`) while David's grant for the item is
 * active. stdout/stderr go to a file: vault run hangs on large stdout.
 */
export function vaultAsker(opts: { item: string; budgetUsd: number; timeoutMs?: number; vaultBin?: string; bunBin?: string }): JevAsker {
  const model = process.env.JEV_MODEL ?? "~typesafe/jev-latest";
  return {
    model,
    kind: "vault",
    async askMany(payloads) {
      const dir = join(tmpdir(), `psibot-jev-gate-${process.pid}-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const inPath = join(dir, "in.json");
      const outPath = join(dir, "out.json");
      const logPath = join(dir, "child.log");
      writeFileSync(inPath, JSON.stringify(payloads));
      try {
        const proc = Bun.spawn(
          [
            opts.vaultBin ?? "vault", "run",
            "--env", `OPENROUTER_API_KEY={{OP:${opts.item}.credential}}`,
            "--",
            "/bin/bash", "-c", `exec "$0" "$1" "$2" "$3" "$4" > "$5" 2>&1`,
            opts.bunBin ?? process.execPath, CHILD_SCRIPT, inPath, outPath, String(opts.budgetUsd), logPath,
          ],
          { cwd: process.cwd(), stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        );
        const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 180_000);
        const code = await proc.exited;
        clearTimeout(timer);
        if (!existsSync(outPath)) {
          const tail = existsSync(logPath) ? readFileSync(logPath, "utf-8").slice(-300) : "";
          throw new Error(`jev gate child exited ${code} without output ${tail}`);
        }
        const out = JSON.parse(readFileSync(outPath, "utf-8")) as ChildOutput;
        const answers = out.answers.map((a) =>
          "error" in a ? (a.budget ? new JevBudgetExceeded(a.error) : new Error(a.error)) : (a as JevResult),
        );
        return { answers, cost: out.cost, liveCalls: out.liveCalls };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** vaultd's answer for `item`: an active approval, none, or no answer at all. */
interface GrantProbe { active: boolean; errored: boolean }

async function probeVaultGrant(item: string, vaultBin: string): Promise<GrantProbe> {
  try {
    const proc = Bun.spawn([vaultBin, "grants"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(timer);
    await proc.exited;
    return { active: text.split("\n").some((l) => l.includes(item) && !/expired/i.test(l)), errored: false };
  } catch {
    return { active: false, errored: true };
  }
}

/** Why a resolution attempt could not reach Jev — the payload of the skip WARN. */
export type JevAskerSkipReason = "env key absent" | "vault grant expired" | "neither";

/**
 * Pick how to reach Jev: the in-process client when the key is in env,
 * else vaultd while a grant is active (never prompts), else null.
 *
 * Every null resolution emits exactly one WARN naming its reason, so a dead
 * gate can never read as quiet success (the 04:00Z Oct 5 fire skipped via
 * `jevMode:"unavailable"` with no log line of its own): "env key absent"
 * (no OPENROUTER_API_KEY and no vault item configured either), "vault grant
 * expired" (item configured, vaultd holds no active approval for it), or
 * "neither" (the grants probe itself failed, so neither named cause is
 * established). The sole caller `resolveJev` (index.ts) passes the reason
 * through by delegating here once per resolution attempt.
 */
export async function resolveJevAsker(opts: { item: string; budgetUsd: number; vaultBin?: string }): Promise<JevAsker | null> {
  if (process.env.OPENROUTER_API_KEY) return inProcessAsker(opts.budgetUsd);
  if (!opts.item) {
    log.warn("Jev asker unresolved — gate skipped", { reason: "env key absent" as JevAskerSkipReason, vaultItem: null });
    return null;
  }
  const grant = await probeVaultGrant(opts.item, opts.vaultBin ?? "vault");
  if (grant.active) return vaultAsker(opts);
  const reason: JevAskerSkipReason = grant.errored ? "neither" : "vault grant expired";
  log.warn("Jev asker unresolved — gate skipped", { reason, vaultItem: opts.item, ...(grant.errored ? { grantProbe: "errored" } : {}) });
  return null;
}

// ─── spend ledger ───────────────────────────────────────────────────────────

/**
 * Separate from data/relevance-bench/spend.jsonl on purpose: that ledger
 * backs the relevance CLI's --total-cap, and gate spend must not starve
 * /library smart search.
 */
export const GATE_LEDGER = "data/discovery/jev-gate-spend.jsonl";

export function recordGateSpend(entry: { runId: number; items: number; liveCalls: number; cost: number; kind: string }, path = GATE_LEDGER): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    log.warn("Could not write Jev gate ledger", { error: String(err) });
  }
}

/** Gate spend since local midnight, from the ledger. */
export function spentToday(path = GATE_LEDGER, now = new Date()): number {
  if (!existsSync(path)) return 0;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  let total = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { ts: string; cost: number };
      if (Date.parse(e.ts) >= midnight.getTime()) total += e.cost || 0;
    } catch {
      /* skip a torn line */
    }
  }
  return total;
}
