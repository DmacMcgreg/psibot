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
import type { PendingItem } from "../../../shared/types.ts";
import { applyItemAction, isItemAction } from "../../../triage/actions.ts";
import {
  tmaReviewPage,
  tmaReviewError,
  tmaReviewListError,
  reviewListItems,
  reviewCount,
  REVIEW_PAGE_SIZE,
} from "../../views/mini-app/review.ts";
import { escapeHtml } from "../../views/mini-app/components.ts";
import { type MiniAppEnv, requireIntParam, log } from "./shared.ts";

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

/** Count of items currently in the queue. */
function getTriagedCount(): number {
  const row = getDb()
    .prepare<{ cnt: number }, []>(`SELECT COUNT(*) AS cnt FROM pending_items WHERE status = 'triaged'`)
    .get();
  return row?.cnt ?? 0;
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

  // Apply a terminal action to one item. Empty 200 body swaps the card out;
  // an hx-swap-oob count pill updates the header.
  app.post("/api/review/:id/:action", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Invalid item id", 400);
    const action = c.req.param("action") ?? "";
    if (!isItemAction(action)) return c.text("Invalid action", 400);
    try {
      const result = applyItemAction(id, action);
      if (!result.ok) return c.text(result.message, 404);
      // Empty body → the card (hx-target) is removed; oob pill updates the count.
      return c.html(reviewCount(getTriagedCount()));
    } catch (err) {
      log.error("POST /api/review/:id/:action failed", { id, action, error: String(err) });
      return c.text(`Failed to apply action: ${String(err)}`, 500);
    }
  });
}
