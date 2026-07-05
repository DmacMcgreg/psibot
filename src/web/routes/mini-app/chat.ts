import { Hono } from "hono";
import {
  getMessagesBySession,
  getLatestSessionId,
  getSession,
} from "../../../db/queries.ts";
import { tmaChatPage, chatRoot, tmaUserBubble, tmaChatStreamFragment } from "../../views/mini-app/chat.ts";
import { emptyState, errorState } from "../../views/mini-app/components.ts";
import { formatRunMeta } from "../../../telegram/format.ts";
import { getConfig } from "../../../config.ts";
import {
  type MiniAppEnv,
  log,
  streams,
  sseEncode,
  getActiveSession,
  setActiveSession,
  clearActiveSession,
} from "./shared.ts";

const MESSAGE_HISTORY_LIMIT = 30;

// SseStream (shared.ts) doesn't carry a runId field — track it locally here,
// keyed by streamId, so the cancel endpoint can find the live query to
// interrupt without editing the shared stream registry type.
const runIdByStream = new Map<string, string>();

export function registerChatRoutes(app: Hono<MiniAppEnv>): void {
  app.get("/chat", (c) => {
    // Page loads have no Telegram auth context (auth middleware only covers
    // /api/*), so the server cannot identify the caller here. Ship a neutral
    // shell that self-hydrates via an authenticated request instead of
    // guessing identity — see tmaChatPage() doc comment for why.
    return c.html(tmaChatPage());
  });

  // --- Chat API ---

  // Authenticated hydration for the initial page load (see GET /chat above).
  app.get("/api/chat/init", (c) => {
    const user = c.get("telegramUser");
    const sourceId = String(user.id);
    try {
      const active = getActiveSession(sourceId) ?? getLatestSessionId("mini-app", sourceId) ?? undefined;
      const messages = active ? getMessagesBySession(active).slice(-MESSAGE_HISTORY_LIMIT) : [];
      const session = active ? getSession(active) : null;
      return c.html(chatRoot(messages, session));
    } catch (err) {
      log.error("Failed to hydrate chat page", { error: String(err) });
      return c.html(
        errorState("Couldn't load chat history.", "/tma/api/chat/init"),
        500,
      );
    }
  });

  app.post("/api/chat", async (c) => {
    const body = await c.req.parseBody();
    const message = String(body.message ?? "").trim();
    if (!message) {
      return c.html(emptyState("✏️", "Message is required"), 400);
    }

    const user = c.get("telegramUser");
    const sourceId = String(user.id);
    const streamId = crypto.randomUUID();
    const stream = {
      controller: null as ReadableStreamDefaultController<string> | null,
      done: false,
      createdAt: Date.now(),
    };
    streams.set(streamId, stream);

    const userBubble = tmaUserBubble(message);
    const streamFragment = tmaChatStreamFragment(streamId, message);

    const agent = c.get("agent");
    const sessionId = getActiveSession(sourceId) ?? getLatestSessionId("mini-app", sourceId) ?? undefined;

    agent
      .run({
        prompt: message,
        source: "mini-app",
        sourceId,
        sessionId,
        useBrowser: false,
        onRunStart: (runId) => {
          runIdByStream.set(streamId, runId);
        },
        onText: (text) => {
          try {
            if (stream.controller && !stream.done) {
              stream.controller.enqueue(sseEncode("chunk", text));
            }
          } catch (err) {
            log.error("SSE enqueue failed (chunk)", { streamId, error: String(err) });
          }
        },
        onComplete: (result) => {
          try {
            if (stream.controller && !stream.done) {
              const config = getConfig();
              stream.controller.enqueue(sseEncode("meta", formatRunMeta(result, config.VERBOSE_FEEDBACK)));
              const status = result.stopReason === "interrupted" ? "cancelled" : "done";
              stream.controller.enqueue(sseEncode("done", status));
              stream.done = true;
              stream.controller.close();
            }
          } catch (err) {
            log.error("SSE enqueue failed (complete)", { streamId, error: String(err) });
          }
          setActiveSession(sourceId, result.sessionId);
          streams.delete(streamId);
          runIdByStream.delete(streamId);
        },
      })
      .catch((err) => {
        log.error("Mini App chat error", { error: String(err) });
        try {
          if (stream.controller && !stream.done) {
            stream.controller.enqueue(sseEncode("done", "error"));
            stream.done = true;
            stream.controller.close();
          }
        } catch (closeErr) {
          log.error("SSE error-path close failed", { streamId, error: String(closeErr) });
        }
        streams.delete(streamId);
        runIdByStream.delete(streamId);
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
        runIdByStream.delete(streamId);
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

  app.post("/api/chat/cancel/:id", async (c) => {
    const streamId = c.req.param("id");
    const stream = streams.get(streamId);
    if (!stream) return c.text("Stream not found", 404);
    const runId = runIdByStream.get(streamId);
    if (!runId) return c.text("Run not started yet", 409);

    try {
      const agent = c.get("agent");
      await agent.interrupt(runId);
      return c.text("Cancelling", 202);
    } catch (err) {
      log.error("Mini App chat cancel failed", { streamId, error: String(err) });
      return c.text("Failed to cancel", 500);
    }
  });

  // --- Session API (chat-session mutations) ---

  app.post("/api/sessions/new", (c) => {
    const user = c.get("telegramUser");
    clearActiveSession(String(user.id));
    return c.html(chatRoot([], null));
  });

  app.post("/api/sessions/resume", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return c.text("Missing sessionId", 400);
    const session = getSession(sessionId);
    if (!session) return c.text("Session not found", 404);
    const user = c.get("telegramUser");
    setActiveSession(String(user.id), sessionId);
    const messages = getMessagesBySession(sessionId).slice(-MESSAGE_HISTORY_LIMIT);
    return c.html(chatRoot(messages, session));
  });

  app.post("/api/sessions/fork", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return c.text("Missing sessionId", 400);
    const user = c.get("telegramUser");
    clearActiveSession(String(user.id));
    // Fork will be handled by next chat message with context
    return c.html(chatRoot([], null));
  });
}
