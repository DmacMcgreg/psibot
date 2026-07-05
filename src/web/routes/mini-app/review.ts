/**
 * Review queue routes — the /tma/review card queue over `pending_items` in
 * `triaged` status, plus the action API that applies the four terminal verbs.
 *
 * Every handler try/catches and returns an errorState HTML on failure (page or
 * fragment as appropriate). The action endpoint returns an empty 200 body with
 * an hx-swap-oob count update so the acted-on card animates away and the header
 * count decrements in one round-trip.
 */

import { Hono } from "hono";
import { getDb } from "../../../db/index.ts";
import { getPendingItemById, updatePendingItem } from "../../../db/queries.ts";
import type { PendingItem } from "../../../shared/types.ts";
import { applyItemAction, isItemAction } from "../../../triage/actions.ts";
import {
  tmaReviewPage,
  tmaReviewError,
  tmaReviewListError,
  reviewListItems,
  reviewCount,
  reviewActionsRow,
  reviewReasonChips,
  reviewResearchChips,
  getTriagedCount,
  REVIEW_PAGE_SIZE,
} from "../../views/mini-app/review.ts";
import { escapeHtml } from "../../views/mini-app/components.ts";
import { type MiniAppEnv, requireIntParam, log } from "./shared.ts";

/** Reason slugs accepted on the Archive/Drop reason-chip POST — mirrors
 *  Telegram's rxr/rdr keyboard (src/telegram/keyboards.ts), read-only here. */
const REASON_SLUGS = new Set(["known", "outdated", "irrelevant", "low_quality", "none"]);

/**
 * Fetch a page of triaged items ordered priority asc (nulls last), then
 * signal_score desc, then captured_at desc (created_at as tiebreak).
 */
function getTriagedPage(offset: number, limit: number): PendingItem[] {
  return getDb()
    .prepare<PendingItem, [number, number]>(
      `SELECT * FROM pending_items
       WHERE status = 'triaged'
       ORDER BY
         CASE WHEN priority IS NOT NULL THEN priority ELSE 99 END ASC,
         COALESCE(signal_score, 0) DESC,
         COALESCE(captured_at, created_at) DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function registerReviewRoutes(app: Hono<MiniAppEnv>): void {
  // Full queue page — first REVIEW_PAGE_SIZE cards + Load more.
  app.get("/review", (c) => {
    try {
      const total = getTriagedCount();
      const items = getTriagedPage(0, REVIEW_PAGE_SIZE);
      return c.html(tmaReviewPage(items, total));
    } catch (err) {
      log.error("GET /review failed", { error: String(err) });
      return c.html(tmaReviewError(`Failed to load review queue: ${escapeHtml(String(err))}`), 500);
    }
  });

  // "Load more" fragment — the next page of cards + the next Load-more button,
  // appended into #review-list (the button targets/replaces itself).
  app.get("/review/list", (c) => {
    try {
      const raw = new URL(c.req.url).searchParams.get("offset");
      const offset = Math.max(0, parseInt(raw ?? "0", 10) || 0);
      const total = getTriagedCount();
      const items = getTriagedPage(offset, REVIEW_PAGE_SIZE);
      return c.html(reviewListItems(items, offset, total));
    } catch (err) {
      log.error("GET /review/list failed", { error: String(err) });
      return c.html(tmaReviewListError(`Failed to load more: ${escapeHtml(String(err))}`), 500);
    }
  });

  // Chip-picker fragments — swapped into #review-actions-:id in place of the
  // normal action row. GET (idempotent) so htmx's hx-get semantics apply.

  // The normal 4-button action row — also used as the "Cancel" target to back
  // out of a chip picker without acting.
  app.get("/review/:id/actions", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Invalid item id", 400);
    const item = getPendingItemById(id);
    if (!item) return c.text("Item not found", 404);
    return c.html(reviewActionsRow(id, item.priority));
  });

  // Quick Scan / Deep Dive chips (Research), mirroring Telegram's rr keyboard.
  app.get("/review/:id/research-chips", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Invalid item id", 400);
    return c.html(reviewResearchChips(id));
  });

  // Reason chips (Archive/Drop on priority<=3), mirroring rx/rd's keyboard.
  app.get("/review/:id/reason-chips/:action", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Invalid item id", 400);
    const action = c.req.param("action") ?? "";
    if (action !== "archive" && action !== "drop") return c.text("Invalid action", 400);
    return c.html(reviewReasonChips(id, action));
  });

  // Apply a terminal action to one item. Empty 200 body swaps the card out;
  // an hx-swap-oob count pill updates the header.
  //
  // Query params (both optional, only meaningful for specific actions):
  //   reason=<slug>  — archive/drop only; folded into the logged user_action
  //                    as "<action>:<reason>", matching Telegram's rxr/rdr.
  //   depth=quick    — research only; downgrades the queued auto_decision
  //                    from deep_research_queued to quick_research_queued so
  //                    the heartbeat's executeQueuedResearch() runs the
  //                    cheaper preliminaryResearch() pass instead of deepResearch().
  app.post("/api/review/:id/:action", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Invalid item id", 400);
    const action = c.req.param("action") ?? "";
    if (!isItemAction(action)) return c.text("Invalid action", 400);
    const params = new URL(c.req.url).searchParams;
    const reasonRaw = params.get("reason");
    const reason =
      (action === "archive" || action === "drop") && reasonRaw && REASON_SLUGS.has(reasonRaw)
        ? reasonRaw
        : undefined;
    try {
      const result = applyItemAction(id, action, reason);
      if (!result.ok) return c.text(result.message, 404);
      if (action === "research" && params.get("depth") === "quick") {
        // applyItemAction always sets auto_decision: "deep_research_queued";
        // downgrade it in place for the Quick Scan path.
        updatePendingItem(id, { auto_decision: "quick_research_queued" });
      }
      // Empty body → the card (hx-target) is removed; oob pill updates the count.
      return c.html(reviewCount(getTriagedCount()));
    } catch (err) {
      log.error("POST /api/review/:id/:action failed", { id, action, error: String(err) });
      return c.text(`Failed to apply action: ${String(err)}`, 500);
    }
  });
}
