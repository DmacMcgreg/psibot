/**
 * The `youtube_process_playlist` tool — job 12's "YouTube Watchlist
 * Processor" runs exactly this tool (cron every 3 h; map §2.3 row 3,
 * psibot-oauth-recovery-map). Split from youtube-tools.ts (867 lines, over
 * the 500-line gate) because this handler is the agent-relayed re-auth alert
 * surface the watchlist latch hooks; exported so the latch suite drives the
 * real handler.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createLogger } from "../shared/logger.ts";
import { processPlaylist, type VideoDetail } from "../youtube/playlist.ts";
import { getConfig } from "../config.ts";
import { ReauthRequiredError } from "../youtube/api.ts";
import {
  watchlistReauthOutcome,
  WATCHLIST_REAUTH_RECOVERED_MESSAGE,
} from "./watchlist-reauth-latch.ts";

const log = createLogger("youtube-playlist-tool");

export function youtubeProcessPlaylistTool() {
  return tool(
    "youtube_process_playlist",
    "Process videos from a YouTube playlist. Fetches items from the source playlist, extracts transcripts, analyzes them, generates embeddings, and moves processed videos to a destination playlist. Retries previously failed playlist moves.",
    {
      source_playlist_id: z.string().optional().describe("Source YouTube playlist ID (defaults to YOUTUBE_SOURCE_PLAYLIST_ID env var)"),
      destination_playlist_id: z.string().optional().describe("Destination playlist ID (defaults to YOUTUBE_DESTINATION_PLAYLIST_ID env var)"),
      limit: z.number().optional().describe("Max videos to process (default: 50)"),
      retry_failed: z.boolean().optional().describe("Retry previously failed playlist moves (default: true)"),
    },
    async (args) => {
      try {
        const config = getConfig();
        const result = await processPlaylist({
          sourcePlaylistId: args.source_playlist_id,
          destinationPlaylistId: args.destination_playlist_id,
          limit: args.limit,
          retryFailed: args.retry_failed,
          model: config.YOUTUBE_ANALYSIS_MODEL,
        });

        const statusIcon = (status: VideoDetail["status"]): string => {
          switch (status) {
            case "processed": return "[NEW]";
            case "skipped": return "[SKIP]";
            case "moved": return "[MOVE]";
            case "failed_to_move": return "[MOVE_ERR]";
            case "failed": return "[FAIL]";
          }
        };

        const lines = [
          `Playlist processing complete (${result.processed} new, ${result.skipped} skipped, ${result.moved} moved, ${result.failed} failed)`,
        ];

        if (result.remaining > 0) {
          lines.push(`${result.remaining} videos still in the playlist — time budget reached; the next run continues.`);
        }

        if (result.retrySuccesses > 0 || result.retryFailures > 0) {
          lines.push(`Retries: ${result.retrySuccesses} succeeded, ${result.retryFailures} failed`);
        }

        if (result.details.length > 0) {
          lines.push("");
          for (const d of result.details) {
            lines.push(`${statusIcon(d.status)} ${d.title}`);
          }
        }

        if (result.errors.length > 0) {
          lines.push(`\nErrors:`);
          for (const err of result.errors) {
            lines.push(`  - ${err.videoId}: ${err.error}`);
          }
        }

        // Healthy run through the vault token: the watchlist reauth latch
        // closes any open episode with exactly one relayed recovery ping.
        if ((await watchlistReauthOutcome({ reauthRequired: false })).recovered) {
          lines.unshift(WATCHLIST_REAUTH_RECOVERED_MESSAGE);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        // Dead google token: one re-auth notice per episode (latch), so N
        // consecutive dead runs relay exactly one message — the map §2.3
        // repeated-alert anti-pattern. Latched repeats get a calm skip note
        // with no re-auth wording for the agent to re-relay.
        if (error instanceof ReauthRequiredError) {
          const { reauthText } = await watchlistReauthOutcome({ reauthRequired: true });
          if (reauthText) {
            return {
              content: [{ type: "text" as const, text: `Playlist processing failed: ${reauthText}` }],
              isError: true,
            };
          }
          return {
            content: [{
              type: "text" as const,
              text: "Playlist processing skipped — a Google re-auth episode is already flagged from a previous run and the re-auth notice does not repeat. The next successful run confirms recovery automatically.",
            }],
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        log.error("youtube_process_playlist failed", { error: message });
        return {
          content: [{ type: "text" as const, text: `Playlist processing failed: ${message}` }],
          isError: true,
        };
      }
    }
  );
}
