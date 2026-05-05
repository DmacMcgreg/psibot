/**
 * Skill write-origin provenance — the safety rail that prevents the curator
 * from ever touching user-authored skills.
 *
 * The background self-improvement review fork wraps its agent invocation
 * with `withWriteOrigin(BACKGROUND_REVIEW, ...)`. When `skill_manage create`
 * runs inside that scope, it sees the origin and calls `markAgentCreated`,
 * which sets `created_by: "agent"` in the usage sidecar — making the skill
 * eligible for autonomous curator management.
 *
 * Foreground tool calls (the user asking for a skill, a regular agent run,
 * cron jobs) leave the origin at "foreground" and never get the agent-created
 * marker. The curator's `agentCreatedReport` filters on that marker, so
 * user-authored skills are invisible to it.
 *
 * Direct port of Hermes' `tools/skill_provenance.py` — Python uses ContextVar,
 * we use Node's AsyncLocalStorage which provides the same async-safe scope.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export const BACKGROUND_REVIEW = "background_review" as const;
export const FOREGROUND = "foreground" as const;

export type WriteOrigin = typeof BACKGROUND_REVIEW | typeof FOREGROUND;

const store = new AsyncLocalStorage<WriteOrigin>();

export function withWriteOrigin<T>(origin: WriteOrigin, fn: () => T): T {
  return store.run(origin, fn);
}

export async function withWriteOriginAsync<T>(origin: WriteOrigin, fn: () => Promise<T>): Promise<T> {
  return store.run(origin, fn);
}

export function getCurrentWriteOrigin(): WriteOrigin {
  return store.getStore() ?? FOREGROUND;
}

export function isBackgroundReview(): boolean {
  return getCurrentWriteOrigin() === BACKGROUND_REVIEW;
}
