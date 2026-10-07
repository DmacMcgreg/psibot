/**
 * Shared shape for the asset pollers. Each source lists items from an existing
 * store (youtube_videos, tab-archive, pending_items, research_notes) newest
 * first; the runner gates them, then loads full text only for items that pass.
 */

export type SourceKind = "youtube" | "tab" | "github" | "inbox" | "research";
export const SOURCE_KINDS: SourceKind[] = ["youtube", "tab", "github", "inbox", "research"];

export interface SourceItem {
  source_kind: SourceKind;
  source_ref: string;
  url: string | null;
  title: string;
  published_at: string | null;
  /** The row's own capture timestamp, in the source's own format (watermarks compare within a source). */
  created_at: string;
  /** David chose this himself (Watch Later, Telegram send, GitHub star, Research button). */
  explicit: boolean;
  /** Body text the gate embeds after the title (only the first ~2k chars are used). */
  gate_text: string;
  /** Extra hint for the extractor, e.g. "David starred this repo on GitHub." */
  context?: string;
  /** Full text for the extractor. May hit the network (GitHub README). */
  loadText(): Promise<string>;
}

export interface ListOptions {
  /** Only rows created strictly after this value (source's own timestamp format). */
  after?: string | null;
  /** Only rows created within this many days. */
  sinceDays?: number;
  limit: number;
}

export interface Source {
  kind: SourceKind;
  list(opts: ListOptions): SourceItem[];
}

/** SQLite-comparable cutoff for "N days ago" in both "YYYY-MM-DD HH:MM:SS" and ISO forms. */
export function daysAgo(days: number, iso = false): string {
  const d = new Date(Date.now() - days * 86_400_000).toISOString();
  return iso ? d : d.replace("T", " ").slice(0, 19);
}
