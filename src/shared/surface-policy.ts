/**
 * Inbox surfacing policy — the SINGLE gate deciding which captured sources may be
 * posted to the Telegram inbox digest channel (the "News" topic).
 *
 * Why this exists: content reaches the channel through MORE THAN ONE path. The
 * discovery digest (src/discovery/index.ts, gated by DISCOVERY_SURFACE_TELEGRAM)
 * is one; the heartbeat inbox digest (src/heartbeat/index.ts phaseSurfacing +
 * surfaceBacklog) is another. Silencing one does NOT silence the other. Every
 * processed YouTube video is queued into pending_items (src/youtube/process.ts)
 * so it flows through triage + atlas indexing that the Mini App Discover feed
 * (/tma/discover) reads — but it must never be pushed to the channel like a
 * Reddit/GitHub capture. Before this gate existed, YouTube summaries leaked to
 * News via the heartbeat path even after the discovery digest was silenced.
 *
 * RULE: any code path that posts pending_items to the channel MUST filter through
 * isInboxSurfaceable() (in-memory) or INBOX_SURFACEABLE_SQL (query layer). Adding
 * a new surfacing path without this gate will re-introduce the leak.
 *
 * See docs/plans/2026-07-15-discover-mini-app.md.
 */
import type { CaptureSource } from "./types.ts";

/**
 * Sources whose content lives ONLY in the Discover feed, never the inbox channel.
 * Add a source here to keep its captures out of every Telegram inbox surfacing.
 */
export const DISCOVER_ONLY_SOURCES: readonly CaptureSource[] = ["youtube"] as const;

/** True if an item's source is allowed to be surfaced to the inbox channel. */
export function isInboxSurfaceable(item: { source?: string | null }): boolean {
  return !DISCOVER_ONLY_SOURCES.includes((item.source ?? "") as CaptureSource);
}

/**
 * SQL predicate (usable in a WHERE clause) excluding Discover-only sources.
 * Values are hardcoded constants, so this is not an injection vector.
 */
export const INBOX_SURFACEABLE_SQL = `source NOT IN (${DISCOVER_ONLY_SOURCES.map((s) => `'${s}'`).join(",")})`;
