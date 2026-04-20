import { createHash } from "node:crypto";
import type { Agent, AgentNotifyPolicy, Job, RunStatus } from "../shared/types.ts";

export interface NotifyDecision {
  notify: boolean;
  policy: AgentNotifyPolicy;
  reason: string;
  hash: string;
  cleanedResult: string;
}

export interface NotifyInput {
  agent: Agent | null;
  job: Job;
  status: RunStatus;
  result: string;
  previousHash: string | null;
}

const DYNAMIC_NOTIFY_RE = /\[NOTIFY(?::\s*([^\]]+))?\]/i;
const DYNAMIC_SILENT_RE = /\[SILENT\]/i;

export function resolveNotifyPolicy(agent: Agent | null, job: Job): AgentNotifyPolicy {
  return (job.notify_policy as AgentNotifyPolicy | null) ?? agent?.notify_policy ?? "always";
}

export function hashResult(result: string): string {
  return createHash("sha256").update(result.trim()).digest("hex").slice(0, 16);
}

function stripMarkers(result: string): string {
  return result
    .replace(DYNAMIC_NOTIFY_RE, "")
    .replace(DYNAMIC_SILENT_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decideNotify(input: NotifyInput): NotifyDecision {
  const policy = resolveNotifyPolicy(input.agent, input.job);
  const hash = hashResult(input.result);
  const cleaned = stripMarkers(input.result);

  switch (policy) {
    case "silent":
      return { notify: false, policy, reason: "agent policy=silent", hash, cleanedResult: cleaned };

    case "always":
      return { notify: true, policy, reason: "agent policy=always", hash, cleanedResult: cleaned };

    case "on_error":
      return {
        notify: input.status !== "success",
        policy,
        reason: input.status === "success" ? "status=success and policy=on_error" : `status=${input.status}`,
        hash,
        cleanedResult: cleaned,
      };

    case "on_change": {
      const changed = input.previousHash !== hash;
      return {
        notify: changed,
        policy,
        reason: changed ? "output changed since last run" : "output unchanged since last run",
        hash,
        cleanedResult: cleaned,
      };
    }

    case "dynamic": {
      const notifyMatch = input.result.match(DYNAMIC_NOTIFY_RE);
      const silentMatch = DYNAMIC_SILENT_RE.test(input.result);
      if (silentMatch) return { notify: false, policy, reason: "agent emitted [SILENT]", hash, cleanedResult: cleaned };
      if (notifyMatch) {
        const why = notifyMatch[1]?.trim() || "agent emitted [NOTIFY]";
        return { notify: true, policy, reason: why, hash, cleanedResult: cleaned };
      }
      // No marker: default behavior is on_error for dynamic (conservative).
      return {
        notify: input.status !== "success",
        policy,
        reason: input.status === "success" ? "dynamic default: status=success, no marker" : `dynamic default: status=${input.status}`,
        hash,
        cleanedResult: cleaned,
      };
    }
  }
}
