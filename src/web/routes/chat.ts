import { Hono } from "hono";
import { AgentService } from "../../agent/index.ts";
import { getRecentMessages, getLatestSessionId } from "../../db/queries.ts";
import { chatPage, chatStreamFragment, chatToolIndicator } from "../views/chat.ts";
import { chatBubble } from "../views/components.ts";
import { escapeHtml } from "../../shared/html.ts";
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

  const streams = new Map<
    string,
    {
      controller: ReadableStreamDefaultController<string> | null;
      done: boolean;
    }
  >();

  app.get("/chat", (c) => {
    const messages = getRecentMessages("web", null, 20);
    return c.html(chatPage(messages));
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
    const sessionId = getLatestSessionId("web", null) ?? undefined;

    agent
      .run({
        prompt: message,
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
              stream.controller.enqueue(
                sseEncode("meta", `$${result.costUsd.toFixed(4)} / ${(result.durationMs / 1000).toFixed(1)}s`)
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

  return app;
}
