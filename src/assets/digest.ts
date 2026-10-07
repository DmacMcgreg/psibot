/**
 * "Act on these": the asset surfaces that come to David instead of waiting
 * for him to go and look.
 *
 * - Daily digest, 08:10 America/Toronto: ONE Telegram message with 5 assets
 *   that weren't surfaced in the last 7 days, listed by rank: up to 2 open
 *   opportunities (new or queued), and the best `new` assets for the rest,
 *   with at most 2 skills or tools in total. One line each (kind icon, linked
 *   title, next action, deadline), and one button row each: ✅ Queue, 🗂 <the
 *   kind's home action>, ✖ Dismiss. Buttons send `as:<q|f|x>:<id>` callbacks,
 *   handled by handleAssetCallback via src/telegram/keyboards.ts.
 * - Alerts, checked every 30 min from 08:00 to 22:00: any open opportunity
 *   with rank ≥ 85 and a deadline within 21 days, once per asset, and not
 *   within 24 hours of the digest (or an earlier alert) showing it.
 * - Reminders: 7 and 2 days before the deadline of a queued or in-use asset.
 *
 * Everything goes to the group's News topic (ASSET_DIGEST_TARGET=topic), or
 * to David's DM when the topic is muted, unset or the send fails.
 *
 * Dedupe lives in ops_state, so restarts never double-send:
 *   asset_digest:last_date       Toronto date of the last daily digest
 *   asset_digest:alert:<id>      when the alert for <id> went out
 *   asset_digest:remind:<id>:<7|2>
 *
 * The lead wires it: `new AssetDigestRunner({...}).start()` in src/index.ts.
 */

import { Cron } from "croner";
import { InlineKeyboard, type Bot } from "grammy";
import { createLogger } from "../shared/logger.ts";
import { escapeHtml } from "../shared/html.ts";
import { getConfig } from "../config.ts";
import { getOpsState, setOpsState, deleteOpsState, isTopicMuted, recordSentMessage } from "../db/queries.ts";
import { listAssets, markSurfaced, getAsset, mergedInto, daysUntil, localDate, type RankedAsset } from "./store.ts";
import type { AssetKind } from "./types.ts";
import { bidMemos, bidVerdictOf } from "./bid-verdicts.ts";

export { daysUntil, localDate };

const log = createLogger("assets-digest");

export const DIGEST_SIZE = 5;
/** Digest slots held for open opportunities (new or queued, deadline not passed). */
export const DIGEST_OPPORTUNITY_SLOTS = 2;
/** At most this many skills and tools, together, per digest. */
export const DIGEST_MAX_SKILLS_TOOLS = 2;
export const RESURFACE_AFTER_DAYS = 7;
/**
 * An opportunity closing within URGENT_WITHIN_DAYS, or one with a GO/MAYBE
 * bid-desk memo, comes back after this many days instead. A NO-GO memo keeps
 * it out of the digest and alerts entirely (bid-verdicts.ts).
 */
export const URGENT_RESURFACE_AFTER_DAYS = 2;
export const URGENT_WITHIN_DAYS = 7;
export const ALERT_MIN_RANK = 85;
export const ALERT_WITHIN_DAYS = 21;
/** No alert for an asset the digest (or an alert) showed this recently. */
export const ALERT_QUIET_HOURS = 24;
export const REMINDER_DAYS = [7, 2] as const;

const KEY_LAST_DATE = "asset_digest:last_date";
const keyAlert = (id: number) => `asset_digest:alert:${id}`;
const keyRemind = (id: number, d: number) => `asset_digest:remind:${id}:${d}`;

export const KIND_ICON: Record<AssetKind, string> = {
  dataset: "📊",
  tool: "🛠",
  skill: "🧩",
  technique: "🧪",
  design_ref: "🎨",
  prompt: "💬",
  opportunity: "💰",
};

/** The "🗂 File it" button: each kind's home action (src/assets/actions.ts). */
export const HOME_ACTION: Record<AssetKind, { action: string; label: string }> = {
  dataset: { action: "get", label: "Get" },
  tool: { action: "adopt", label: "Adopt" },
  skill: { action: "adopt", label: "Adopt" },
  technique: { action: "add_to_skill", label: "Add to skill" },
  prompt: { action: "add_to_skill", label: "Add to skill" },
  design_ref: { action: "send_to_design_kit", label: "To design-kit" },
  opportunity: { action: "pursue", label: "Pursue" },
};

// ─── dates (America/Toronto by default; localDate/daysUntil come from store.ts) ─

function fmtDeadline(deadline: string, now: Date, tz: string): string {
  const days = daysUntil(deadline, now, tz);
  const label = new Date(`${deadline.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
  if (days === null) return label;
  return days === 0 ? `${label} (today)` : days === 1 ? `${label} (tomorrow)` : `${label} (${days}d)`;
}

const trunc = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

// ─── selection (pure over the store) ────────────────────────────────────────

/**
 * Today's `n` picks, best rank first. Up to DIGEST_OPPORTUNITY_SLOTS go to open
 * opportunities (new or queued); the rest are the best `new` assets by rank,
 * with at most DIGEST_MAX_SKILLS_TOOLS skills and tools together. Assets
 * surfaced in the last RESURFACE_AFTER_DAYS days, and expired deadlines
 * (rank 0), are left out. Every pick is a live row: a digest button for an
 * asset merged away later is resolved by handleAssetCallback.
 */
export function selectDigestAssets(now = new Date(), n = DIGEST_SIZE, tz = "America/Toronto"): RankedAsset[] {
  const cutoff = now.getTime() - RESURFACE_AFTER_DAYS * 86_400_000;
  const urgentCutoff = now.getTime() - URGENT_RESURFACE_AFTER_DAYS * 86_400_000;
  const memos = bidMemos();
  const eligible = (a: RankedAsset) => {
    if (a.rank <= 0) return false;
    const memo = a.kind === "opportunity" ? memos.get(a.id) : undefined;
    if (memo?.verdict === "NO-GO") return false;
    if (!a.surfaced_at) return true;
    const days = a.kind === "opportunity" ? daysUntil(a.deadline, now, tz) : null;
    const urgent = memo !== undefined || (days !== null && days <= URGENT_WITHIN_DAYS);
    return Date.parse(a.surfaced_at) < (urgent ? urgentCutoff : cutoff);
  };
  const picks = listAssets({ status: ["new", "queued"], kind: "opportunity", limit: 1000, now })
    .filter(eligible)
    .slice(0, Math.min(DIGEST_OPPORTUNITY_SLOTS, n));
  let skillsTools = 0;
  for (const a of listAssets({ status: "new", limit: 1000, now }).filter(eligible)) {
    if (picks.length >= n) break;
    if (picks.some((p) => p.id === a.id)) continue;
    const packaged = a.kind === "skill" || a.kind === "tool";
    if (packaged && skillsTools >= DIGEST_MAX_SKILLS_TOOLS) continue;
    if (packaged) skillsTools++;
    picks.push(a);
  }
  return picks.sort((a, b) => b.rank - a.rank || b.value_score - a.value_score || b.id - a.id);
}

/**
 * Open opportunities worth an immediate ping: no alert yet, and not surfaced
 * (by the digest or an alert) in the last ALERT_QUIET_HOURS, so the digest and
 * an alert never ping twice about one asset in a day.
 */
export function selectAlerts(now = new Date(), tz = "America/Toronto"): RankedAsset[] {
  const quietSince = now.getTime() - ALERT_QUIET_HOURS * 3_600_000;
  const memos = bidMemos();
  return listAssets({ status: "open", kind: "opportunity", limit: 500, now }).filter((a) => {
    if (memos.get(a.id)?.verdict === "NO-GO") return false;
    const days = daysUntil(a.deadline, now, tz);
    const justSurfaced = !!a.surfaced_at && Date.parse(a.surfaced_at) > quietSince;
    return a.rank >= ALERT_MIN_RANK && days !== null && days >= 0 && days <= ALERT_WITHIN_DAYS && !justSurfaced && !getOpsState(keyAlert(a.id));
  });
}

export interface DueReminder {
  asset: RankedAsset;
  days: number;
  /** Which reminder this is: 7 or 2. */
  mark: (typeof REMINDER_DAYS)[number];
}

/** Queued / in-use assets whose 7-day or 2-day reminder is due and unsent. */
export function selectReminders(now = new Date(), tz = "America/Toronto"): DueReminder[] {
  const out: DueReminder[] = [];
  for (const a of listAssets({ status: ["queued", "in_use"], limit: 1000, now })) {
    const days = daysUntil(a.deadline, now, tz);
    if (days === null || days < 0) continue;
    const mark = days <= 2 ? 2 : days <= 7 ? 7 : null;
    if (mark === null || getOpsState(keyRemind(a.id, mark))) continue;
    out.push({ asset: a, days, mark });
  }
  return out;
}

// ─── rendering (pure) ───────────────────────────────────────────────────────

export function assetLine(a: RankedAsset, now: Date, tz = "America/Toronto", n?: number): string {
  const title = escapeHtml(trunc(a.title, 90));
  const linked = a.url ? `<a href="${escapeHtml(a.url)}">${title}</a>` : `<b>${title}</b>`;
  const next = a.next_action ? ` — ${escapeHtml(trunc(a.next_action, 150))}` : "";
  const due = a.deadline ? ` · ⏰ ${escapeHtml(fmtDeadline(a.deadline, now, tz))}` : "";
  const amount = a.kind === "opportunity" && a.amount ? ` · ${escapeHtml(a.amount)}` : "";
  const memo = a.kind === "opportunity" ? bidVerdictOf(a.id) : null;
  const verdict = memo ? ` · 🧾 ${memo.verdict}` : "";
  return `${n !== undefined ? `${n}. ` : ""}${KIND_ICON[a.kind] ?? "•"} ${linked}${next}${amount}${due}${verdict}`;
}

export function renderDigest(assets: RankedAsset[], now: Date, tz = "America/Toronto", forgeLine = ""): string {
  const day = now.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric", timeZone: tz });
  const lines = [`<b>🎯 Act on these</b> · ${escapeHtml(day)}`, ""];
  assets.forEach((a, i) => lines.push(assetLine(a, now, tz, i + 1)));
  if (forgeLine) lines.push("", `🔨 ${escapeHtml(trunc(forgeLine, 300))}`);
  return lines.join("\n");
}

/** One button row per asset: ✅ Queue · 🗂 <home action> · ✖ Dismiss. */
export function digestKeyboard(assets: RankedAsset[], numbered = true): InlineKeyboard {
  const kb = new InlineKeyboard();
  assets.forEach((a, i) => {
    const n = numbered ? `${i + 1} ` : "";
    if (i > 0) kb.row();
    kb.text(`${n}✅ Queue`, `as:q:${a.id}`)
      .text(`🗂 ${HOME_ACTION[a.kind]?.label ?? "File"}`, `as:f:${a.id}`)
      .text("✖ Dismiss", `as:x:${a.id}`);
  });
  return kb;
}

export function renderAlert(a: RankedAsset, now: Date, tz = "America/Toronto"): string {
  return [`<b>🚨 Opportunity, deadline soon</b>`, assetLine(a, now, tz), a.summary ? escapeHtml(trunc(a.summary, 280)) : ""]
    .filter(Boolean)
    .join("\n");
}

export function renderReminders(due: DueReminder[], now: Date, tz = "America/Toronto"): string {
  const lines = [`<b>⏳ Deadline reminder${due.length > 1 ? "s" : ""}</b>`];
  for (const r of due) {
    const home = r.asset.home_path ? `\n   <code>${escapeHtml(r.asset.home_path)}</code>` : "";
    lines.push(`${assetLine(r.asset, now, tz)}${home}`);
  }
  return lines.join("\n");
}

// ─── Telegram callbacks (as:<q|f|x|n>:<id>) ─────────────────────────────────

export interface AssetCallbackResult {
  ok: boolean;
  assetId: number | null;
  toast: string;
  /** Label for the button that replaces the asset's row once handled. */
  doneLabel?: string;
}

type RunAction = (id: number, action: string, input?: { note?: string | null }) => Promise<{ message: string; home_path?: string }>;

async function defaultRunAction(id: number, action: string, input?: { note?: string | null }) {
  const { runAssetAction } = await import("./actions.ts");
  return runAssetAction(id, action, input ?? {});
}

/**
 * Handle one digest button. `payload` is what follows "as:" — e.g. "q:12".
 * Never throws: failures come back as a toast.
 */
export async function handleAssetCallback(payload: string, run: RunAction = defaultRunAction): Promise<AssetCallbackResult> {
  const [verb, idStr] = payload.split(":");
  const id = Number.parseInt(idStr ?? "", 10);
  if (!Number.isFinite(id)) return { ok: false, assetId: null, toast: "Bad button" };
  if (verb === "n") return { ok: false, assetId: id, toast: "Already handled" };

  // A button can outlive its asset: merges delete duplicates, so act on the survivor.
  let asset = getAsset(id);
  for (let hop = id, n = 0; !asset && n < 5; n++) {
    const next = mergedInto(hop);
    if (next === null) break;
    asset = getAsset((hop = next));
  }
  if (!asset) return { ok: false, assetId: id, toast: "That asset no longer exists" };

  let action: string;
  let doneLabel: string;
  if (verb === "q") {
    action = "queue";
    doneLabel = "✅ Queued";
  } else if (verb === "f") {
    const home = HOME_ACTION[asset.kind];
    action = home?.action ?? "queue";
    doneLabel = `🗂 ${home?.label ?? "Filed"} ✓`;
  } else if (verb === "x") {
    action = "dismiss";
    doneLabel = "✖ Dismissed";
  } else {
    return { ok: false, assetId: id, toast: "Unknown button" };
  }

  try {
    const r = await run(asset.id, action, {});
    const toast = r.home_path ? `${r.message} → ${r.home_path}` : r.message;
    return { ok: true, assetId: id, toast: trunc(toast, 190), doneLabel: `${doneLabel}: ${trunc(asset.title, 30)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Asset button failed", { id, action, error: message });
    return { ok: false, assetId: id, toast: trunc(`Couldn't ${action.replace(/_/g, " ")}: ${message}`, 190) };
  }
}

type Button = { text: string; callback_data?: string; url?: string };

/**
 * Replace the handled asset's button row with one inert "done" button
 * (`as:n:<id>`), so the message keeps a visible record of what was done.
 */
export function markRowDone(rows: Button[][], assetId: number, label: string): Button[][] {
  const mine = (b: Button) => !!b.callback_data && /^as:[qfx]:/.test(b.callback_data) && b.callback_data.endsWith(`:${assetId}`);
  return rows.map((row) => (row.some(mine) ? [{ text: label, callback_data: `as:n:${assetId}` }] : row));
}

// ─── runner ─────────────────────────────────────────────────────────────────

export interface AssetDigestDeps {
  getBot: () => Bot | null;
  /** David's DM ids (DM target, and fallback when the topic send fails). */
  defaultChatIds: number[];
  /** Group chat for the topic target (same as the heartbeat digest). */
  digestChatId?: string;
  /** Topic id (49 = News, where heartbeat surfacing posts). */
  digestTopicId?: number;
  /** Test seam. */
  now?: () => Date;
}

export interface DigestRunResult {
  sent: boolean;
  reason?: string;
  text: string;
  assetIds: number[];
}

export class AssetDigestRunner {
  private digestCron: Cron | null = null;
  private watchCron: Cron | null = null;
  private running = false;
  private watching = false;
  private readonly now: () => Date;

  constructor(private deps: AssetDigestDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private get tz(): string {
    return getConfig().ASSET_DIGEST_TZ;
  }

  start(): void {
    const cfg = getConfig();
    if (!cfg.ASSET_DIGEST_ENABLED) {
      log.info("Asset digest disabled (ASSET_DIGEST_ENABLED=false)");
      return;
    }
    this.digestCron = new Cron(cfg.ASSET_DIGEST_CRON, { timezone: this.tz }, () => {
      this.runOnce().catch((err) => log.error("Asset digest failed", { error: String(err) }));
    });
    this.watchCron = new Cron("*/30 8-21 * * *", { timezone: this.tz }, () => {
      this.checkDeadlines().catch((err) => log.error("Asset deadline check failed", { error: String(err) }));
    });
    log.info("Asset digest runner started", { cron: cfg.ASSET_DIGEST_CRON, tz: this.tz, target: cfg.ASSET_DIGEST_TARGET });

    // Catch up once if the daemon was down at digest time this morning.
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: this.tz, hour: "2-digit", hour12: false }).format(this.now()));
    const next = this.digestCron.nextRun();
    const sentToday = getOpsState(KEY_LAST_DATE) === localDate(this.now(), this.tz);
    const pastDigestTime = !!next && localDate(next, this.tz) !== localDate(this.now(), this.tz);
    if (!sentToday && pastDigestTime && hour < 12) {
      this.runOnce().catch((err) => log.error("Asset digest catch-up failed", { error: String(err) }));
    }
  }

  stop(): void {
    this.digestCron?.stop();
    this.watchCron?.stop();
    this.digestCron = null;
    this.watchCron = null;
  }

  /**
   * Send today's digest unless it already went out today (Toronto date).
   * `force` sends again anyway; `dryRun` renders without sending or marking.
   */
  async runOnce(opts: { force?: boolean; dryRun?: boolean } = {}): Promise<DigestRunResult> {
    if (this.running) return { sent: false, reason: "already running", text: "", assetIds: [] };
    this.running = true;
    try {
      const now = this.now();
      const today = localDate(now, this.tz);
      if (!opts.force && !opts.dryRun && getOpsState(KEY_LAST_DATE) === today) {
        return { sent: false, reason: "already sent today", text: "", assetIds: [] };
      }
      const assets = selectDigestAssets(now);
      const text = assets.length ? renderDigest(assets, now, this.tz, await forgeLine()) : "";
      const ids = assets.map((a) => a.id);
      if (opts.dryRun) return { sent: false, reason: "dry run", text, assetIds: ids };
      if (assets.length === 0) {
        log.info("Asset digest: nothing new to surface");
        return { sent: false, reason: "nothing to surface", text: "", assetIds: [] };
      }

      // Claim the day before sending so an overlapping run or a crash
      // mid-send can't produce a second digest; release it if nothing went out.
      const previous = getOpsState(KEY_LAST_DATE);
      setOpsState(KEY_LAST_DATE, today);
      const delivered = await this.send(text, digestKeyboard(assets), "Act on these");
      if (!delivered) {
        if (previous) setOpsState(KEY_LAST_DATE, previous);
        else deleteOpsState(KEY_LAST_DATE);
        return { sent: false, reason: "delivery failed", text, assetIds: ids };
      }
      markSurfaced(ids);
      log.info("Asset digest sent", { assets: ids });
      return { sent: true, text, assetIds: ids };
    } finally {
      this.running = false;
    }
  }

  /** Immediate opportunity alerts and 7/2-day reminders. Each fires once. */
  async checkDeadlines(): Promise<{ alerts: number; reminders: number }> {
    if (this.watching) return { alerts: 0, reminders: 0 };
    this.watching = true;
    try {
      const now = this.now();
      let alerts = 0;
      for (const a of selectAlerts(now, this.tz)) {
        setOpsState(keyAlert(a.id), now.toISOString());
        const ok = await this.send(renderAlert(a, now, this.tz), digestKeyboard([a], false), `Alert: ${a.title}`);
        if (ok) {
          markSurfaced([a.id]);
          alerts++;
        } else {
          deleteOpsState(keyAlert(a.id));
        }
      }
      const due = selectReminders(now, this.tz);
      let reminders = 0;
      if (due.length > 0) {
        for (const r of due) {
          setOpsState(keyRemind(r.asset.id, r.mark), now.toISOString());
          // A 2-day reminder also retires the 7-day one.
          if (r.mark === 2) setOpsState(keyRemind(r.asset.id, 7), now.toISOString());
        }
        const ok = await this.send(renderReminders(due, now, this.tz), undefined, "Deadline reminders");
        if (ok) reminders = due.length;
        else for (const r of due) deleteOpsState(keyRemind(r.asset.id, r.mark));
      }
      if (alerts || reminders) log.info("Asset deadline pings sent", { alerts, reminders });
      return { alerts, reminders };
    } finally {
      this.watching = false;
    }
  }

  /**
   * Topic (heartbeat's News topic), or David's DM when the topic is muted,
   * unset or the send fails; DM only for ASSET_DIGEST_TARGET=dm. True if any
   * chat got it.
   */
  private async send(text: string, kb: InlineKeyboard | undefined, preview: string): Promise<boolean> {
    const bot = this.deps.getBot();
    if (!bot) {
      log.warn("Asset digest: no bot");
      return false;
    }
    const cfg = getConfig();
    const markup = kb ? { reply_markup: kb } : {};
    const useTopic = cfg.ASSET_DIGEST_TARGET === "topic" && !!this.deps.digestChatId;
    // Muting News quiets the group's noise, not deadlines and bids.
    const muted = useTopic && isTopicMuted(this.deps.digestChatId!, this.deps.digestTopicId ?? null);
    if (muted) log.info("Asset digest: topic muted, sending to DM");

    if (useTopic && !muted) {
      const chatId = this.deps.digestChatId!;
      const topicId = this.deps.digestTopicId ?? null;
      try {
        const sent = await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...(topicId ? { message_thread_id: topicId } : {}),
          ...markup,
        });
        recordSentMessage(chatId, sent.message_id, topicId, { source: "asset-digest", preview });
        return true;
      } catch (err) {
        log.error("Asset digest: topic send failed, falling back to DM", { error: String(err) });
      }
    }

    let any = false;
    for (const chatId of this.deps.defaultChatIds) {
      try {
        const sent = await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          ...markup,
        });
        recordSentMessage(chatId, sent.message_id, null, { source: "asset-digest", preview });
        any = true;
      } catch (err) {
        log.error("Asset digest: DM send failed", { chatId, error: String(err) });
      }
    }
    return any;
  }
}

/** First line of the skill forge's summary, or "" when the forge has nothing (or isn't there). */
async function forgeLine(): Promise<string> {
  try {
    const mod = (await import("./forge.ts")) as { forgeSummary?: () => string };
    return mod.forgeSummary?.().split("\n").find((l) => l.trim()) ?? "";
  } catch {
    return "";
  }
}

/** Convenience for src/index.ts: construct and start. */
export function startAssetDigest(deps: AssetDigestDeps): AssetDigestRunner {
  const r = new AssetDigestRunner(deps);
  r.start();
  return r;
}
