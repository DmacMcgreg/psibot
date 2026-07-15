import { Hono } from "hono";
import { miniAppLayout } from "../../views/mini-app/shell.ts";
import { errorState, escapeHtml } from "../../views/mini-app/components.ts";
import {
  tmaDiscoverListPage,
  tmaDiscoverGroupPage,
  discoverItemsFragment,
  discoverItemCard,
  discoverFeedbackPanel,
  discoverGeneratedChips,
} from "../../views/mini-app/discover.ts";
import {
  groupSummaries,
  getGroupBySlug,
  itemsInGroup,
  getItem,
  recordFeedback,
  skipNewInGroup,
  getItemEmbedding,
  getGroup,
  loadGroupCentroid,
  saveGroupCentroid,
  EMBEDDING_DIMS,
  type ItemFilter,
  type Sentiment,
} from "../../../discover/db.ts";
import { getOrGenerateChips, GENERIC_CHIPS } from "../../../discover/chips.ts";
import { getDb } from "../../../db/index.ts";
import { log, type MiniAppEnv } from "./shared.ts";

function parseFilter(raw: string | undefined): ItemFilter {
  return raw === "interested" || raw === "all" ? raw : "new";
}

/** Move a group's centroid a small step toward an item (positive feedback). */
function nudgeCentroidToward(groupId: number, itemId: number, step = 0.15): void {
  const g = getGroup(groupId);
  if (!g) return;
  const c = loadGroupCentroid(g);
  const v = getItemEmbedding(itemId);
  if (!c || !v) return;
  const next = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) next[i] = c[i] * (1 - step) + v[i] * step;
  saveGroupCentroid(groupId, next);
}

/** Mirror to the legacy feedback_log signal + apply light learning. */
function applyFeedbackLearning(params: {
  itemId: number;
  groupId: number | null;
  sentiment: Sentiment;
  reasons: string[];
}): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO feedback_log (content_type, source, user_action, signal_snapshot)
         VALUES ('discover', 'mini_app', ?, ?)`,
      )
      .run(
        params.sentiment,
        JSON.stringify({ atlasItemId: params.itemId, groupId: params.groupId, reasons: params.reasons }),
      );
  } catch (err) {
    log.error("Discover feedback_log mirror failed", { error: String(err) });
  }
  // Positive feedback sharpens the cluster toward the liked item.
  if (params.sentiment === "interested" && params.groupId) {
    try { nudgeCentroidToward(params.groupId, params.itemId); } catch { /* non-critical */ }
  }
}

export function registerDiscoverRoutes(app: Hono<MiniAppEnv>): void {
  // List of topic-group digests.
  app.get("/discover", (c) => {
    try {
      return c.html(tmaDiscoverListPage({ groups: groupSummaries() }));
    } catch (err) {
      log.error("Discover list failed", { error: String(err) });
      return c.html(miniAppLayout("discover", errorState(`Failed to load Discover: ${escapeHtml(String(err))}`), true));
    }
  });

  // A single topic digest.
  app.get("/discover/:slug", (c) => {
    try {
      const slug = c.req.param("slug");
      const group = getGroupBySlug(slug);
      if (!group) return c.text("Topic not found", 404);
      const filter = parseFilter(c.req.query("filter"));
      const items = itemsInGroup(group.id, filter);
      return c.html(tmaDiscoverGroupPage({ group, items, filter }));
    } catch (err) {
      log.error("Discover group failed", { error: String(err) });
      return c.html(miniAppLayout("discover", errorState(`Failed to load topic: ${escapeHtml(String(err))}`), false));
    }
  });

  // Open the inline feedback panel for an item. Returns instantly with the
  // always-available generic chips; agent-generated chips stream in via the
  // lazy /chips endpoint (hx-trigger=load) so the user never waits on the LLM.
  app.get("/api/discover/item/:id/feedback", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.text("Bad id", 400);
    const sentiment: Sentiment = c.req.query("s") === "interested" ? "interested" : "not_interested";
    const generic = sentiment === "interested" ? GENERIC_CHIPS.pos : GENERIC_CHIPS.neg;
    return c.html(discoverFeedbackPanel({ itemId: id, sentiment, generic }));
  });

  // Lazily generate + cache the per-item agent chips (called on panel load).
  app.get("/api/discover/item/:id/chips", async (c) => {
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.text("Bad id", 400);
    const sentiment: Sentiment = c.req.query("s") === "interested" ? "interested" : "not_interested";
    let generated: string[] = [];
    try {
      const chips = await getOrGenerateChips(id);
      generated = sentiment === "interested" ? chips.pos : chips.neg;
    } catch (err) {
      log.warn("Chip generation failed (generic chips still shown)", { id, error: String(err) });
    }
    return c.html(discoverGeneratedChips(generated));
  });

  // One-tap skip: record a lightweight 'skipped' feedback row (no negative
  // interest signal) and swap the card to its noted state.
  app.post("/api/discover/skip", (c) => {
    const id = parseInt(c.req.query("item") ?? "", 10);
    if (!Number.isFinite(id)) return c.text("Bad id", 400);
    const item = getItem(id);
    const groupId = item?.group_id ?? null;
    try {
      recordFeedback({ atlasItemId: id, groupId, sentiment: "skipped", reasons: ["skipped"], note: null });
    } catch (err) {
      log.error("Discover skip failed", { id, error: String(err) });
      return c.text("Failed to skip", 500);
    }
    if (!item) return c.text("", 200);
    return c.html(discoverItemCard(item, "skipped"));
  });

  // Bulk skip: mark every still-new item in a group as skipped, then re-render
  // the (now empty for the New filter) list.
  app.post("/api/discover/skip-group", (c) => {
    const groupId = parseInt(c.req.query("group") ?? "", 10);
    if (!Number.isFinite(groupId)) return c.text("Bad group", 400);
    try {
      const n = skipNewInGroup(groupId);
      log.info("Discover bulk skip", { groupId, skipped: n });
    } catch (err) {
      log.error("Discover bulk skip failed", { groupId, error: String(err) });
      return c.text("Failed to skip", 500);
    }
    return c.html(discoverItemsFragment(itemsInGroup(groupId, "new")));
  });

  // Record feedback → swap the card to its noted state.
  app.post("/api/discover/feedback", async (c) => {
    try {
      const body = await c.req.parseBody({ all: true });
      const id = parseInt(String(body.item ?? ""), 10);
      if (!Number.isFinite(id)) return c.text("Bad id", 400);
      const sentiment: Sentiment = body.sentiment === "interested" ? "interested" : "not_interested";
      const rawReasons = body["reason[]"] ?? [];
      const reasons = (Array.isArray(rawReasons) ? rawReasons : [rawReasons]).map(String).filter(Boolean);
      const note = typeof body.note === "string" ? body.note.trim() : "";

      const item = getItem(id);
      const groupId = item?.group_id ?? null;
      recordFeedback({ atlasItemId: id, groupId, sentiment, reasons, note: note || null });
      applyFeedbackLearning({ itemId: id, groupId, sentiment, reasons });

      if (!item) return c.text("", 200);
      return c.html(discoverItemCard(item, sentiment));
    } catch (err) {
      log.error("Discover feedback failed", { error: String(err) });
      return c.text("Failed to record feedback", 500);
    }
  });
}
