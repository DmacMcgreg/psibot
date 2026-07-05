/**
 * Hub telemetry signal — Phase 2 of the lifecycle plan.
 *
 * Reads local-mcp-hub's telemetry sink (~/.config/hub/telemetry.db) for
 * cross-harness usage of skills PsiBot has exported: a PsiBot-born skill
 * that Claude Code sessions use via the hub stays fresh in PsiBot's
 * lifecycle even if PsiBot itself never triggers it. This is the exact
 * "unused here but valuable there" wrong-decay failure mode.
 *
 * Foreign-store discipline — the same rules the hub applies to claude-mem
 * (its invariant: read-only, drift-checked, fail-soft), mirrored:
 *   - `readonly: true` open + busy_timeout; never a write, never a lock held.
 *   - Schema drift check: PRAGMA table_info(spans) must contain the pinned
 *     column subset or we bail with "hub signal unavailable".
 *   - Every failure degrades to `available: false` — never a crash, and the
 *     curator carries on without the signal.
 *
 * Matching is conservative: a span counts for a skill when its toolName or
 * spanName contains the skill's exported directory name. Only redacted-tier
 * metadata columns are read; raw args/results are never touched.
 *
 * SCOPE / EXPECTED-ZERO CAVEAT (important): the hub telemetry `spans` table
 * only records hub-BROKERED tool executions — the tool names the hub itself
 * mediates (toolName='delegate', spanName='execute_tool delegate', and other
 * hub_call / hub_route / downstream invocations). It does NOT record the
 * directory names of skills consumed directly by a harness (a Claude Code
 * session reading ~/.claude/skills/<name>/SKILL.md never touches the hub, so
 * no span carries that name). Consequently the `toolName/spanName LIKE
 * %skillDir%` match below only fires for skills invoked THROUGH the hub — i.e.
 * once a PsiBot skill is promoted to a routable golden path and used via
 * hub_route/hub_call. Until that happens, zero matches is the correct,
 * expected result, not a bug. When golden-path promotion lands, revisit the
 * match to correlate on the golden-path id / hub_route spans (the
 * paramNames / redactedIntentText / redactedCandidateTools / projectId columns
 * exist for exactly this) rather than on the skill's directory name.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import { loadUsage, recordHubUse } from "../skills/usage.ts";
import { loadState, saveState } from "./state.ts";

const log = createLogger("curator.hub-signal");

/** Columns we depend on. Extra columns are fine; missing ones are drift. */
const REQUIRED_COLUMNS = ["id", "ts", "toolName", "spanName"] as const;

/** Cap per pass so a pathological store can't flood the sidecar. */
const MAX_EVENTS_PER_SKILL = 20;

export interface HubSignalReport {
  available: boolean;
  reason: string;
  matchedSkills: Array<{ name: string; uses: number }>;
}

function hubDbPath(): string {
  const raw = getConfig().HUB_TELEMETRY_DB;
  if (!raw) return "";
  return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
}

/**
 * Ingest new hub spans referencing exported skills as `use{actor:"hub"}`
 * events. Cursor lives in curator state. Never raises.
 */
export function syncHubSignal(): HubSignalReport {
  const unavailable = (reason: string): HubSignalReport => {
    log.info("Hub signal unavailable", { reason });
    return { available: false, reason, matchedSkills: [] };
  };

  try {
    const dbPath = hubDbPath();
    if (!dbPath) return unavailable("disabled (HUB_TELEMETRY_DB empty)");
    if (!existsSync(dbPath)) return unavailable(`no store at ${dbPath}`);

    // Skills to watch: currently exported ones, matched by exported name.
    const usage = loadUsage();
    const watch = Object.entries(usage)
      .filter(([, rec]) => rec.exported)
      .map(([name, rec]) => ({ name, as: rec.exported!.as }));
    if (watch.length === 0) return { available: true, reason: "no exported skills to watch", matchedSkills: [] };

    const db = new Database(dbPath, { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");

      // Drift check against the pinned column subset.
      const cols = db
        .prepare<{ name: string }, []>("PRAGMA table_info(spans)")
        .all()
        .map((c) => c.name);
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
      if (missing.length > 0) return unavailable(`schema drift — spans missing [${missing.join(", ")}]`);

      const state = loadState();
      const since = state.hubSyncTs;
      let maxTs = since;
      const matched: Array<{ name: string; uses: number }> = [];

      const stmt = db.prepare<{ ts: number }, [number, string, string]>(
        "SELECT ts FROM spans WHERE ts > ? AND (toolName LIKE ? OR spanName LIKE ?) ORDER BY ts ASC",
      );
      for (const { name, as } of watch) {
        const pattern = `%${as}%`;
        const rows = stmt.all(since, pattern, pattern);
        if (rows.length === 0) continue;
        let recorded = 0;
        for (const row of rows.slice(-MAX_EVENTS_PER_SKILL)) {
          recordHubUse(name, new Date(row.ts).toISOString());
          recorded += 1;
        }
        for (const row of rows) if (row.ts > maxTs) maxTs = row.ts;
        matched.push({ name, uses: recorded });
        log.info("Hub usage recorded", { name, as, uses: recorded, totalSpans: rows.length });
      }

      if (maxTs > since) {
        const fresh = loadState();
        fresh.hubSyncTs = maxTs;
        saveState(fresh);
      }
      return { available: true, reason: "ok", matchedSkills: matched };
    } finally {
      db.close();
    }
  } catch (e) {
    return unavailable(String(e));
  }
}
