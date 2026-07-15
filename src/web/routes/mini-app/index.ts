import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { telegramAuthMiddleware } from "../../middleware/telegram-auth.ts";
import { type MiniAppEnv, startStreamSweep } from "./shared.ts";
import { registerChatRoutes } from "./chat.ts";
import { registerReviewRoutes } from "./review.ts";
import { registerJobRoutes } from "./jobs.ts";
import { registerAgentRoutes } from "./agents.ts";
import { registerLibraryRoutes } from "./library.ts";
import { registerDigestRoutes } from "./digest.ts";
import { registerYoutubeRoutes } from "./youtube.ts";
import { registerDiscoverRoutes } from "./discover.ts";
import { registerMiscRoutes } from "./misc.ts";

/**
 * Build the Telegram Mini App router. Same public API as the pre-split
 * monolith: `createMiniAppRoutes()` returns a Hono app mounted at /tma.
 */
export function createMiniAppRoutes() {
  const app = new Hono<MiniAppEnv>();

  // Static files (served under /tma/static/* via Tailscale serve)
  app.use("/static/*", async (c, next) => {
    await next();
    if (c.res.ok) {
      const headers = new Headers(c.res.headers);
      headers.set("Cache-Control", "public, max-age=86400");
      c.res = new Response(c.res.body, { status: c.res.status, headers });
    }
  });
  app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (path) => path.replace(/^.*\/static/, "") }));

  // Auth middleware for API routes only (page loads are plain GET without auth headers)
  app.use("/api/*", telegramAuthMiddleware());

  // Root redirect to the first primary tab.
  app.get("/", (c) => c.redirect("/tma/review"));

  // Mount each domain's routes. Order is not significant — paths are disjoint.
  registerChatRoutes(app);
  registerReviewRoutes(app);
  registerJobRoutes(app);
  registerAgentRoutes(app);
  registerLibraryRoutes(app);
  registerDiscoverRoutes(app);
  registerDigestRoutes(app);
  registerYoutubeRoutes(app);
  registerMiscRoutes(app);

  // Start the idle-stream sweep (idempotent).
  startStreamSweep();

  return app;
}
