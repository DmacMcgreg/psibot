import { indexItem, removeItem, type AtlasKind } from "./index.ts";
import type { PendingItem, TradingSignal } from "../shared/types.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("atlas:sync");

interface StoredVideoRow {
  video_id: string;
  title: string;
  channel_title: string;
  url: string;
  markdown_summary: string;
  processed_at: string;
  tags?: string;
}

/**
 * Pick the best-available text body for a pending inbox item.
 * Preference order: triage summary → quick-scan summary → description.
 * Returns a short body (not the full description) to keep the FTS index lean.
 */
function pendingItemBody(item: PendingItem): string {
  const candidates = [item.triage_summary, item.quick_scan_summary, item.description];
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  return item.title ?? item.url ?? "";
}

/**
 * Heuristic — deleted items shouldn't surface in search. Drop rows marked `deleted`,
 * but keep `archived` so the user can still recall items they acted on.
 */
export function syncAtlasForPendingItem(item: PendingItem | null | undefined): void {
  if (!item) return;
  try {
    if (item.status === "deleted") {
      removeItem("pending_items", String(item.id));
      return;
    }
    const metadata: Record<string, unknown> = {
      source: item.source,
      platform: item.platform,
      profile: item.profile,
      priority: item.priority,
      category: item.category,
      value_type: item.value_type,
      watch_status: item.watch_status,
      signal_score: item.signal_score,
      status: item.status,
    };
    indexItem({
      kind: "inbox",
      sourceTable: "pending_items",
      sourceId: String(item.id),
      title: item.title ?? item.url ?? `Item ${item.id}`,
      body: pendingItemBody(item),
      url: item.url,
      capturedAt: item.captured_at ?? item.created_at,
      metadata,
    });
  } catch (err) {
    log.error("Failed to sync pending_items", {
      id: item.id,
      error: String(err),
    });
  }
}

export function syncAtlasForYoutubeVideo(video: StoredVideoRow): void {
  if (!video.video_id) return;
  try {
    indexItem({
      kind: "youtube",
      sourceTable: "youtube_videos",
      sourceId: video.video_id,
      title: video.title,
      body: video.markdown_summary,
      url: video.url,
      capturedAt: video.processed_at,
      metadata: {
        channel: video.channel_title,
        tags: video.tags ? safeParseTags(video.tags) : [],
      },
    });
  } catch (err) {
    log.error("Failed to sync youtube_videos", {
      id: video.video_id,
      error: String(err),
    });
  }
}

function safeParseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function syncAtlasForTradingSignal(signal: TradingSignal): void {
  try {
    const title = `${signal.ticker} ${signal.direction} — ${signal.source}`;
    indexItem({
      kind: "signal",
      sourceTable: "trading_signals",
      sourceId: String(signal.id),
      title,
      body: signal.reason ?? "",
      url: signal.source_url ?? null,
      capturedAt: signal.captured_at,
      metadata: {
        ticker: signal.ticker,
        direction: signal.direction,
        strength: signal.strength,
        source: signal.source,
      },
    });
  } catch (err) {
    log.error("Failed to sync trading_signals", {
      id: signal.id,
      error: String(err),
    });
  }
}

export interface ResearchNoteInput {
  sourceId: string;
  title: string;
  summary: string;
  keyFindings?: string;
  notePath: string | null;
  url?: string | null;
  capturedAt?: string;
  depth?: "quick" | "deep";
}

export function syncAtlasForResearchNote(input: ResearchNoteInput): void {
  try {
    const parts = [input.summary];
    if (input.keyFindings) parts.push(input.keyFindings);
    indexItem({
      kind: "research",
      sourceTable: "research_notes",
      sourceId: input.sourceId,
      title: input.title,
      body: parts.filter(Boolean).join("\n\n"),
      url: input.url ?? null,
      capturedAt: input.capturedAt ?? new Date().toISOString(),
      metadata: {
        depth: input.depth ?? "deep",
        notePath: input.notePath,
      },
    });
  } catch (err) {
    log.error("Failed to sync research_notes", {
      id: input.sourceId,
      error: String(err),
    });
  }
}

export function syncAtlasForDailyLog(params: {
  filePath: string;
  content: string;
  capturedAt?: string;
}): void {
  try {
    const dateLine = params.filePath.replace(/^memory\//, "").replace(/\.md$/, "");
    indexItem({
      kind: "daily_log",
      sourceTable: "memory_files",
      sourceId: params.filePath,
      title: `Daily log ${dateLine}`,
      body: params.content,
      url: null,
      capturedAt: params.capturedAt ?? new Date().toISOString(),
      metadata: { date: dateLine },
    });
  } catch (err) {
    log.error("Failed to sync daily log", {
      filePath: params.filePath,
      error: String(err),
    });
  }
}

export function syncAtlasForScan(params: {
  filePath: string;
  body: string;
  title?: string;
  capturedAt?: string;
}): void {
  try {
    const fallbackTitle =
      params.filePath.split("/").pop()?.replace(/\.md$/, "") ?? params.filePath;
    indexItem({
      kind: "scan",
      sourceTable: "scan_files",
      sourceId: params.filePath,
      title: params.title ?? fallbackTitle,
      body: params.body,
      url: null,
      capturedAt: params.capturedAt ?? new Date().toISOString(),
      metadata: { path: params.filePath },
    });
  } catch (err) {
    log.error("Failed to sync scan file", {
      filePath: params.filePath,
      error: String(err),
    });
  }
}

/** Kind labels for the library UI and diagnostics. */
export const KIND_LABEL: Record<AtlasKind, string> = {
  inbox: "Inbox",
  youtube: "YouTube",
  signal: "Signal",
  research: "Research",
  scan: "Scan",
  daily_log: "Daily log",
};
