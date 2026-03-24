import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { getConfig } from "../config.ts";
import { AgentService } from "../agent/index.ts";
import { MemorySystem } from "../memory/index.ts";
import { createChatRoutes } from "./routes/chat.ts";
import { createJobRoutes } from "./routes/jobs.ts";
import { createMemoryRoutes } from "./routes/memory.ts";
import { createLogRoutes } from "./routes/logs.ts";
import { createAuthRoutes } from "./routes/auth.ts";
import { createYoutubeGraphRoutes } from "./routes/youtube-graph.ts";
import { createMiniAppRoutes } from "./routes/mini-app.ts";
import { createInboxRoutes } from "./routes/inbox.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("web");

interface WebAppDeps {
  agent: AgentService;
  memory: MemorySystem;
  triggerJob: (jobId: number) => void;
  reloadScheduler: () => void;
}

export function createWebApp(deps: WebAppDeps) {
  const app = new Hono();
  const config = getConfig();

  // IP allowlist middleware (exempt OAuth callback - Funnel traffic has proxy IPs)
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/auth/youtube/callback") || c.req.path.startsWith("/tma")) {
      await next();
      return;
    }

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "127.0.0.1";

    const allowed =
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith(config.TAILSCALE_IP_PREFIX);

    if (!allowed) {
      log.warn("Blocked request from unauthorized IP", { ip });
      return c.text("Forbidden", 403);
    }

    await next();
  });

  // Static files with cache headers
  app.use("/static/*", async (c, next) => {
    await next();
    if (c.res.ok) {
      const headers = new Headers(c.res.headers);
      headers.set("Cache-Control", "public, max-age=86400");
      c.res = new Response(c.res.body, { status: c.res.status, headers });
    }
  });
  app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (path) => path.replace("/static", "") }));

  // Inject dependencies into context
  app.use("*", async (c, next) => {
    c.set("agent" as never, deps.agent);
    c.set("memory" as never, deps.memory);
    c.set("triggerJob" as never, deps.triggerJob);
    c.set("reloadScheduler" as never, deps.reloadScheduler);
    await next();
  });

  // Root redirect
  app.get("/", (c) => c.redirect("/chat"));

  // Mount route groups
  app.route("/", createChatRoutes());
  app.route("/", createJobRoutes());
  app.route("/", createMemoryRoutes());
  app.route("/", createLogRoutes());
  app.route("/", createAuthRoutes());
  app.route("/", createYoutubeGraphRoutes());
  app.route("/", createInboxRoutes());

  // Mini App routes
  if (config.MINI_APP_ENABLED) {
    app.route("/tma", createMiniAppRoutes());
  }

  return app;
}
