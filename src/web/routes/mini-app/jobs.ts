import { Hono } from "hono";
import {
  getAllJobs,
  getJob,
  getJobRuns,
  updateJob,
  deleteJob,
} from "../../../db/queries.ts";
import {
  tmaJobsPage,
  tmaJobListFragment,
  tmaJobDetailPage,
  tmaJobDetailFragment,
  tmaJobEditFragment,
  tmaJobDetailError,
  tmaJobListError,
  type JobFilters,
  DEFAULT_JOB_FILTERS,
} from "../../views/mini-app/jobs.ts";
import { escapeHtml } from "../../views/mini-app/components.ts";
import { getAgentNames } from "../../../agent/subagents.ts";
import type { AgentNotifyPolicy } from "../../../shared/types.ts";
import { type MiniAppEnv, requireIntParam, GROUP_CHAT_ID, log } from "./shared.ts";

/** Parse ?q/topic/type/status query params into a JobFilters (defaults to "all"). */
function parseFilters(url: URL): JobFilters {
  return {
    q: url.searchParams.get("q") ?? DEFAULT_JOB_FILTERS.q,
    topic: url.searchParams.get("topic") ?? DEFAULT_JOB_FILTERS.topic,
    type: url.searchParams.get("type") ?? DEFAULT_JOB_FILTERS.type,
    status: url.searchParams.get("status") ?? DEFAULT_JOB_FILTERS.status,
  };
}

export function registerJobRoutes(app: Hono<MiniAppEnv>): void {
  app.get("/jobs", (c) => {
    try {
      const filters = parseFilters(new URL(c.req.url));
      const jobs = getAllJobs();
      return c.html(tmaJobsPage(jobs, filters));
    } catch (err) {
      log.error("GET /jobs failed", { error: String(err) });
      return c.html(tmaJobsPage([], DEFAULT_JOB_FILTERS), 500);
    }
  });

  // Filtered/searched list fragment — swapped into #job-list, URL query params
  // carry filter state so a reload preserves it (see components.ts filterChips).
  app.get("/jobs/list", (c) => {
    try {
      const filters = parseFilters(new URL(c.req.url));
      const jobs = getAllJobs();
      return c.html(tmaJobListFragment(jobs, filters));
    } catch (err) {
      log.error("GET /jobs/list failed", { error: String(err) });
      return c.html(tmaJobListError(`Failed to load jobs: ${escapeHtml(String(err))}`), 500);
    }
  });

  // Detail page — its own route (BackButton pattern), not an inline expansion.
  app.get("/jobs/:id", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const runs = getJobRuns(jobId, 10);
      const allJobs = getAllJobs();
      return c.html(tmaJobDetailPage(job, runs, allJobs));
    } catch (err) {
      log.error("GET /jobs/:id failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to load job: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });

  // --- Job API ---

  app.post("/api/jobs/:id/trigger", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const triggerJob = c.get("triggerJob");
      triggerJob(jobId);
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const runs = getJobRuns(jobId, 10);
      const allJobs = getAllJobs();
      return c.html(tmaJobDetailFragment(job, runs, allJobs));
    } catch (err) {
      log.error("POST /api/jobs/:id/trigger failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to trigger job: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });

  app.post("/api/jobs/:id/toggle", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const newStatus = job.status === "enabled" ? "disabled" : "enabled";
      updateJob(jobId, { status: newStatus as "enabled" | "disabled" });
      const reloadScheduler = c.get("reloadScheduler");
      reloadScheduler();
      const updated = getJob(jobId);
      if (!updated) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const runs = getJobRuns(jobId, 10);
      const allJobs = getAllJobs();
      return c.html(tmaJobDetailFragment(updated, runs, allJobs));
    } catch (err) {
      log.error("POST /api/jobs/:id/toggle failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to update job: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });

  app.post("/api/jobs/:id/pause", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const currentlyPaused =
        job.paused_until &&
        new Date(job.paused_until.endsWith("Z") ? job.paused_until : job.paused_until + "Z") > new Date();
      if (currentlyPaused) {
        updateJob(jobId, { paused_until: null });
      } else {
        const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
        updateJob(jobId, { paused_until: until });
      }
      const updated = getJob(jobId);
      if (!updated) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const runs = getJobRuns(jobId, 10);
      const allJobs = getAllJobs();
      return c.html(tmaJobDetailFragment(updated, runs, allJobs));
    } catch (err) {
      log.error("POST /api/jobs/:id/pause failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to update job: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });

  app.post("/api/jobs/:id/delete", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobListError("Invalid job id"), 400);
    try {
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobListError("Job not found"), 404);
      deleteJob(jobId);
      const reloadScheduler = c.get("reloadScheduler");
      reloadScheduler();
      // The delete action originates from the detail page (#job-detail-root
      // target) — redirect the client back to the list via an HTMX-driven
      // location swap so it doesn't render an empty detail shell.
      c.header("HX-Redirect", "/tma/jobs");
      return c.html("");
    } catch (err) {
      log.error("POST /api/jobs/:id/delete failed", { jobId, error: String(err) });
      return c.html(tmaJobListError(`Failed to delete job: ${escapeHtml(String(err))}`), 500);
    }
  });

  app.get("/api/jobs/:id/detail", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const runs = getJobRuns(jobId, 10);
      const allJobs = getAllJobs();
      return c.html(tmaJobDetailFragment(job, runs, allJobs));
    } catch (err) {
      log.error("GET /api/jobs/:id/detail failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to load job: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });

  app.get("/api/jobs/:id/edit", (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const agentNames = getAgentNames();
      const allJobs = getAllJobs();
      return c.html(tmaJobEditFragment(job, agentNames, allJobs));
    } catch (err) {
      log.error("GET /api/jobs/:id/edit failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to load edit form: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });

  app.post("/api/jobs/:id/update", async (c) => {
    const jobId = requireIntParam(c, "id");
    if (jobId === null) return c.html(tmaJobDetailError("Invalid job id", 0), 400);
    try {
      const job0 = getJob(jobId);
      if (!job0) return c.html(tmaJobDetailError("Job not found", jobId), 404);
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
        if (Number.isFinite(topicId) && topicId > 0) {
          updates.notify_chat_id = GROUP_CHAT_ID;
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
        updates.next_job_id = Number.isFinite(nj) && nj > 0 ? nj : null;
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
        const selected = Array.isArray(subagentValues)
          ? subagentValues.map(String)
          : subagentValues
            ? [String(subagentValues)]
            : [];
        updates.subagents = selected.length > 0 ? JSON.stringify(selected) : null;
      } else {
        // No checkboxes checked = clear subagents
        updates.subagents = null;
      }
      updateJob(jobId, updates as Parameters<typeof updateJob>[1]);
      const reloadScheduler = c.get("reloadScheduler");
      reloadScheduler();
      const job = getJob(jobId);
      if (!job) return c.html(tmaJobDetailError("Job not found", jobId), 404);
      const runs = getJobRuns(jobId, 10);
      const allJobs = getAllJobs();
      return c.html(tmaJobDetailFragment(job, runs, allJobs));
    } catch (err) {
      log.error("POST /api/jobs/:id/update failed", { jobId, error: String(err) });
      return c.html(tmaJobDetailError(`Failed to save job: ${escapeHtml(String(err))}`, jobId), 500);
    }
  });
}
