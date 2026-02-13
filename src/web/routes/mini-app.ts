import { Hono } from "hono";
import { AgentService } from "../../agent/index.ts";
import { MemorySystem } from "../../memory/index.ts";
import {
  getRecentMessages,
  getLatestSessionId,
  getRecentSessions,
  getMessagesBySession,
  getAllJobs,
  getJob,
  updateJob,
  deleteJob,
  getAllMemoryEntries,
  searchMemory,
} from "../../db/queries.ts";
import { tmaChatPage, tmaChatStreamFragment } from "../views/mini-app/chat.ts";
import { tmaJobsPage, tmaJobListFragment } from "../views/mini-app/jobs.ts";
import { tmaMemoryPage, tmaMemoryListFragment } from "../views/mini-app/memory.ts";
import { tmaSessionsPage } from "../views/mini-app/sessions.ts";
import { formatRunMeta } from "../../telegram/format.ts";
import { getConfig } from "../../config.ts";
import { createLogger } from "../../shared/logger.ts";
import { telegramAuthMiddleware } from "../middleware/telegram-auth.ts";
import type { TelegramAuthContext } from "../middleware/telegram-auth.ts";

const log = createLogger("web:mini-app");

interface MiniAppEnv {
  Variables: {
    agent: AgentService;
    memory: MemorySystem;
    triggerJob: (jobId: number) => void;
    reloadScheduler: () => void;
    telegramUser: TelegramAuthContext["telegramUser"];
  };
}

function sseEncode(event: string, data: string): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createMiniAppRoutes() {
  const app = new Hono<MiniAppEnv>();

  // Auth middleware for API routes only (page loads are plain GET without auth headers)
  app.use("/api/*", telegramAuthMiddleware());

  let activeSessionId: string | null = null;

  const streams = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<string> | null;
      done: boolean;
    }
  >();

  // --- Pages ---

  app.get("/", (c) => c.redirect("/tma/chat"));

  app.get("/chat", (c) => {
    const messages = activeSessionId
      ? getMessagesBySession(activeSessionId).slice(-30)
      : [];
    return c.html(tmaChatPage(messages));
  });

  app.get("/jobs", (c) => {
    const jobs = getAllJobs();
    return c.html(tmaJobsPage(jobs));
  });

  app.get("/memory", (c) => {
    const entries = getAllMemoryEntries();
    return c.html(tmaMemoryPage(entries));
  });

  app.get("/sessions", (c) => {
    // Show sessions from all sources (page load has no auth context)
    const config = getConfig();
    const userIds = config.ALLOWED_TELEGRAM_USER_IDS.map(String);
    const allSessions = userIds.flatMap((id) => [
      ...getRecentSessions("mini-app", id, 10),
      ...getRecentSessions("telegram", id, 10),
    ])
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 15);
    return c.html(tmaSessionsPage(allSessions));
  });

  // --- Chat API ---

  app.post("/api/chat", async (c) => {
    const body = await c.req.parseBody();
    const message = String(body.message ?? "").trim();
    if (!message) return c.html(`<div class="tma-hint" style="padding:8px 16px;">Message is required</div>`);

    const user = c.get("telegramUser");
    const sourceId = String(user.id);
    const streamId = crypto.randomUUID();
    const stream = { controller: null as ReadableStreamDefaultController<string> | null, done: false };
    streams.set(streamId, stream);

    const userBubble = `<div class="tma-bubble tma-bubble-user">${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`;
    const streamFragment = tmaChatStreamFragment(streamId);

    const agent = c.get("agent");
    const sessionId = activeSessionId ?? getLatestSessionId("mini-app", sourceId) ?? undefined;

    agent
      .run({
        prompt: message,
        source: "mini-app",
        sourceId,
        sessionId,
        useBrowser: false,
        onText: (text) => {
          try {
            if (stream.controller && !stream.done) {
              stream.controller.enqueue(sseEncode("chunk", text));
            }
          } catch { /* client disconnected */ }
        },
        onComplete: (result) => {
          try {
            if (stream.controller && !stream.done) {
              const config = getConfig();
              stream.controller.enqueue(sseEncode("meta", formatRunMeta(result, config.VERBOSE_FEEDBACK)));
              stream.controller.enqueue(sseEncode("done", "complete"));
              stream.done = true;
              stream.controller.close();
            }
          } catch { /* client disconnected */ }
          activeSessionId = result.sessionId;
          streams.delete(streamId);
        },
      })
      .catch((err) => {
        log.error("Mini App chat error", { error: String(err) });
        try {
          if (stream.controller && !stream.done) {
            stream.controller.enqueue(sseEncode("chunk", `\n\nError: ${String(err)}`));
            stream.controller.enqueue(sseEncode("done", "error"));
            stream.done = true;
            stream.controller.close();
          }
        } catch { /* already closed */ }
        streams.delete(streamId);
      });

    return c.html(userBubble + streamFragment);
  });

  app.get("/api/chat/stream/:id", (c) => {
    const streamId = c.req.param("id");
    const stream = streams.get(streamId);
    if (!stream) return c.text("Stream not found", 404);

    const readable = new ReadableStream<string>({
      start(controller) {
        stream.controller = controller;
      },
      cancel() {
        streams.delete(streamId);
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // --- Job API ---

  app.post("/api/jobs/:id/trigger", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const triggerJob = c.get("triggerJob");
    triggerJob(jobId);
    const jobs = getAllJobs();
    return c.html(tmaJobListFragment(jobs));
  });

  app.post("/api/jobs/:id/toggle", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const job = getJob(jobId);
    if (!job) return c.text("Job not found", 404);
    const newStatus = job.status === "enabled" ? "disabled" : "enabled";
    updateJob(jobId, { status: newStatus as "enabled" | "disabled" });
    const reloadScheduler = c.get("reloadScheduler");
    reloadScheduler();
    const jobs = getAllJobs();
    return c.html(tmaJobListFragment(jobs));
  });

  app.post("/api/jobs/:id/pause", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const job = getJob(jobId);
    if (!job) return c.text("Job not found", 404);
    const currentlyPaused = job.paused_until && new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z") > new Date();
    if (currentlyPaused) {
      updateJob(jobId, { paused_until: null });
    } else {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      updateJob(jobId, { paused_until: until });
    }
    const jobs = getAllJobs();
    return c.html(tmaJobListFragment(jobs));
  });

  app.post("/api/jobs/:id/delete", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    deleteJob(jobId);
    const reloadScheduler = c.get("reloadScheduler");
    reloadScheduler();
    const jobs = getAllJobs();
    return c.html(tmaJobListFragment(jobs));
  });

  // --- Memory API ---

  app.get("/api/memory/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    const entries = q ? searchMemory(q) : getAllMemoryEntries();
    return c.html(tmaMemoryListFragment(entries));
  });

  // --- Session API ---

  app.post("/api/sessions/resume", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return c.text("Missing sessionId", 400);
    activeSessionId = sessionId;
    const messages = getMessagesBySession(sessionId).slice(-30);
    return c.html(tmaChatPage(messages));
  });

  app.post("/api/sessions/fork", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return c.text("Missing sessionId", 400);
    activeSessionId = null;
    // Fork will be handled by next chat message with context
    return c.html(tmaChatPage([]));
  });

  return app;
}
