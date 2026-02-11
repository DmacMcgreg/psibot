import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createLogger } from "../shared/logger.ts";
import { embedText } from "../youtube/embeddings.ts";
import {
  getVideo,
  listVideos,
  vectorSearch,
  getVideoCount,
  getPlaylistProcessingStats,
  getVideosNeedingPlaylistUpdate,
} from "../youtube/db.ts";
import { processAndStoreVideo } from "../youtube/process.ts";
import { processPlaylist, type VideoDetail } from "../youtube/playlist.ts";
import { getAuthUrl, loadTokens } from "../youtube/api.ts";
import { getConfig } from "../config.ts";
import { splitMessage } from "../telegram/format.ts";
import type { ParsedTranscript } from "../youtube/analyzer.ts";
import type { Bot } from "grammy";

const log = createLogger("youtube-tools");

export interface YoutubeDeps {
  getBot: () => Bot | null;
  defaultChatIds: number[];
  keepAlive: () => void;
}

export function createYoutubeTools(deps: YoutubeDeps) {
  const { getBot, defaultChatIds, keepAlive } = deps;

  async function notifyTelegram(text: string): Promise<void> {
    keepAlive();
    const bot = getBot();
    if (!bot || defaultChatIds.length === 0) return;
    const chunks = splitMessage(text);
    for (const userId of defaultChatIds) {
      try {
        for (const chunk of chunks) {
          await bot.api.sendMessage(userId, chunk);
        }
      } catch (err) {
        log.error("Failed to send progress notification", { userId, error: String(err) });
      }
    }
  }
  return createSdkMcpServer({
    name: "youtube-tools",
    version: "1.0.0",
    tools: [
      tool(
        "youtube_summarize",
        "Summarize a YouTube video. Extracts transcript, analyzes with Claude, stores in database with vector embeddings for semantic search. Accepts a YouTube URL or video ID.",
        {
          video: z.string().describe("YouTube URL or video ID (e.g. 'https://youtube.com/watch?v=dQw4w9WgXcQ' or 'dQw4w9WgXcQ')"),
        },
        async (args) => {
          try {
            const result = await processAndStoreVideo(args.video);

            if (result.skipped) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Video already summarized: "${result.title}" by ${result.channelTitle}\n\n${result.markdownSummary}`,
                }],
              };
            }

            return {
              content: [{
                type: "text" as const,
                text: `Summarized "${result.title}" by ${result.channelTitle}\n(${result.chunkCount} chunks embedded)\n\n${result.markdownSummary}`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error("youtube_summarize failed", { error: message });
            return {
              content: [{ type: "text" as const, text: `Failed to summarize video: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_search",
        "Semantic search across all stored YouTube video summaries using vector embeddings. Returns the most relevant chunks (themes, topics, insights, quotes) matching the query.",
        {
          query: z.string().describe("Natural language search query (e.g. 'quantum physics experiments', 'productivity tips')"),
          limit: z.number().optional().describe("Max results to return (default: 10)"),
        },
        async (args) => {
          try {
            const count = getVideoCount();
            if (count === 0) {
              return {
                content: [{ type: "text" as const, text: "No videos stored yet. Use youtube_summarize to add videos first." }],
              };
            }

            log.info("Vector search", { query: args.query, limit: args.limit });
            const queryEmbedding = await embedText(args.query);
            const results = vectorSearch(queryEmbedding, args.limit ?? 10);

            if (results.length === 0) {
              return {
                content: [{ type: "text" as const, text: `No results found for: "${args.query}"` }],
              };
            }

            const lines = results.map((r, i) => {
              const similarity = (1 - r.distance).toFixed(3);
              return `${i + 1}. [${r.chunk_type}] "${r.title}" by ${r.channel_title} (similarity: ${similarity})\n   ${r.chunk_text}`;
            });

            return {
              content: [{
                type: "text" as const,
                text: `Found ${results.length} results for "${args.query}":\n\n${lines.join("\n\n")}`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error("youtube_search failed", { error: message });
            return {
              content: [{ type: "text" as const, text: `Search failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_list",
        "List all stored YouTube video summaries. Optionally filter by keyword, channel, or limit.",
        {
          keyword: z.string().optional().describe("Filter by keyword in title, tags, or summary"),
          channel: z.string().optional().describe("Filter by channel name"),
          limit: z.number().optional().describe("Max results (default: 50)"),
        },
        async (args) => {
          try {
            const videos = listVideos({
              keyword: args.keyword,
              channel: args.channel,
              limit: args.limit,
            });

            if (videos.length === 0) {
              const total = getVideoCount();
              if (total === 0) {
                return {
                  content: [{ type: "text" as const, text: "No videos stored yet. Use youtube_summarize to add videos." }],
                };
              }
              return {
                content: [{ type: "text" as const, text: `No videos match the filters. ${total} total videos stored.` }],
              };
            }

            const lines = videos.map((v) => {
              const tags = JSON.parse(v.tags) as string[];
              const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
              return `- "${v.title}" by ${v.channel_title}${tagStr}\n  ID: ${v.video_id} | ${v.processed_at}`;
            });

            const total = getVideoCount();
            return {
              content: [{
                type: "text" as const,
                text: `${videos.length} of ${total} videos:\n\n${lines.join("\n\n")}`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `List failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_get",
        "Get the full summary and structured analysis for a specific stored YouTube video.",
        {
          video_id: z.string().describe("YouTube video ID (11 characters)"),
        },
        async (args) => {
          try {
            const video = getVideo(args.video_id);
            if (!video) {
              return {
                content: [{ type: "text" as const, text: `Video not found: ${args.video_id}. Use youtube_list to see stored videos.` }],
                isError: true,
              };
            }

            const analysis = JSON.parse(video.analysis_json) as ParsedTranscript;
            const tags = JSON.parse(video.tags) as string[];

            const themesStr = analysis.themes
              .map((t) => `  - ${t.name}: ${t.summary}`)
              .join("\n");

            const topicsStr = analysis.key_topics
              .map((t) => `  - [${t.timestamp}] ${t.topic}: ${t.summary}`)
              .join("\n");

            const insightsStr = analysis.insights
              .map((i) => {
                const ts = i.timestamp ? `[${i.timestamp}] ` : "";
                return `  - ${ts}${i.insight}`;
              })
              .join("\n");

            const quotesStr = analysis.quotes
              .map((q) => {
                const speaker = q.speaker ? ` (${q.speaker})` : "";
                return `  - [${q.timestamp}]${speaker}: "${q.quote}"`;
              })
              .join("\n");

            const text = `"${video.title}" by ${video.channel_title}
URL: ${video.url}
Tags: ${tags.join(", ")}
Processed: ${video.processed_at}

${video.markdown_summary}

Themes:
${themesStr}

Key Topics:
${topicsStr}

Insights:
${insightsStr}

Quotes:
${quotesStr}`;

            return {
              content: [{ type: "text" as const, text }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `Get failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_process_playlist",
        "Process videos from a YouTube playlist. Fetches items from the source playlist, extracts transcripts, analyzes them, generates embeddings, and moves processed videos to a destination playlist. Retries previously failed playlist moves.",
        {
          source_playlist_id: z.string().optional().describe("Source YouTube playlist ID (defaults to YOUTUBE_SOURCE_PLAYLIST_ID env var)"),
          destination_playlist_id: z.string().optional().describe("Destination YouTube playlist ID (defaults to YOUTUBE_DESTINATION_PLAYLIST_ID env var)"),
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
              onProgress: notifyTelegram,
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

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.error("youtube_process_playlist failed", { error: message });
            return {
              content: [{ type: "text" as const, text: `Playlist processing failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_oauth_setup",
        "Set up YouTube OAuth authorization. Without arguments, returns the authorization URL to visit. With check_status=true, verifies that tokens exist and are valid.",
        {
          check_status: z.boolean().optional().describe("If true, check token status instead of generating auth URL"),
        },
        async (args) => {
          try {
            if (args.check_status) {
              const tokens = loadTokens();
              if (!tokens) {
                return {
                  content: [{ type: "text" as const, text: "No YouTube OAuth tokens found. Use youtube_oauth_setup (without check_status) to get the authorization URL." }],
                };
              }

              const expiresIn = Math.max(0, Math.floor((tokens.expires_at - Date.now()) / 1000));
              const isExpired = expiresIn === 0;

              return {
                content: [{
                  type: "text" as const,
                  text: `YouTube OAuth status:\n  Token type: ${tokens.token_type}\n  Refresh token: present\n  Access token: ${isExpired ? "expired" : `valid for ${expiresIn}s`}\n  ${isExpired ? "Token will auto-refresh on next API call." : "Ready to use."}`,
                }],
              };
            }

            const url = getAuthUrl();
            return {
              content: [{
                type: "text" as const,
                text: `Visit this URL to authorize YouTube access:\n\n${url}\n\nAfter authorizing, the callback will save tokens automatically. Use youtube_oauth_setup with check_status=true to verify.`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `OAuth setup failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_playlist_status",
        "Show the status of YouTube playlist processing: videos pending, failed moves, retry queue, and overall statistics.",
        {},
        async () => {
          try {
            const stats = getPlaylistProcessingStats();
            const needsUpdate = getVideosNeedingPlaylistUpdate();
            const total = getVideoCount();

            const lines = [
              `YouTube Processing Status (${total} total videos):`,
              `  Complete: ${stats.complete}`,
              `  Marked processed: ${stats.marked_processed}`,
              `  Analyzed (pending move): ${stats.analyzed}`,
              `  Failed to mark: ${stats.failed_to_mark}`,
              `  Failed: ${stats.failed}`,
              `  Pending: ${stats.pending}`,
              `  Processing: ${stats.processing}`,
            ];

            if (needsUpdate.length > 0) {
              lines.push(`\nVideos needing playlist update (${needsUpdate.length}):`);
              for (const v of needsUpdate.slice(0, 20)) {
                const attempts = v.marking_attempts > 0 ? ` (${v.marking_attempts} attempts)` : "";
                lines.push(`  - ${v.video_id}: "${v.title}" [${v.processing_status}]${attempts}`);
              }
              if (needsUpdate.length > 20) {
                lines.push(`  ... and ${needsUpdate.length - 20} more`);
              }
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `Status check failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}
