/**
 * AssetExtractRunner — every 20 minutes (outside 23:00–07:00 Toronto) it polls
 * the existing stores for new items, gates them against GOALS.md, and runs the
 * extractor on a bounded batch of the ones that pass, newest first. Every
 * decision lands in asset_extractions, so nothing is extracted twice; failed
 * items retry up to MAX_ATTEMPTS times.
 *
 * Each source keeps a watermark in ops_state (assets:wm:<source>) so a tick
 * only reads rows newer than the last fully-handled one. The backfill script
 * (scripts/assets-backfill.ts) covers history with the same processItems().
 *
 * Only an answer from the model (valid, invalid or unparseable) or an error
 * about the item itself spends one of its attempts. Service errors (quota,
 * auth, a missing model) stop the batch; transient ones (5xx, overload,
 * timeouts, network) are retried next tick, and a burst of them stops the
 * batch too. Assets the extractor marked as already owned are dismissed.
 */

import { Cron } from "croner";
import { getOpsState, setOpsState } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import { gateItems, type GateDecision, type GateInput } from "./gate.ts";
import { extractAssets, EXTRACT_VERSION, type ExtractItem, type ExtractResult } from "./extract.ts";
import { getExtraction, recordExtraction, upsertAsset } from "./store.ts";
import { dismissIfOwned } from "./owned.ts";
import { SOURCES, SOURCE_KINDS, type SourceItem, type SourceKind } from "./sources/index.ts";

const log = createLogger("asset-extract");

export const MAX_ATTEMPTS = 3;
const CRON = "*/20 * * * *";
const TZ = "America/Toronto";
const QUIET_START = 23;
const QUIET_END = 7;
const LIST_LIMIT = 1000;
const FIRST_RUN_DAYS = 3;

/** Conditions that fail every call until someone fixes them: quota, rate limits, auth, a missing model. */
const SERVICE_RE = /(?:api error|http|status|error|code)[:\s]+(?:429|401)\b|\b429 too many|rate.?limit|quota|usage limit|limit reached|hit your \w+ limit|too many requests|insufficient balance|not logged in|please run \/login|unauthori[sz]ed|invalid (?:bearer|api) (?:token|key)|authentication_error|GLM_AUTH_TOKEN|issue with the selected model/i;
/** Model-service hiccups: 5xx, overload, timeouts and aborts, dropped connections. */
const TRANSIENT_RE = /(?:api error|http|status|error|code)[:\s]+5\d\d\b|\b5\d\d (?:internal|bad gateway|service unavailable|gateway)|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|timed out|timeout|\babort(?:ed|error)?\b|terminated by signal|exited with code|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|fetch failed|socket hang up|network error|connection (?:reset|refused|closed)/i;
/** Transient errors in one batch after which it stops (an outage, not a flaky item). */
export const TRANSIENT_STOP = 2;
/** Transient failures of one item (this process) before one finally counts as an attempt, so an item that always times out can't loop forever. */
export const TRANSIENT_GRACE = 6;

export type ErrorClass = "service" | "transient" | "item";

/** Which errors spend an item's attempt: only "item" ones. The other two say nothing about the item. */
export function classifyError(msg: string): ErrorClass {
  if (SERVICE_RE.test(msg)) return "service";
  if (TRANSIENT_RE.test(msg)) return "transient";
  return "item";
}

const transientSeen = new Map<string, number>();
const itemKey = (item: Pick<SourceItem, "source_kind" | "source_ref">) => `${item.source_kind}:${item.source_ref}`;

/** Test hook: forget per-item transient counts. */
export function resetTransientCounts(): void {
  transientSeen.clear();
}

// --- one batch -----------------------------------------------------------

export interface ProcessOptions {
  maxModelCalls: number;
  concurrency: number;
  dryRun?: boolean;
  /** Test/offline hooks. */
  gate?: (items: GateInput[]) => Promise<GateDecision[]>;
  extract?: (item: ExtractItem) => Promise<ExtractResult>;
  onItem?: (item: SourceItem, d: GateDecision, r: ExtractResult | null, err?: string) => void;
}

export interface ProcessReport {
  considered: number;
  alreadyHandled: number;
  gated: number;
  passed: number;
  extracted: number;
  empty: number;
  failed: number;
  deferred: number;
  assets: number;
  created: number;
  /** Assets dismissed as already owned. */
  owned: number;
  /** Transient model errors that did not spend an attempt. */
  transient: number;
  /** The batch stopped early for a service reason (quota, auth, outage); the items keep their attempts. */
  quotaStop: boolean;
  stopReason: string | null;
  byKind: Record<string, { seen: number; passed: number }>;
  decisions: { item: SourceItem; d: GateDecision }[];
}

export function isHandled(item: Pick<SourceItem, "source_kind" | "source_ref">): boolean {
  const e = getExtraction(item.source_kind, item.source_ref, EXTRACT_VERSION);
  return !!e && (e.status !== "failed" || e.attempts >= MAX_ATTEMPTS);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>, stop: () => boolean): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    while (i < items.length && !stop()) {
      const t = items[i++];
      await fn(t);
    }
  });
  await Promise.all(workers);
}

/** Gate a list of items, then extract from up to maxModelCalls of those that pass (in list order). */
export async function processItems(items: SourceItem[], opts: ProcessOptions): Promise<ProcessReport> {
  const rep: ProcessReport = {
    considered: items.length, alreadyHandled: 0, gated: 0, passed: 0, extracted: 0, empty: 0, failed: 0,
    deferred: 0, assets: 0, created: 0, owned: 0, transient: 0, quotaStop: false, stopReason: null, byKind: {}, decisions: [],
  };
  const pending = items.filter((it) => {
    if (isHandled(it)) { rep.alreadyHandled++; return false; }
    return true;
  });
  if (!pending.length) return rep;

  const gate = opts.gate ?? gateItems;
  const decisions = await gate(pending.map((it) => ({ title: it.title, text: it.gate_text, explicit: it.explicit })));
  const pass: { item: SourceItem; d: GateDecision }[] = [];
  pending.forEach((item, i) => {
    const d = decisions[i];
    rep.decisions.push({ item, d });
    const k = (rep.byKind[item.source_kind] ??= { seen: 0, passed: 0 });
    k.seen++;
    if (d.pass) { k.passed++; rep.passed++; pass.push({ item, d }); return; }
    rep.gated++;
    if (!opts.dryRun) {
      recordExtraction({ source_kind: item.source_kind, source_ref: item.source_ref, version: EXTRACT_VERSION, status: "gated", gate_score: d.score });
    }
  });
  if (opts.dryRun) return rep;

  const batch = pass.slice(0, opts.maxModelCalls);
  rep.deferred = pass.length - batch.length;
  const extract = opts.extract ?? ((it: ExtractItem) => extractAssets(it));

  await pool(batch, opts.concurrency, async ({ item, d }) => {
    const base = { source_kind: item.source_kind, source_ref: item.source_ref, version: EXTRACT_VERSION, gate_score: d.score };
    try {
      const text = await item.loadText();
      if (text.trim().length < 150) {
        recordExtraction({ ...base, status: "empty", error: "no text" });
        rep.empty++;
        opts.onItem?.(item, d, null, "no text");
        return;
      }
      const r = await extract({
        source_kind: item.source_kind, source_ref: item.source_ref, url: item.url, title: item.title,
        text, published_at: item.published_at, context: item.context,
      });
      for (const a of r.assets) {
        const { evidence, ...asset } = a;
        const res = upsertAsset(asset, {
          source_kind: item.source_kind, source_ref: item.source_ref,
          source_url: item.url, source_title: item.title, evidence,
        });
        rep.assets++;
        if (res.created) rep.created++;
        try {
          if (await dismissIfOwned(res.id, asset)) rep.owned++;
        } catch (err) {
          log.warn("could not dismiss owned asset", { id: res.id, error: String(err) });
        }
      }
      recordExtraction({ ...base, status: r.assets.length ? "done" : "empty", n_assets: r.assets.length, model: r.model, error: r.assets.length ? null : (r.note ?? null) });
      transientSeen.delete(itemKey(item));
      if (r.assets.length) rep.extracted++; else rep.empty++;
      opts.onItem?.(item, d, r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const cls = classifyError(msg);
      if (cls === "service") {
        rep.quotaStop = true;
        rep.stopReason ??= msg.slice(0, 200);
        log.warn("model service unavailable (quota, auth or model); stopping batch", { error: msg.slice(0, 200) });
        return;
      }
      if (cls === "transient") {
        const n = (transientSeen.get(itemKey(item)) ?? 0) + 1;
        if (n < TRANSIENT_GRACE) {
          transientSeen.set(itemKey(item), n);
          rep.transient++;
          if (rep.transient >= TRANSIENT_STOP && !rep.quotaStop) {
            rep.quotaStop = true;
            rep.stopReason ??= msg.slice(0, 200);
            log.warn("repeated transient model errors; stopping batch", { error: msg.slice(0, 200) });
          }
          opts.onItem?.(item, d, null, `transient, not counted (${n}/${TRANSIENT_GRACE}): ${msg}`);
          return;
        }
        transientSeen.delete(itemKey(item)); // keeps failing: count this one
      }
      recordExtraction({ ...base, status: "failed", error: msg.slice(0, 500) });
      rep.failed++;
      opts.onItem?.(item, d, null, msg);
    }
  }, () => rep.quotaStop);
  return rep;
}

// --- watermarks ------------------------------------------------------------

const wmKey = (k: SourceKind) => `assets:wm:${k}`;

/** Parse either "YYYY-MM-DD HH:MM:SS[Z]" or ISO into epoch ms (UTC). */
export function tsOf(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
}

/**
 * The newest created_at such that every listed item at or before it is
 * handled. Items sharing one timestamp (GitHub stars land in bursts) advance
 * together or not at all.
 */
export function nextWatermark(items: Pick<SourceItem, "created_at">[], handled: (i: number) => boolean, current: string | null): string | null {
  const idx = items.map((it, i) => ({ i, t: it.created_at })).sort((a, b) => tsOf(a.t) - tsOf(b.t));
  let wm = current;
  let k = 0;
  while (k < idx.length) {
    const t = idx[k].t;
    let j = k;
    let allDone = true;
    while (j < idx.length && idx[j].t === t) { if (!handled(idx[j].i)) allDone = false; j++; }
    if (!allDone) break;
    wm = t;
    k = j;
  }
  return wm;
}

// --- runner ----------------------------------------------------------------

export function inQuietHours(d = new Date()): boolean {
  const h = Number(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", hour12: false }).format(d)) % 24;
  return h >= QUIET_START || h < QUIET_END;
}

export interface RunOnceOptions {
  maxModelCalls?: number;
  concurrency?: number;
  sources?: SourceKind[];
  force?: boolean; // ignore quiet hours
}

export class AssetExtractRunner {
  private cron: Cron | null = null;
  private running = false;

  start(): void {
    this.cron = new Cron(CRON, { protect: true, timezone: TZ }, () => {
      this.runOnce().catch((err) => log.error("asset extract tick failed", { error: String(err) }));
    });
    log.info("Asset extract runner started", { pattern: CRON, quiet: `${QUIET_START}:00-${QUIET_END}:00 ${TZ}` });
  }

  stop(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /** One tick. Never throws. */
  async runOnce(opts: RunOnceOptions = {}): Promise<ProcessReport | null> {
    if (this.running) return null;
    if (!opts.force && inQuietHours()) return null;
    this.running = true;
    try {
      const kinds = opts.sources ?? SOURCE_KINDS;
      const listed: { kind: SourceKind; items: SourceItem[]; truncated: boolean }[] = [];
      for (const kind of kinds) {
        try {
          const after = getOpsState(wmKey(kind));
          const items = SOURCES[kind].list(after ? { after, limit: LIST_LIMIT } : { sinceDays: FIRST_RUN_DAYS, limit: LIST_LIMIT });
          listed.push({ kind, items, truncated: items.length >= LIST_LIMIT * 0.9 });
        } catch (e) {
          log.warn("asset source list failed", { source: kind, error: String(e) });
        }
      }
      const all = listed.flatMap((l) => l.items).sort((a, b) => tsOf(b.created_at) - tsOf(a.created_at));
      const rep = await processItems(all, { maxModelCalls: opts.maxModelCalls ?? 12, concurrency: opts.concurrency ?? 2 });

      for (const l of listed) {
        if (l.truncated || !l.items.length) continue;
        const current = getOpsState(wmKey(l.kind));
        const wm = nextWatermark(l.items, (i) => isHandled(l.items[i]), current);
        if (wm && wm !== current) setOpsState(wmKey(l.kind), wm);
      }
      if (rep.considered - rep.alreadyHandled > 0) {
        log.info("asset extract tick", {
          considered: rep.considered, gated: rep.gated, passed: rep.passed, extracted: rep.extracted,
          empty: rep.empty, failed: rep.failed, deferred: rep.deferred, assets: rep.assets, created: rep.created,
          owned: rep.owned, transient: rep.transient, quotaStop: rep.quotaStop, stopReason: rep.stopReason,
        });
      }
      return rep;
    } catch (e) {
      log.error("asset extract tick error", { error: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      this.running = false;
    }
  }
}
