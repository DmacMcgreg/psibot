export class ChatState {
  /** Chats that should start fresh on next message */
  readonly resetChats = new Set<string>();
  /** Chats that have booted (had first message) */
  readonly bootedChats = new Set<string>();
  /** Override session ID for /resume - cleared by /new */
  readonly resumeOverrides = new Map<string, string>();
  /** Per-chat model override - cleared by /model with no args */
  readonly modelOverrides = new Map<string, string>();
}
