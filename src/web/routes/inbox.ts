import { Hono } from "hono";
import {
  insertPendingItem,
  getPendingItems,
  getPendingItemCount,
  updatePendingItem,
} from "../../db/queries.ts";
import type { CaptureSource, PendingItemStatus } from "../../shared/types.ts";
import { createLogger } from "../../shared/logger.ts";
import { extractMetadata } from "../../triage/index.ts";

const log = createLogger("web:inbox");

const VALID_SOURCES: CaptureSource[] = [
  "chrome-extension",
  "reddit",
  "github",
  "telegram",
  "manual",
];

export function createInboxRoutes() {
  const app = new Hono();

  // Receive a captured item
  app.post("/api/inbox", async (c) => {
    const body = await c.req.json<{
      url: string;
      title?: string;
      description?: string;
      source?: string;
      platform?: string;
      profile?: string;
      captured_at?: string;
    }>();

    if (!body.url) {
      return c.json({ error: "url is required" }, 400);
    }

    const source = VALID_SOURCES.includes(body.source as CaptureSource)
      ? (body.source as CaptureSource)
      : "manual";

    const item = insertPendingItem({
      url: body.url,
      title: body.title,
      description: body.description,
      source,
      platform: body.platform,
      profile: body.profile,
      captured_at: body.captured_at,
    });

    log.info("Item captured", { url: body.url, source, platform: body.platform });

    // Tier 0: Extract metadata in background (don't block the response)
    if (item) {
      extractMetadata(body.url)
        .then((meta) => {
          const updates: Record<string, string | null> = {};
          if (meta.title && !item.title) updates.title = meta.title;
          if (meta.description && !item.description) updates.description = meta.description;
          if (Object.keys(updates).length > 0) {
            updatePendingItem(item.id, updates);
            log.info("Metadata enriched", { id: item.id, title: meta.title?.slice(0, 60) });
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("Background metadata extraction failed", { id: item.id, error: message });
        });
    }

    return c.json({ ok: true, item }, 201);
  });

  // List pending items
  app.get("/api/inbox", (c) => {
    const status = c.req.query("status");
    const limit = Number(c.req.query("limit")) || 50;

    const validStatuses = ["pending", "triaged", "archived", "deleted"] as const;
    const filterStatus = validStatuses.includes(status as (typeof validStatuses)[number])
      ? (status as (typeof validStatuses)[number])
      : undefined;

    const items = getPendingItems(filterStatus, limit);
    const counts = {
      pending: getPendingItemCount("pending"),
      triaged: getPendingItemCount("triaged"),
      total: getPendingItemCount(),
    };

    return c.json({ items, counts });
  });

  // Update an item (triage, archive, etc.)
  app.patch("/api/inbox/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      status?: PendingItemStatus;
      priority?: number;
      category?: string;
      triage_summary?: string;
      noteplan_path?: string;
    }>();

    updatePendingItem(id, body);
    return c.json({ ok: true });
  });

  return app;
}
