import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { AgentService } from "../../agent/index.ts";
import { MemorySystem } from "../../memory/index.ts";
import {
  getRecentMessages,
  getLatestSessionId,
  getRecentSessions,
  getMessagesBySession,
  getAllJobs,
  getJob,
  getJobRuns,
  updateJob,
  deleteJob,
  getAllMemoryEntries,
  searchMemory,
  getRecentSessionLogs,
  getSessionPreviews,
  listAgents,
  getAgentBySlug,
  createAgent,
  updateAgent,
  deleteAgent,
  countJobsUsingAgent,
  getJobsUsingAgent,
} from "../../db/queries.ts";
import { tmaChatPage, tmaChatStreamFragment } from "../views/mini-app/chat.ts";
import { tmaJobsPage, tmaJobListFragment, tmaJobCardFragment, tmaJobDetailFragment, tmaJobEditFragment } from "../views/mini-app/jobs.ts";
import { tmaLogsPage, tmaLogListFragment } from "../views/mini-app/logs.ts";
import { tmaMemoryPage, tmaMemoryListFragment } from "../views/mini-app/memory.ts";
import { tmaSessionsPage } from "../views/mini-app/sessions.ts";
import { tmaYoutubePage, tmaVideoListFragment, tmaYoutubeTagsPage, tmaYoutubeChannelsPage } from "../views/mini-app/youtube.ts";
import { tmaYoutubeGraphPage } from "../views/mini-app/youtube-graph.ts";
import { listVideos, getVideoCount, getVideo, getAllTagsWithCounts, getAllChannelsWithCounts } from "../../youtube/db.ts";
import {
  buildTopicClusterGraph,
  buildVideoSimilarityGraph,
  buildHybridGraph,
  getTopicWithRelations,
  getRelatedVideos,
} from "../../youtube/graph.ts";
import type { ParsedTranscript } from "../../youtube/analyzer.ts";
import {
  tmaAgentsPage,
  tmaAgentCardFragment,
  tmaAgentDetailFragment,
  tmaAgentEditFragment,
  tmaAgentListFragment,
  tmaAgentMemoryPage,
} from "../views/mini-app/agents.ts";
import type { AgentBackend, AgentNotifyPolicy } from "../../shared/types.ts";
import { getAgentNames } from "../../agent/subagents.ts";
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

  // Static files (served under /tma/static/* via Tailscale Funnel)
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

  app.get("/logs", (c) => {
    const sessions = getRecentSessionLogs(50);
    return c.html(tmaLogsPage(sessions));
  });

  app.get("/memory", (c) => {
    const entries = getAllMemoryEntries();
    return c.html(tmaMemoryPage(entries));
  });

  app.get("/youtube", (c) => {
    const tag = c.req.query("tag")?.trim() || undefined;
    const channel = c.req.query("channel")?.trim() || undefined;
    const keyword = c.req.query("q")?.trim() || undefined;
    const videos = listVideos({ tag, channel, keyword, limit: 50 });
    return c.html(tmaYoutubePage(videos, getVideoCount(), { tag, channel, keyword }));
  });

  app.get("/youtube/graph", (c) => c.html(tmaYoutubeGraphPage()));
  app.get("/youtube/tags", (c) => c.html(tmaYoutubeTagsPage(getAllTagsWithCounts())));
  app.get("/youtube/channels", (c) => c.html(tmaYoutubeChannelsPage(getAllChannelsWithCounts())));

  app.get("/agents", (c) => {
    const agents = listAgents();
    const jobCounts = new Map<string, number>();
    for (const a of agents) jobCounts.set(a.slug, countJobsUsingAgent(a.slug));
    return c.html(tmaAgentsPage(agents, jobCounts));
  });

  app.get("/agents/:slug/memory/:filename", (c) => {
    const slug = c.req.param("slug");
    const filename = c.req.param("filename");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    const memory = c.get("memory");
    const content = memory.readAgentMemoryOptional(agent.memory_dir, filename) ?? "";
    return c.html(tmaAgentMemoryPage(agent, filename, content));
  });

  app.get("/agents/:slug/memory-new", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    return c.html(tmaAgentMemoryPage(agent, "", ""));
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
    const previews = getSessionPreviews(allSessions.map((s) => s.session_id));
    return c.html(tmaSessionsPage(allSessions, previews));
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
    const job = getJob(jobId);
    return c.html(tmaJobCardFragment(job!));
  });

  app.post("/api/jobs/:id/toggle", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const job = getJob(jobId);
    if (!job) return c.text("Job not found", 404);
    const newStatus = job.status === "enabled" ? "disabled" : "enabled";
    updateJob(jobId, { status: newStatus as "enabled" | "disabled" });
    const reloadScheduler = c.get("reloadScheduler");
    reloadScheduler();
    const updated = getJob(jobId);
    return c.html(tmaJobCardFragment(updated!));
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
    const updated = getJob(jobId);
    return c.html(tmaJobCardFragment(updated!));
  });

  app.post("/api/jobs/:id/delete", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    deleteJob(jobId);
    const reloadScheduler = c.get("reloadScheduler");
    reloadScheduler();
    const jobs = getAllJobs();
    return c.html(tmaJobListFragment(jobs));
  });

  app.get("/api/jobs/:id/card", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const job = getJob(jobId);
    if (!job) return c.text("Job not found", 404);
    return c.html(tmaJobCardFragment(job));
  });

  app.get("/api/jobs/:id/detail", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const job = getJob(jobId);
    if (!job) return c.text("Job not found", 404);
    const runs = getJobRuns(jobId, 5);
    const allJobs = getAllJobs();
    return c.html(tmaJobDetailFragment(job, runs, allJobs));
  });

  app.get("/api/jobs/:id/edit", (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const job = getJob(jobId);
    if (!job) return c.text("Job not found", 404);
    const agentNames = getAgentNames();
    const allJobs = getAllJobs();
    return c.html(tmaJobEditFragment(job, agentNames, allJobs));
  });

  app.post("/api/jobs/:id/update", async (c) => {
    const jobId = parseInt(c.req.param("id"), 10);
    const body = await c.req.parseBody();
    const updates: Record<string, string | number | null | boolean> = {};
    if (body.name !== undefined) updates.name = String(body.name);
    if (body.prompt !== undefined) updates.prompt = String(body.prompt);
    if (body.schedule !== undefined) updates.schedule = String(body.schedule) || null;
    if (body.model !== undefined) updates.model = String(body.model) || null;
    if (body.backend !== undefined) updates.backend = String(body.backend) || null;
    if (body.max_budget_usd !== undefined) updates.max_budget_usd = Number(body.max_budget_usd) || 1.0;
    if (body.use_browser !== undefined) updates.use_browser = body.use_browser === "on";
    if (body.notify_topic_id !== undefined) {
      const topicId = parseInt(String(body.notify_topic_id), 10);
      if (topicId > 0) {
        updates.notify_chat_id = "-1003762174787";
        updates.notify_topic_id = topicId;
      } else {
        updates.notify_chat_id = null;
        updates.notify_topic_id = null;
      }
    }
    if (body.agent_name !== undefined) updates.agent_name = String(body.agent_name) || null;
    if (body.agent_prompt !== undefined) updates.agent_prompt = String(body.agent_prompt) || null;
    if (body.next_job_id !== undefined) {
      const nj = parseInt(String(body.next_job_id), 10);
      updates.next_job_id = nj > 0 ? nj : null;
    }
    if (body.notify_policy !== undefined) {
      const p = String(body.notify_policy).trim();
      const valid: AgentNotifyPolicy[] = ["always", "on_error", "on_change", "silent", "dynamic"];
      updates.notify_policy = valid.includes(p as AgentNotifyPolicy) ? (p as AgentNotifyPolicy) : null;
    }
    if (body.output_template !== undefined) {
      const t = String(body.output_template).trim();
      updates.output_template = t.length > 0 ? t : null;
    }
    // subagents comes as checkboxes - may be string, array, or undefined
    const subagentValues = body["subagents"];
    if (subagentValues !== undefined) {
      const selected = Array.isArray(subagentValues) ? subagentValues.map(String) : subagentValues ? [String(subagentValues)] : [];
      updates.subagents = selected.length > 0 ? JSON.stringify(selected) : null;
    } else {
      // No checkboxes checked = clear subagents
      updates.subagents = null;
    }
    updateJob(jobId, updates as Parameters<typeof updateJob>[1]);
    const reloadScheduler = c.get("reloadScheduler");
    reloadScheduler();
    const job = getJob(jobId)!;
    const runs = getJobRuns(jobId, 5);
    const allJobs = getAllJobs();
    return c.html(tmaJobDetailFragment(job, runs, allJobs));
  });

  // --- Logs API ---

  app.get("/api/logs", (c) => {
    const sessions = getRecentSessionLogs(50);
    return c.html(tmaLogListFragment(sessions));
  });

  // --- Memory API ---

  app.get("/api/memory/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    const entries = q ? searchMemory(q) : getAllMemoryEntries();
    return c.html(tmaMemoryListFragment(entries));
  });

  // --- YouTube API ---

  app.get("/api/youtube/search", (c) => {
    const q = c.req.query("q")?.trim() || undefined;
    const tag = c.req.query("tag")?.trim() || undefined;
    const channel = c.req.query("channel")?.trim() || undefined;
    const videos = listVideos({ keyword: q, tag, channel, limit: 50 });
    return c.html(tmaVideoListFragment(videos));
  });

  app.get("/api/youtube/graph/topics", (c) => c.json(buildTopicClusterGraph()));
  app.get("/api/youtube/graph/similarity", (c) => {
    const threshold = parseFloat(c.req.query("threshold") ?? "0.78");
    const maxEdges = parseInt(c.req.query("maxEdges") ?? "5", 10);
    return c.json(buildVideoSimilarityGraph(threshold, maxEdges));
  });
  app.get("/api/youtube/graph/hybrid", (c) => c.json(buildHybridGraph()));
  app.get("/api/youtube/graph/topic/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const topic = getTopicWithRelations(id);
    if (!topic) return c.json({ error: "Topic not found" }, 404);
    return c.json(topic);
  });
  app.get("/api/youtube/graph/video/:id", (c) => {
    const videoId = c.req.param("id");
    const video = getVideo(videoId);
    if (!video) return c.json({ error: "Video not found" }, 404);
    const analysis: ParsedTranscript = JSON.parse(video.analysis_json);
    const tags: string[] = JSON.parse(video.tags);
    const related = getRelatedVideos(videoId, 5);
    return c.json({
      video_id: video.video_id,
      title: video.title,
      channel_title: video.channel_title,
      url: video.url,
      tags,
      summary: video.markdown_summary,
      themes: analysis.themes,
      related,
    });
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

  // --- Agents API (Phase 5) ---

  app.get("/api/agents/:slug/card", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    return c.html(tmaAgentCardFragment(agent, countJobsUsingAgent(slug)));
  });

  app.get("/api/agents/:slug/detail", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    const memory = c.get("memory");
    const files = memory.listAgentMemoryFiles(agent.memory_dir);
    const jobs = getJobsUsingAgent(slug);
    return c.html(tmaAgentDetailFragment(agent, jobs, files));
  });

  app.get("/api/agents/:slug/edit", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    return c.html(tmaAgentEditFragment(agent, listAgents()));
  });

  app.post("/api/agents/:slug/update", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.parseBody();
    const existing = getAgentBySlug(slug);
    if (!existing) return c.text("Agent not found", 404);

    const patch: Record<string, string | number | null> = {};
    if (body.name !== undefined) patch.name = String(body.name);
    if (body.description !== undefined) patch.description = String(body.description);
    if (body.role !== undefined) patch.role = String(body.role);
    if (body.goal !== undefined) patch.goal = String(body.goal);
    if (body.backstory !== undefined) patch.backstory = String(body.backstory);
    if (body.prompt !== undefined) patch.prompt = String(body.prompt);
    if (body.model !== undefined) patch.model = String(body.model);
    if (body.notify_policy !== undefined) {
      patch.notify_policy = String(body.notify_policy) as AgentNotifyPolicy;
    }
    if (body.notify_topic_id !== undefined) {
      const topicId = parseInt(String(body.notify_topic_id), 10);
      if (topicId > 0) {
        patch.notify_chat_id = "-1003762174787";
        patch.notify_topic_id = topicId;
      } else {
        patch.notify_chat_id = null;
        patch.notify_topic_id = null;
      }
    }
    if (body.critic_agent_slug !== undefined) {
      const cs = String(body.critic_agent_slug).trim();
      patch.critic_agent_slug = cs.length > 0 ? cs : null;
    }
    if (body.output_template !== undefined) {
      const t = String(body.output_template).trim();
      patch.output_template = t.length > 0 ? t : null;
    }
    if (body.backend !== undefined) {
      const b = String(body.backend).trim();
      patch.backend = b === "claude" || b === "glm" ? (b as AgentBackend) : null;
    }

    updateAgent(slug, patch as Parameters<typeof updateAgent>[1]);
    const updated = getAgentBySlug(slug)!;
    const memory = c.get("memory");
    const files = memory.listAgentMemoryFiles(updated.memory_dir);
    const jobs = getJobsUsingAgent(slug);
    return c.html(tmaAgentDetailFragment(updated, jobs, files));
  });

  app.post("/api/agents/create", async (c) => {
    const body = await c.req.parseBody();
    const slug = String(body.slug ?? "").trim();
    const name = String(body.name ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();
    if (!slug || !name || !prompt) {
      return c.text("slug, name, prompt required", 400);
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return c.text("slug must be lowercase alphanumeric + hyphens", 400);
    }
    if (getAgentBySlug(slug)) {
      return c.text(`Agent '${slug}' already exists`, 409);
    }

    const notifyPolicy = (String(body.notify_policy ?? "always") as AgentNotifyPolicy);
    const backendRaw = String(body.backend ?? "").trim();
    const backend: AgentBackend | null =
      backendRaw === "claude" || backendRaw === "glm" ? (backendRaw as AgentBackend) : null;
    createAgent({
      slug,
      name,
      prompt,
      description: String(body.description ?? ""),
      model: String(body.model ?? "sonnet"),
      memory_dir: `agents/${slug}`,
      notify_policy: notifyPolicy,
      backend,
      is_builtin: false,
    });

    const agents = listAgents();
    const jobCounts = new Map<string, number>();
    for (const a of agents) jobCounts.set(a.slug, countJobsUsingAgent(a.slug));
    return c.html(tmaAgentListFragment(agents, jobCounts));
  });

  app.post("/api/agents/:slug/delete", (c) => {
    const slug = c.req.param("slug");
    try {
      deleteAgent(slug);
    } catch (err) {
      return c.text(String(err instanceof Error ? err.message : err), 400);
    }
    const agents = listAgents();
    const jobCounts = new Map<string, number>();
    for (const a of agents) jobCounts.set(a.slug, countJobsUsingAgent(a.slug));
    return c.html(tmaAgentListFragment(agents, jobCounts));
  });

  app.post("/api/agents/:slug/memory/:filename/save", async (c) => {
    const slug = c.req.param("slug");
    const filename = c.req.param("filename");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    const body = await c.req.parseBody();
    const content = String(body.content ?? "");
    const memory = c.get("memory");
    try {
      await memory.writeAgentMemory(slug, agent.memory_dir, filename, content);
    } catch (err) {
      return c.html(`<span style="color:#ef4444;">Error: ${String(err instanceof Error ? err.message : err)}</span>`);
    }
    return c.html(`<span style="color:#10b981;">Saved ${new Date().toLocaleTimeString()}</span>`);
  });

  app.post("/api/agents/:slug/memory/create", async (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    const body = await c.req.parseBody();
    const rawName = String(body.filename ?? "").trim();
    if (!rawName) return c.text("filename required", 400);
    const filename = /\.md$/i.test(rawName) ? rawName : `${rawName}.md`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-.]*\.md$/.test(filename)) {
      return c.text("filename must be alphanumeric + _-. and end in .md", 400);
    }
    const initial = String(body.content ?? `# ${filename.replace(/\.md$/i, "")}\n\n`);
    const memory = c.get("memory");
    try {
      await memory.writeAgentMemory(slug, agent.memory_dir, filename, initial);
    } catch (err) {
      return c.text(String(err instanceof Error ? err.message : err), 400);
    }
    const target = `/tma/agents/${encodeURIComponent(slug)}/memory/${encodeURIComponent(filename)}`;
    // HX-Redirect triggers client-side navigation when HTMX; plain POST falls back to 302.
    if (c.req.header("hx-request")) {
      c.header("HX-Redirect", target);
      return c.body(null, 204);
    }
    return c.redirect(target);
  });

  app.post("/api/agents/:slug/memory/:filename/delete", async (c) => {
    const slug = c.req.param("slug");
    const filename = c.req.param("filename");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.text("Agent not found", 404);
    const memory = c.get("memory");
    try {
      await memory.deleteAgentMemory(slug, agent.memory_dir, filename);
    } catch (err) {
      return c.text(String(err instanceof Error ? err.message : err), 400);
    }
    const files = memory.listAgentMemoryFiles(agent.memory_dir);
    const jobs = getJobsUsingAgent(slug);
    return c.html(tmaAgentDetailFragment(agent, jobs, files));
  });

  return app;
}
