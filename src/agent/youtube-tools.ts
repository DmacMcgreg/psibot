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
import { checkVaultStatus } from "../youtube/api.ts";
import {
  listTopics,
  getTopicWithRelations,
  getRelatedVideos,
  getSharedTopics,
  rebuildTopicGraph,
} from "../youtube/graph.ts";
import { getConfig } from "../config.ts";
import { splitMessage, escapeMarkdownV2 } from "../telegram/format.ts";
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
          await bot.api.sendMessage(userId, escapeMarkdownV2(chunk), { parse_mode: "MarkdownV2" });
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
        "Check YouTube OAuth status via the OAuth vault. Shows whether Google is connected and tokens are valid.",
        {
          check_status: z.boolean().optional().describe("Check token status (always true, kept for backwards compatibility)"),
        },
        async () => {
          try {
            const config = getConfig();
            const status = await checkVaultStatus();

            if (!config.OAUTH_VAULT_URL) {
              return {
                content: [{
                  type: "text" as const,
                  text: "OAUTH_VAULT_URL is not configured. Set it in .env to point to your OAuth token vault.",
                }],
                isError: true,
              };
            }

            if (!status.connected) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Google is not connected in the OAuth vault.\n\nConnect it at: ${config.OAUTH_VAULT_URL}/?key=<API_KEY>\n\nClick "Connect" next to Google and complete the OAuth flow.`,
                }],
              };
            }

            return {
              content: [{
                type: "text" as const,
                text: `YouTube OAuth status (via vault):\n  Connected: yes\n  Expired: ${status.expired ? "yes (will auto-refresh)" : "no"}\n  Scopes: ${status.scopes ?? "unknown"}\n  Ready to use.`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `OAuth status check failed: ${message}` }],
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

      tool(
        "youtube_topics",
        `Search and browse the topic knowledge graph built from your YouTube video library.
Each video's themes are extracted and deduplicated into a shared topic graph with co-occurrence relationships.

USAGE GUIDE:
- No arguments: lists all topics sorted by video count (most covered topics first)
- query param: search topics by name (e.g. "machine learning", "productivity")
- topic_id param: get a specific topic with its related topics and linked videos

EXPLORATION STRATEGIES:
1. "What do I know about X?" -> search topics for X, then check linked videos
2. "What connects topic A to B?" -> get both topics, look at shared related_topics
3. "What are my biggest knowledge areas?" -> list all topics, look at highest video_count
4. "Suggest something to watch" -> find topics with low video_count (gaps in knowledge)
5. Chain with youtube_get to dive deep into a specific video's full analysis
6. Chain with youtube_search for semantic search within a topic's videos`,
        {
          query: z.string().optional().describe("Search topics by name"),
          topic_id: z.number().optional().describe("Get a specific topic with its relations and videos"),
          limit: z.number().optional().describe("Max results to return (default: 50)"),
        },
        async (args) => {
          try {
            if (args.topic_id !== undefined) {
              const topic = getTopicWithRelations(args.topic_id);
              if (!topic) {
                return {
                  content: [{ type: "text" as const, text: `Topic not found: ${args.topic_id}` }],
                  isError: true,
                };
              }

              const relatedStr = topic.related_topics.length > 0
                ? topic.related_topics
                    .map((r) => `  - ${r.display_name} (${r.co_occurrence_count} shared videos) [id:${r.id}]`)
                    .join("\n")
                : "  (none)";

              const videosStr = topic.videos.length > 0
                ? topic.videos
                    .map((v) => `  - "${v.title}" by ${v.channel_title} [${v.video_id}]\n    Theme: ${v.theme_summary}`)
                    .join("\n")
                : "  (none)";

              return {
                content: [{
                  type: "text" as const,
                  text: `Topic: ${topic.display_name} (id:${topic.id}, ${topic.video_count} videos)\n${topic.description}\n\nRelated Topics:\n${relatedStr}\n\nVideos:\n${videosStr}`,
                }],
              };
            }

            const topics = listTopics(args.query, args.limit ?? 50);

            if (topics.length === 0) {
              const msg = args.query
                ? `No topics found matching "${args.query}".`
                : "No topics in the knowledge graph yet. Use youtube_summarize to add videos first.";
              return {
                content: [{ type: "text" as const, text: msg }],
              };
            }

            const lines = topics.map(
              (t) => `- ${t.display_name} (${t.video_count} videos) [id:${t.id}]`
            );

            const header = args.query
              ? `${topics.length} topics matching "${args.query}":`
              : `${topics.length} topics (sorted by video count):`;

            return {
              content: [{ type: "text" as const, text: `${header}\n\n${lines.join("\n")}` }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `Topics query failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_related",
        `Find videos related to a given video through shared topics in the knowledge graph.

USAGE GUIDE:
- Pass a video_id to find other videos that share topics with it
- Results ranked by number of shared topics (strongest connections first)
- Each result shows which topics are shared, so you can explain WHY they're related

EXPLORATION STRATEGIES:
1. User mentions a video -> find related videos to suggest more content
2. Compare two videos -> use compare_video_id to see shared topics between them
3. "What else covers topic X?" -> use youtube_topics instead to get all videos for a topic
4. Combine with youtube_search for hybrid discovery (topic-based + semantic)`,
        {
          video_id: z.string().describe("YouTube video ID to find related videos for"),
          compare_video_id: z.string().optional().describe("Compare with another video to find shared topics"),
          limit: z.number().optional().describe("Max results (default: 10)"),
        },
        async (args) => {
          try {
            if (args.compare_video_id) {
              const shared = getSharedTopics(args.video_id, args.compare_video_id);

              if (shared.length === 0) {
                return {
                  content: [{
                    type: "text" as const,
                    text: `No shared topics between ${args.video_id} and ${args.compare_video_id}.`,
                  }],
                };
              }

              const lines = shared.map(
                (t) => `- ${t.display_name} (${t.video_count} total videos) [id:${t.id}]`
              );

              return {
                content: [{
                  type: "text" as const,
                  text: `${shared.length} shared topics between ${args.video_id} and ${args.compare_video_id}:\n\n${lines.join("\n")}`,
                }],
              };
            }

            const related = getRelatedVideos(args.video_id, args.limit ?? 10);

            if (related.length === 0) {
              return {
                content: [{
                  type: "text" as const,
                  text: `No related videos found for ${args.video_id}. The video may not be in the graph yet.`,
                }],
              };
            }

            const lines = related.map(
              (r) => `- "${r.title}" by ${r.channel_title} (${r.shared_topic_count} shared topics) [${r.video_id}]\n  Topics: ${r.shared_topics}`
            );

            return {
              content: [{
                type: "text" as const,
                text: `${related.length} videos related to ${args.video_id}:\n\n${lines.join("\n\n")}`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `Related videos query failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "youtube_rebuild_graph",
        "Rebuild the YouTube topic knowledge graph from all stored videos. Use this if the graph seems stale or after bulk-importing videos. Clears all existing topic data and re-extracts from every video's analysis_json.",
        {},
        async () => {
          try {
            const counts = rebuildTopicGraph();
            return {
              content: [{
                type: "text" as const,
                text: `Topic graph rebuilt successfully.\n  Topics: ${counts.topicCount}\n  Video-topic links: ${counts.linkCount}\n  Topic co-occurrence relations: ${counts.relationCount}`,
              }],
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `Graph rebuild failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}
