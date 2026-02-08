import { Hono } from "hono";
import { getRecentRuns, getJob } from "../../db/queries.ts";
import { logsPage, logListFragment } from "../views/logs.ts";

export function createLogRoutes() {
  const app = new Hono();

  app.get("/logs", (c) => {
    const runs = getRecentRuns(50).map((r) => {
      const job = getJob(r.job_id);
      return { ...r, job_name: job?.name };
    });
    return c.html(logsPage(runs));
  });

  app.get("/api/logs", (c) => {
    const runs = getRecentRuns(50).map((r) => {
      const job = getJob(r.job_id);
      return { ...r, job_name: job?.name };
    });
    return c.html(logListFragment(runs));
  });

  return app;
}
