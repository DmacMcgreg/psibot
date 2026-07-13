export class ChatState {
  /** Chats that should start fresh on next message */
  readonly resetChats = new Set<string>();
  /** Chats that have booted (had first message) */
  readonly bootedChats = new Set<string>();
  /** Override session ID for /resume - cleared by /new */
  readonly resumeOverrides = new Map<string, string>();
  /** Per-chat model override - cleared by /model with no args */
  readonly modelOverrides = new Map<string, string>();
  /** Fleet proposal cards successfully rendered by the heartbeat. */
  readonly renderedFleetProposalIds = new Set<string>();
  /**
   * Session key -> (thinking-message id -> active agent runId), for the
   * in-progress Cancel button. Keyed per message (not just per session) so
   * overlapping runs in the same chat/topic don't clobber each other's entry
   * or let Cancel target the wrong run.
   */
  readonly activeRuns = new Map<string, Map<number, string>>();

  /** Register a run as active for the given thinking-message id within a session. */
  setActiveRun(sessionKey: string, messageId: number, runId: string): void {
    let runs = this.activeRuns.get(sessionKey);
    if (!runs) {
      runs = new Map();
      this.activeRuns.set(sessionKey, runs);
    }
    runs.set(messageId, runId);
  }

  /** Look up the active runId for a specific thinking-message id, if any. */
  getActiveRun(sessionKey: string, messageId: number): string | undefined {
    return this.activeRuns.get(sessionKey)?.get(messageId);
  }

  /** Remove exactly one run's entry; cleans up the session's inner map once empty. */
  deleteActiveRun(sessionKey: string, messageId: number): void {
    const runs = this.activeRuns.get(sessionKey);
    if (!runs) return;
    runs.delete(messageId);
    if (runs.size === 0) this.activeRuns.delete(sessionKey);
  }
}
