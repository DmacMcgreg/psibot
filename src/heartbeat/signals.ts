import { createLogger } from "../shared/logger.ts";
import type { PendingItem } from "../shared/types.ts";

const log = createLogger("heartbeat:signals");

interface SignalResult {
  score: number;
  autoAction: "archive" | null;
  compoundKey: string;
}

/**
 * Score a triaged item using its triage output.
 *
 * The triage LLM already did the semantic work (value_type, priority, tags).
 * This layer makes routing decisions based on that structured output.
 *
 * Auto-actions are conservative:
 * - P5 + no_value (confirmed, not a triage failure) → auto-archive
 * - Everything else → surface to user, let them decide
 *
 * The compound key is used by the autonomy system to learn patterns
 * from user feedback (e.g., "reddit:LocalLLaMA:technique" → user usually researches).
 */
export function scoreSignals(item: PendingItem): SignalResult {
  // Build compound signal key for autonomy learning
  const platform = item.platform ?? "unknown";
  const profile = item.profile ?? "*";
  const valueType = item.value_type ?? "unknown";
  const compoundKey = `${platform}:${profile}:${valueType}`;

  // Score based on triage priority (higher priority = higher score)
  const priority = item.priority ?? 3;
  const score = Math.max(0, (6 - priority) * 20); // P1=100, P2=80, P3=60, P4=40, P5=20

  // Only auto-archive P5 no_value items that were genuinely triaged (not failures)
  let autoAction: SignalResult["autoAction"] = null;
  if (
    priority === 5 &&
    item.value_type === "no_value" &&
    item.triage_summary &&
    !item.triage_summary.toLowerCase().includes("failed") &&
    !item.triage_summary.toLowerCase().includes("could not") &&
    item.extracted_value &&
    !item.extracted_value.toLowerCase().includes("failed")
  ) {
    autoAction = "archive";
  }

  log.info("Signal scoring", {
    itemId: item.id,
    score,
    priority,
    valueType,
    compoundKey,
    autoAction,
  });

  return { score, autoAction, compoundKey };
}
