import { Hono } from "hono";
import {
  getRecentSessions,
  getAllMemoryEntries,
  searchMemory,
  getRecentSessionLogs,
  getSessionPreviews,
} from "../../../db/queries.ts";
import { tmaLogsPage, tmaLogListFragment, tmaLogErrorFragment } from "../../views/mini-app/logs.ts";
import { tmaMemoryPage, tmaMemoryListFragment, tmaMemoryErrorFragment } from "../../views/mini-app/memory.ts";
import { tmaSkillsPage, tmaSkillDetailPage, tmaSkillsErrorFragment } from "../../views/mini-app/skills.ts";
import { tmaSessionsPage, tmaSessionsErrorFragment } from "../../views/mini-app/sessions.ts";
import { tmaMorePage } from "../../views/mini-app/more.ts";
import { miniAppLayout } from "../../views/mini-app/shell.ts";
import { listSkills, readSkill, validateSkillName } from "../../../skills/index.ts";
import { loadUsage, getRecord as getSkillRecord, agentCreatedReport } from "../../../skills/usage.ts";
import { loadState as loadCuratorState } from "../../../curator/state.ts";
import { getConfig } from "../../../config.ts";
import { type MiniAppEnv, log } from "./shared.ts";

export function registerMiscRoutes(app: Hono<MiniAppEnv>): void {
  // --- Logs ---
  app.get("/logs", (c) => {
    try {
      const sessions = getRecentSessionLogs(50);
      return c.html(tmaLogsPage(sessions));
    } catch (err) {
      log.error("logs page failed", { error: String(err) });
      return c.html(miniAppLayout("logs", tmaLogErrorFragment("Failed to load logs.")));
    }
  });

  app.get("/api/logs", (c) => {
    try {
      const sessions = getRecentSessionLogs(50);
      return c.html(tmaLogListFragment(sessions));
    } catch (err) {
      log.error("logs refresh failed", { error: String(err) });
      return c.html(tmaLogErrorFragment("Failed to refresh logs."));
    }
  });

  // --- Memory ---
  app.get("/memory", (c) => {
    try {
      const entries = getAllMemoryEntries();
      return c.html(tmaMemoryPage(entries));
    } catch (err) {
      log.error("memory page failed", { error: String(err) });
      return c.html(miniAppLayout("memory", tmaMemoryErrorFragment("Failed to load memory.")));
    }
  });

  app.get("/api/memory/search", (c) => {
    const q = c.req.query("q")?.trim() ?? "";
    try {
      const entries = q ? searchMemory(q) : getAllMemoryEntries();
      return c.html(tmaMemoryListFragment(entries, q));
    } catch (err) {
      log.error("memory search failed", { error: String(err) });
      return c.html(tmaMemoryErrorFragment("Search failed. Please retry."));
    }
  });

  // --- Skills + Curator ---
  app.get("/skills", (c) => {
    try {
      const cfg = getConfig();
      const skills = listSkills();
      const usage = loadUsage();
      const cur = loadCuratorState();
      const skillRows = skills.map((summary) => ({
        summary,
        record: usage[summary.name] ?? getSkillRecord(summary.name),
      }));
      const agentCreatedCount = agentCreatedReport().length;
      return c.html(
        tmaSkillsPage({
          skills: skillRows,
          curator: {
            enabled: cfg.CURATOR_ENABLED,
            paused: cur.paused,
            intervalHours: cfg.CURATOR_INTERVAL_HOURS,
            lastRunAt: cur.lastRunAt,
            lastRunSummary: cur.lastRunSummary,
            lastReportPath: cur.lastReportPath,
            lastRunDurationMs: cur.lastRunDurationMs,
            runCount: cur.runCount,
            agentCreatedCount,
            totalCount: skills.length,
          },
        }),
      );
    } catch (err) {
      log.error("skills page failed", { error: String(err) });
      return c.html(miniAppLayout("skills", tmaSkillsErrorFragment("Failed to load skills.")));
    }
  });

  app.get("/skills/:name", (c) => {
    const name = c.req.param("name");
    if (validateSkillName(name)) return c.notFound();
    let skill;
    try {
      skill = readSkill(name);
    } catch (err) {
      log.error("skill detail failed", { name, error: String(err) });
      return c.html(miniAppLayout("skills", tmaSkillsErrorFragment("Failed to load skill."), false));
    }
    if (!skill) return c.notFound();
    const record = getSkillRecord(name);
    return c.html(tmaSkillDetailPage(skill, record));
  });

  // --- Sessions ---
  app.get("/sessions", (c) => {
    try {
      // Show sessions from all sources (page load has no auth context)
      const config = getConfig();
      const userIds = config.ALLOWED_TELEGRAM_USER_IDS.map(String);
      const allSessions = userIds
        .flatMap((id) => [
          ...getRecentSessions("mini-app", id, 10),
          ...getRecentSessions("telegram", id, 10),
        ])
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 15);
      const previews = getSessionPreviews(allSessions.map((s) => s.session_id));
      return c.html(tmaSessionsPage(allSessions, previews));
    } catch (err) {
      log.error("sessions page failed", { error: String(err) });
      return c.html(miniAppLayout("sessions", tmaSessionsErrorFragment("Failed to load sessions.")));
    }
  });

  // --- More (secondary-page hub) ---
  app.get("/more", (c) => {
    return c.html(tmaMorePage());
  });
}
