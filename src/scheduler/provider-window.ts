import { getOpsState, setOpsState } from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("scheduler:provider-window");

/**
 * The 04:00Z provider-window collision (goal "PsiBot scheduled jobs stop
 * failing silently"): jobs 12/32/34 (plus storm-mates 70/62) fire into an
 * already-exhausted GLM 5-hour usage window and die with the [1308]
 * envelope — job_runs 10320-10324, 10352/10353. This module is the
 * scheduler's answer: parse the envelope's own reset clock, share the
 * deadline in ops_state so later fires defer past it, and stagger the runs
 * released at the window opening so the trio does not re-collide there.
 *
 * The failed run itself stays a classified error row exactly as 5ac7324
 * landed it — this layer only adds "when to try again", never "call it
 * something other than a failure".
 */

/** ops_state key: ISO deadline (plus buffer) until which provider fires defer. */
export const PROVIDER_WINDOW_STATE_KEY = "scheduler:provider-window-reset-until";

/**
 * Safety added to every parsed reset: the provider's clock has shown ~2s of
 * lag against the retry-after header, and a fire racing the exact deadline
 * re-enters the tail of the exhausted window.
 */
export const PROVIDER_WINDOW_BUFFER_MS = 60_000;

/**
 * Space between runs released at the same window opening, so three jobs
 * retrying at one deadline do not re-create the collision 5 hours later.
 */
export const WINDOW_RUN_STAGGER_MS = 30_000;

/**
 * The envelope says "5 hour"; anything parsed beyond that (e.g. a corrupt
 * year) is garbage, not a schedule. Primary and fallback deltas are both
 * rejected past this cap.
 */
const MAX_USAGE_LIMIT_WAIT_MS = 5 * 60 * 60 * 1000;

/**
 * The provider stamps its own clock UTC+8 across every census specimen
 * (10:00:00Z starts stamp 18:00 provider). Only used when the request-id
 * clock itself is corrupt and the reset must be placed against `now`.
 */
const PROVIDER_ZONE_SUFFIX = "+08:00";

/**
 * The [1308] usage-limit envelope. The reset sentence and the request-id
 * bracket are both provider-clock strings; shapes seen live:
 * - "API Error: Request rejected (429) · [1308][Usage limit reached for 5
 *   hour. Your limit will reset at 2026-10-05 12:12:52][20261005120002e…]"
 * - the JSON dialect: 429 {"…rate_limit_error","code":"1308","message":"[1308]
 *   [Usage limit reached for 5 hour. Your limit will reset at …][stamp]"}
 * Both embed the same bracket triple, so one pattern answers both.
 */
const USAGE_LIMIT_ENVELOPE =
  /\[1308\]\[Usage limit reached for 5 hour\. Your limit will reset at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]\[(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/;

/**
 * Milliseconds until the window resets, parsed from the failure text's own
 * clock, or null when the text is not a [1308] usage-limit envelope (or its
 * numbers are corrupt — a garbage reset must never schedule anything).
 *
 * Primary: reset − request-id stamp. Both sit in the provider's zone, so the
 * difference needs no zone at all. Fallback (row 10324's request id really
 * carries a corrupt date, month 10 day 50): place the reset sentence in the
 * fixed UTC+8 provider zone and subtract `now`.
 */
export function usageLimitRetryMs(text: string, now: Date = new Date()): number | null {
  const m = USAGE_LIMIT_ENVELOPE.exec(text);
  if (!m) return null;
  const [, ry, rmo, rd, rh, rmi, rs, sy, smo, sd, sh, smi, ss] = m;
  const reset = Date.parse(`${ry}-${rmo}-${rd}T${rh}:${rmi}:${rs}${PROVIDER_ZONE_SUFFIX}`);

  const stamp = Date.parse(`${sy}-${smo}-${sd}T${sh}:${smi}:${ss}${PROVIDER_ZONE_SUFFIX}`);
  if (!Number.isNaN(stamp)) {
    const delta = reset - stamp;
    return delta > 0 && delta <= MAX_USAGE_LIMIT_WAIT_MS ? delta : null;
  }

  if (Number.isNaN(stamp) && !Number.isNaN(reset)) {
    const delta = reset - now.getTime();
    return delta > 0 && delta <= MAX_USAGE_LIMIT_WAIT_MS ? delta : null;
  }
  return null;
}

/**
 * Record that the provider window is exhausted until the parsed reset (plus
 * buffer), keeping the LATER of overlapping deadlines — a storm-mate's
 * shorter report must never shorten a window another run already opened.
 * Returns the deadline now in force.
 */
export function noteProviderWindowExhausted(retryMs: number, now: Date = new Date()): Date {
  const candidate = new Date(now.getTime() + retryMs + PROVIDER_WINDOW_BUFFER_MS);
  const existing = providerWindowResetUntil(now);
  const deadline = existing && existing.getTime() > candidate.getTime() ? existing : candidate;
  setOpsState(PROVIDER_WINDOW_STATE_KEY, deadline.toISOString());
  log.warn("Provider usage window exhausted — deferring provider fires", {
    until: deadline.toISOString(),
    retryMs,
  });
  return deadline;
}

/**
 * The deadline a provider fire must defer past, or null once it has passed
 * (a stale row never read as an active window).
 */
export function providerWindowResetUntil(now: Date = new Date()): Date | null {
  const raw = getOpsState(PROVIDER_WINDOW_STATE_KEY);
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return t > now.getTime() ? new Date(t) : null;
}

/**
 * How long the run in `slot` should wait before firing into a freshly
 * opened window: the distance to the deadline, plus `slot` staggers so
 * simultaneous releases do not collide at the opening. Once the deadline
 * has passed only the stagger remains.
 */
export function staggeredWindowWait(until: Date, slot: number, now: Date = new Date()): number {
  return Math.max(0, until.getTime() - now.getTime()) + slot * WINDOW_RUN_STAGGER_MS;
}
