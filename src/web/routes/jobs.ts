import { Hono } from "hono";
import {
  getAllJobs,
  createJob,
  getJob,
  updateJob,
  deleteJob,
} from "../../db/queries.ts";
import { jobsPage, jobFormModal, jobListFragment } from "../views/jobs.ts";
import type { JobType } from "../../shared/types.ts";

interface JobsEnv {
  Variables: {
    triggerJob: (jobId: number) => void;
    reloadScheduler: () => void;
  };
}

export function createJobRoutes() {
  const app = new Hono<JobsEnv>();

  app.get("/jobs", (c) => {
    const jobs = getAllJobs();
    return c.html(jobsPage(jobs));
  });

  app.get("/api/jobs/new", (c) => {
    return c.html(jobFormModal());
  });

  app.post("/api/jobs", async (c) => {
    const body = await c.req.parseBody();
    createJob({
      name: String(body.name),
      prompt: String(body.prompt),
      type: String(body.type) as JobType,
      schedule: body.schedule ? String(body.schedule) : null,
      run_at: body.run_at ? String(body.run_at).replace("T", " ") : null,
      max_budget_usd: Number(body.max_budget_usd) || 1.0,
      use_browser: body.use_browser === "on",
      model: body.model ? String(body.model) : null,
    });
    c.get("reloadScheduler")();
    return c.html(jobListFragment(getAllJobs()));
  });

  app.post("/api/jobs/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    updateJob(id, {
      name: String(body.name),
      prompt: String(body.prompt),
      schedule: body.schedule ? String(body.schedule) : null,
      run_at: body.run_at ? String(body.run_at).replace("T", " ") : null,
      max_budget_usd: Number(body.max_budget_usd) || 1.0,
      use_browser: body.use_browser === "on",
      model: body.model ? String(body.model) : null,
    });
    c.get("reloadScheduler")();
    return c.html(jobListFragment(getAllJobs()));
  });

  app.post("/api/jobs/:id/toggle", (c) => {
    const id = Number(c.req.param("id"));
    const job = getJob(id);
    if (job) {
      updateJob(id, { status: job.status === "enabled" ? "disabled" : "enabled" });
      c.get("reloadScheduler")();
    }
    return c.html(jobListFragment(getAllJobs()));
  });

  app.post("/api/jobs/:id/trigger", (c) => {
    const id = Number(c.req.param("id"));
    c.get("triggerJob")(id);
    return c.html(jobListFragment(getAllJobs()));
  });

  app.post("/api/jobs/:id/pause", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    const updates: Record<string, string | number | null> = {};
    if (body.paused_until) updates.paused_until = String(body.paused_until).replace("T", " ");
    if (body.skip_runs && Number(body.skip_runs) > 0) updates.skip_runs = Number(body.skip_runs);
    if (Object.keys(updates).length > 0) {
      updateJob(id, updates as Parameters<typeof updateJob>[1]);
    }
    return c.html(jobListFragment(getAllJobs()));
  });

  app.post("/api/jobs/:id/resume", (c) => {
    const id = Number(c.req.param("id"));
    updateJob(id, { paused_until: null, skip_runs: 0 });
    return c.html(jobListFragment(getAllJobs()));
  });

  app.delete("/api/jobs/:id", (c) => {
    const id = Number(c.req.param("id"));
    deleteJob(id);
    c.get("reloadScheduler")();
    return c.html(jobListFragment(getAllJobs()));
  });

  return app;
}
