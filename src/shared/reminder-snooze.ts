/**
 * Shared snooze-tier calculation for the reminders system.
 * Used by both the create_reminder tool (src/agent/tools.ts) and the
 * heartbeat's checkDueReminders() (src/heartbeat/index.ts) so the two call
 * sites can never drift out of sync.
 */

/** Calculate snooze duration based on how soon the reminder is due.
 *  Priority 1 = hourly when due/overdue.
 *  Priority 2 = every 4-12h depending on proximity.
 *  Priority 3+ = daily or every 2 days — NOT hourly.
 */
export function getUrgencySnoozeMs(dueDate: string | null, priority: number): number {
  const HOUR = 3600_000;

  // Priority 1 = critical/urgent: hourly only for these
  if (priority === 1) {
    if (!dueDate) return 4 * HOUR;
    const due = new Date(dueDate);
    const daysUntilDue = (due.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysUntilDue <= 1 ? 1 * HOUR : 4 * HOUR;
  }

  // Priority 2 = high but not critical
  if (priority === 2) {
    if (!dueDate) return 8 * HOUR;
    const due = new Date(dueDate);
    const daysUntilDue = (due.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilDue <= 1) return 4 * HOUR;    // Due/tomorrow: every 4h
    if (daysUntilDue <= 2) return 8 * HOUR;    // 2 days: every 8h
    return 12 * HOUR;                           // 3+ days: every 12h
  }

  // Priority 3-5 = normal/low: daily or less frequent
  if (!dueDate) return 48 * HOUR;               // No due date: every 2 days
  const due = new Date(dueDate);
  const daysUntilDue = (due.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysUntilDue <= 1) return 12 * HOUR;      // Due/tomorrow: every 12h
  if (daysUntilDue <= 2) return 24 * HOUR;      // 2 days: daily
  return 48 * HOUR;                              // 3+ days: every 2 days
}
