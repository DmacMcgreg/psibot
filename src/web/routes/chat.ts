import { Hono } from "hono";
import { AgentService } from "../../agent/index.ts";
import {
  getRecentMessages,
  getLatestSessionId,
  getRecentSessions,
  getSessionPreview,
  getMessagesBySession,
} from "../../db/queries.ts";
import { chatPage, chatStreamFragment, chatToolIndicator, sessionListPanel } from "../views/chat.ts";
import { chatBubble } from "../views/components.ts";
import { escapeHtml } from "../../shared/html.ts";
import { formatRunMeta, formatCost } from "../../telegram/format.ts";
import { getConfig } from "../../config.ts";
import { createLogger } from "../../shared/logger.ts";

const log = createLogger("web:chat");

interface ChatEnv {
  Variables: {
    agent: AgentService;
  };
}

function sseEncode(event: string, data: string): string {
  // SSE data fields can't contain raw newlines; use JSON encoding
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createChatRoutes() {
  const app = new Hono<ChatEnv>();

  let activeWebSessionId: string | null = null;
  let pendingWebFork: string | null = null;

  const streams = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<string> | null;
      done: boolean;
    }
  >();

  app.get("/chat", (c) => {
    const messages = activeWebSessionId
      ? getMessagesBySession(activeWebSessionId).slice(-20)
      : getRecentMessages("web", null, 20);
    const sessions = getRecentSessions("web", null, 10);
    const currentPreview = activeWebSessionId
      ? (getSessionPreview(activeWebSessionId) ?? "Active session")
      : null;
    return c.html(chatPage(messages, currentPreview, sessions));
  });

  app.get("/api/chat/older", (c) => {
    const beforeId = Number(c.req.query("before") ?? "0");
    if (!beforeId) return c.html("");
    const messages = getRecentMessages("web", null, 20, beforeId);
    if (messages.length === 0) return c.html("");
    const html = messages
      .map((m) => {
        const meta =
          m.role === "assistant" && m.cost_usd
            ? `$${m.cost_usd.toFixed(4)} / ${((m.duration_ms ?? 0) / 1000).toFixed(1)}s`
            : undefined;
        return chatBubble(m.role, escapeHtml(m.content), meta, m.id);
      })
      .join("\n");
    return c.html(html);
  });

  app.post("/api/chat", async (c) => {
    const body = await c.req.parseBody();
    const message = String(body.message ?? "").trim();
    if (!message) {
      return c.html(`<div class="text-red-400 text-sm p-2">Message is required</div>`);
    }

    const streamId = crypto.randomUUID();
    const stream = { controller: null as ReadableStreamDefaultController<string> | null, done: false };
    streams.set(streamId, stream);

    const userBubble = chatBubble("user", escapeHtml(message));
    const sseFragment = chatStreamFragment(streamId);

    const agent = c.get("agent");

    let sessionId: string | undefined;
    let actualPrompt = message;

    if (pendingWebFork) {
      // Build fork preamble from the source session
      const forkMessages = getMessagesBySession(pendingWebFork);
      if (forkMessages.length > 0) {
        const transcript = forkMessages
          .map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
          .join("\n\n");
        const maxChars = 50_000;
        const trimmed = transcript.length > maxChars
          ? "...\n" + transcript.slice(transcript.length - maxChars)
          : transcript;
        actualPrompt = `<prior_conversation session="${pendingWebFork}">\n${trimmed}\n</prior_conversation>\n\n${message}`;
      }
      pendingWebFork = null;
      activeWebSessionId = null;
      sessionId = undefined;
    } else if (activeWebSessionId) {
      sessionId = activeWebSessionId;
    } else {
      sessionId = getLatestSessionId("web", null) ?? undefined;
    }

    agent
      .run({
        prompt: actualPrompt,
        source: "web",
        sessionId,
        onText: (text) => {
          try {
            if (stream.controller && !stream.done) {
              stream.controller.enqueue(sseEncode("chunk", text));
            }
          } catch { /* client disconnected */ }
        },
        onToolUse: (toolName) => {
          try {
            if (stream.controller && !stream.done) {
              stream.controller.enqueue(sseEncode("tool", toolName));
            }
          } catch { /* client disconnected */ }
        },
        onComplete: (result) => {
          try {
            if (stream.controller && !stream.done) {
              const config = getConfig();
              stream.controller.enqueue(
                sseEncode("meta", formatRunMeta(result, config.VERBOSE_FEEDBACK))
              );
              stream.controller.enqueue(sseEncode("done", "complete"));
              stream.done = true;
              stream.controller.close();
            }
          } catch { /* client disconnected */ }
          streams.delete(streamId);
        },
      })
      .catch((err) => {
        log.error("Chat agent error", { error: String(err) });
        try {
          if (stream.controller && !stream.done) {
            stream.controller.enqueue(sseEncode("chunk", `\n\n**Error:** ${String(err)}`));
            stream.controller.enqueue(sseEncode("done", "error"));
            stream.done = true;
            stream.controller.close();
          }
        } catch { /* already closed */ }
        streams.delete(streamId);
      });

    return c.html(userBubble + sseFragment);
  });

  app.get("/api/chat/stream/:id", (c) => {
    const streamId = c.req.param("id");
    const stream = streams.get(streamId);

    if (!stream) {
      return c.text("Stream not found", 404);
    }

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

  app.get("/api/sessions", (c) => {
    const sessions = getRecentSessions("web", null, 10);
    return c.html(sessionListPanel(sessions, activeWebSessionId));
  });

  app.post("/api/chat/switch-session", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return c.text("Missing sessionId", 400);
    activeWebSessionId = sessionId;
    pendingWebFork = null;
    c.header("HX-Redirect", "/chat");
    return c.text("ok");
  });

  app.post("/api/chat/new-session", (c) => {
    activeWebSessionId = null;
    pendingWebFork = null;
    c.header("HX-Redirect", "/chat");
    return c.text("ok");
  });

  app.post("/api/chat/fork-session", async (c) => {
    const body = await c.req.parseBody();
    const sessionId = String(body.sessionId ?? "").trim();
    if (!sessionId) return c.text("Missing sessionId", 400);
    pendingWebFork = sessionId;
    activeWebSessionId = null;
    c.header("HX-Redirect", "/chat");
    return c.text("ok");
  });

  return app;
}
