import { Hono } from "hono";
import {
  listAgents,
  getAgentBySlug,
  createAgent,
  updateAgent,
  deleteAgent,
  countJobsUsingAgent,
  countJobsByAgent,
  getJobsUsingAgent,
} from "../../../db/queries.ts";
import {
  tmaAgentsPage,
  tmaAgentCardFragment,
  tmaAgentDetailFragment,
  tmaAgentEditFragment,
  tmaAgentListFragment,
  tmaAgentMemoryPage,
} from "../../views/mini-app/agents.ts";
import { errorState } from "../../views/mini-app/components.ts";
import type { AgentBackend, AgentNotifyPolicy } from "../../../shared/types.ts";
import { type MiniAppEnv, escapeHtml, GROUP_CHAT_ID } from "./shared.ts";

export function registerAgentRoutes(app: Hono<MiniAppEnv>): void {
  app.get("/agents", (c) => {
    const agents = listAgents();
    // Single grouped query instead of one COUNT per agent (N+1 fix).
    const jobCounts = countJobsByAgent();
    return c.html(tmaAgentsPage(agents, jobCounts));
  });

  app.get("/agents/:slug/memory/:filename", (c) => {
    const slug = c.req.param("slug");
    const filename = c.req.param("filename");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    const memory = c.get("memory");
    const content = memory.readAgentMemoryOptional(agent.memory_dir, filename) ?? "";
    return c.html(tmaAgentMemoryPage(agent, filename, content));
  });

  app.get("/agents/:slug/memory-new", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    return c.html(tmaAgentMemoryPage(agent, "", ""));
  });

  // --- Agents API ---

  app.get("/api/agents/:slug/card", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    return c.html(tmaAgentCardFragment(agent, countJobsUsingAgent(slug)));
  });

  app.get("/api/agents/:slug/detail", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    const memory = c.get("memory");
    const files = memory.listAgentMemoryFiles(agent.memory_dir);
    const jobs = getJobsUsingAgent(slug);
    return c.html(tmaAgentDetailFragment(agent, jobs, files));
  });

  app.get("/api/agents/:slug/edit", (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    return c.html(tmaAgentEditFragment(agent, listAgents()));
  });

  app.post("/api/agents/:slug/update", async (c) => {
    const slug = c.req.param("slug");
    const body = await c.req.parseBody();
    const existing = getAgentBySlug(slug);
    if (!existing) return c.html(errorState("Agent not found"), 404);

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
        patch.notify_chat_id = GROUP_CHAT_ID;
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
    const updated = getAgentBySlug(slug);
    if (!updated) return c.html(errorState("Agent not found"), 404);
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
      return c.html(errorState("slug, name, prompt required"), 400);
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return c.html(errorState("slug must be lowercase alphanumeric + hyphens"), 400);
    }
    if (getAgentBySlug(slug)) {
      return c.html(errorState(`Agent '${slug}' already exists`), 409);
    }

    const notifyPolicy = String(body.notify_policy ?? "always") as AgentNotifyPolicy;
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
    const jobCounts = countJobsByAgent();
    return c.html(tmaAgentListFragment(agents, jobCounts));
  });

  app.post("/api/agents/:slug/delete", (c) => {
    const slug = c.req.param("slug");
    try {
      deleteAgent(slug);
    } catch (err) {
      return c.html(errorState(String(err instanceof Error ? err.message : err)), 400);
    }
    const agents = listAgents();
    const jobCounts = countJobsByAgent();
    return c.html(tmaAgentListFragment(agents, jobCounts));
  });

  app.post("/api/agents/:slug/memory/:filename/save", async (c) => {
    const slug = c.req.param("slug");
    const filename = c.req.param("filename");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    const body = await c.req.parseBody();
    const content = String(body.content ?? "");
    const memory = c.get("memory");
    try {
      await memory.writeAgentMemory(slug, agent.memory_dir, filename, content);
    } catch (err) {
      return c.html(
        `<span class="tma-save-error">Error: ${escapeHtml(String(err instanceof Error ? err.message : err))}</span>`,
      );
    }
    return c.html(`<span class="tma-save-ok">Saved ${escapeHtml(new Date().toLocaleTimeString())}</span>`);
  });

  app.post("/api/agents/:slug/memory/create", async (c) => {
    const slug = c.req.param("slug");
    const agent = getAgentBySlug(slug);
    if (!agent) return c.html(errorState("Agent not found"), 404);
    const body = await c.req.parseBody();
    const rawName = String(body.filename ?? "").trim();
    if (!rawName) return c.html(errorState("filename required"), 400);
    const filename = /\.md$/i.test(rawName) ? rawName : `${rawName}.md`;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_\-.]*\.md$/.test(filename)) {
      return c.html(errorState("filename must be alphanumeric + _-. and end in .md"), 400);
    }
    const initial = String(body.content ?? `# ${filename.replace(/\.md$/i, "")}\n\n`);
    const memory = c.get("memory");
    try {
      await memory.writeAgentMemory(slug, agent.memory_dir, filename, initial);
    } catch (err) {
      return c.html(errorState(String(err instanceof Error ? err.message : err)), 400);
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
    if (!agent) return c.html(errorState("Agent not found"), 404);
    const memory = c.get("memory");
    try {
      await memory.deleteAgentMemory(slug, agent.memory_dir, filename);
    } catch (err) {
      return c.html(errorState(String(err instanceof Error ? err.message : err)), 400);
    }
    const files = memory.listAgentMemoryFiles(agent.memory_dir);
    const jobs = getJobsUsingAgent(slug);
    return c.html(tmaAgentDetailFragment(agent, jobs, files));
  });
}
