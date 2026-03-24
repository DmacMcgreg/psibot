import { createLogger } from "../shared/logger.ts";
import {
  getFeedbackForSignal,
  getAutonomyRule,
  upsertAutonomyRule,
} from "../db/queries.ts";
import type { AutonomyLevel } from "../shared/types.ts";

const log = createLogger("heartbeat:autonomy");

const THRESHOLDS: Record<AutonomyLevel, { minDecisions: number; minAgreement: number }> = {
  manual: { minDecisions: 0, minAgreement: 0 },
  suggest: { minDecisions: 5, minAgreement: 0.7 },
  auto_report: { minDecisions: 15, minAgreement: 0.9 },
  silent: { minDecisions: 30, minAgreement: 0.95 },
};

const LEVEL_ORDER: AutonomyLevel[] = ["manual", "suggest", "auto_report", "silent"];

/**
 * After a user action, recalculate confidence for the relevant signal.
 * Updates autonomy_rules table and progresses/regresses level.
 */
export function updateAutonomyFromFeedback(params: {
  signalType: string;
  signalValue: string;
  systemRecommendation: string;
  userAction: string;
}): void {
  const { signalType, signalValue, systemRecommendation, userAction } = params;
  const isAgreement = systemRecommendation === userAction;

  // Get existing rule or create default
  const existing = getAutonomyRule(signalType, signalValue);
  const currentLevel = existing?.level ?? "manual";
  const currentCount = existing?.decision_count ?? 0;
  const newCount = currentCount + 1;

  // If user overrode the system, reset to manual
  if (!isAgreement && currentLevel !== "manual") {
    upsertAutonomyRule({
      signal_type: signalType,
      signal_value: signalValue,
      learned_action: userAction,
      confidence: 0,
      decision_count: 0,
      level: "manual",
    });
    log.info("Autonomy reset to manual (user override)", {
      signalType,
      signalValue,
      was: currentLevel,
    });
    return;
  }

  // Calculate new confidence from recent feedback history
  const recentFeedback = getFeedbackForSignal(signalType, signalValue, 50);
  const agreements = recentFeedback.filter(
    (f) => f.system_recommendation === f.user_action
  ).length;
  const confidence = recentFeedback.length > 0
    ? agreements / recentFeedback.length
    : 0;

  // Determine appropriate level based on thresholds
  let newLevel: AutonomyLevel = "manual";
  for (const level of LEVEL_ORDER) {
    const threshold = THRESHOLDS[level];
    if (newCount >= threshold.minDecisions && confidence >= threshold.minAgreement) {
      newLevel = level;
    }
  }

  upsertAutonomyRule({
    signal_type: signalType,
    signal_value: signalValue,
    learned_action: isAgreement ? systemRecommendation : userAction,
    confidence,
    decision_count: newCount,
    level: newLevel,
  });

  if (newLevel !== currentLevel) {
    log.info("Autonomy level changed", {
      signalType,
      signalValue,
      from: currentLevel,
      to: newLevel,
      confidence: confidence.toFixed(2),
      decisions: newCount,
    });
  }
}

/**
 * Check if the system should auto-act on an item based on learned rules.
 * Returns the action to take, or null if manual decision needed.
 */
export function checkAutonomyRule(
  signalType: string,
  signalValue: string
): { action: string; level: AutonomyLevel } | null {
  const rule = getAutonomyRule(signalType, signalValue);
  if (!rule) return null;

  if (rule.level === "auto_report" || rule.level === "silent") {
    return { action: rule.learned_action, level: rule.level };
  }

  return null;
}
