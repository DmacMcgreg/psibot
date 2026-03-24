import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { MemorySystem } from "../memory/index.ts";
import {
  createJob,
  getAllJobs,
  getJob,
  updateJob,
  deleteJob,
  getJobRuns,
  getPortfolioConfig,
  updatePortfolioConfig,
  openPosition,
  closePosition,
  updatePositionPrice,
  getOpenPositions,
  getClosedPositions,
  getPositionByTicker,
  insertDailySnapshot,
  getRecentSnapshots,
  getPortfolioSummary,
  insertPendingItem,
  getPendingItems,
  getPendingItemCount,
  getPendingItemById,
  updatePendingItem,
  insertReminder,
} from "../db/queries.ts";
import {
  preliminaryResearch,
  deepResearch,
  createResearchNote,
} from "../research/index.ts";
import { triageAllPending } from "../triage/index.ts";
import { briefingActionKeyboard, approvalKeyboard } from "../telegram/keyboards.ts";
import { pollRedditSaved } from "../capture/reddit.ts";
import { pollGithubStars } from "../capture/github.ts";
import { createLogger } from "../shared/logger.ts";
import type { Bot, InputFile as GrammyInputFile } from "grammy";

const log = createLogger("tools");

export interface ToolDeps {
  memory: MemorySystem;
  reloadScheduler: () => void;
  triggerJob: (jobId: number) => void;
  getBot: () => Bot | null;
  defaultChatIds: number[];
  groupChatIds: number[];
  psibotDir: string;
  scheduleRestart: () => void;
}

export function createAgentTools(deps: ToolDeps) {
  const { memory, reloadScheduler, triggerJob, getBot, defaultChatIds, groupChatIds, psibotDir, scheduleRestart } = deps;

  const reposDir = join(psibotDir, "repos");
  const worktreesDir = join(psibotDir, "worktrees");
  const allAllowedChatIds = [...defaultChatIds, ...groupChatIds];

  return createSdkMcpServer({
    name: "agent-tools",
    version: "1.0.0",
    tools: [
      // --- Memory tools ---
      tool(
        "memory_read",
        "Read the agent's persistent memory file (knowledge/memory.md). Returns the full contents.",
        {},
        async () => {
          const content = memory.readMemory();
          return { content: [{ type: "text" as const, text: content }] };
        }
      ),

      tool(
        "memory_write_section",
        "Write content to a specific section of the memory file. Replaces the section content entirely.",
        {
          section: z
            .string()
            .describe(
              "Section name (e.g., 'Key Facts', 'Preferences', 'Context')"
            ),
          content: z.string().describe("Content to write to the section"),
        },
        async (args) => {
          memory.writeSection(args.section, args.content);
          return {
            content: [
              {
                type: "text" as const,
                text: `Updated section "${args.section}" in memory.`,
              },
            ],
          };
        }
      ),

      tool(
        "memory_append",
        "Append a line or paragraph to a section of the memory file.",
        {
          section: z.string().describe("Section name to append to"),
          content: z.string().describe("Content to append"),
        },
        async (args) => {
          memory.appendToSection(args.section, args.content);
          return {
            content: [
              {
                type: "text" as const,
                text: `Appended to section "${args.section}".`,
              },
            ],
          };
        }
      ),

      tool(
        "memory_search",
        "Search across all knowledge files for a query. Returns matching snippets with file paths.",
        {
          query: z.string().describe("Search query"),
        },
        async (args) => {
          const results = memory.search(args.query);
          if (results.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No results found." }],
            };
          }
          const text = results
            .map(
              (r) => `**${r.path}** - ${r.title}\n${r.snippet}`
            )
            .join("\n\n");
          return { content: [{ type: "text" as const, text }] };
        }
      ),

      tool(
        "knowledge_read",
        "Read a file from the knowledge folder.",
        {
          path: z
            .string()
            .describe("Relative path within knowledge/ folder"),
        },
        async (args) => {
          try {
            const content = memory.readKnowledgeFile(args.path);
            return { content: [{ type: "text" as const, text: content }] };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        }
      ),

      tool(
        "knowledge_write",
        "Write or create a file in the knowledge folder.",
        {
          path: z.string().describe("Relative path within knowledge/ folder"),
          content: z.string().describe("File content to write"),
        },
        async (args) => {
          try {
            memory.writeKnowledgeFile(args.path, args.content);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Wrote file: ${args.path}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error writing file: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        }
      ),

      tool(
        "knowledge_list",
        "List all markdown files in the knowledge folder.",
        {},
        async () => {
          const files = memory.listKnowledgeFiles();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  files.length > 0
                    ? files.join("\n")
                    : "No knowledge files found.",
              },
            ],
          };
        }
      ),

      // --- Job tools ---
      tool(
        "job_create",
        "Create a new scheduled job. Use type 'cron' with a schedule expression for recurring jobs, or type 'once' with run_at for one-off jobs.",
        {
          name: z.string().describe("Human-readable job name"),
          prompt: z.string().describe("The prompt/instruction the agent will execute when the job runs"),
          type: z.enum(["cron", "once"]).describe("'cron' for recurring, 'once' for one-off"),
          schedule: z.string().optional().describe("Cron expression (e.g. '0 9 * * *' for daily at 9am). Required for type 'cron'."),
          run_at: z.string().optional().describe("ISO 8601 datetime for one-off jobs (e.g. '2026-02-08T10:00:00'). Required for type 'once'."),
          max_budget_usd: z.number().optional().describe("Maximum cost in USD per run (default: 1.0)"),
          use_browser: z.boolean().optional().describe("Whether the job can use browser automation (default: false)"),
          model: z.string().optional().describe("Claude model to use for this job (e.g. 'claude-sonnet-4-5-20250929'). Defaults to DEFAULT_MODEL if not set."),
        },
        async (args) => {
          const job = createJob({
            name: args.name,
            prompt: args.prompt,
            type: args.type,
            schedule: args.schedule ?? null,
            run_at: args.run_at ?? null,
            max_budget_usd: args.max_budget_usd,
            use_browser: args.use_browser,
            model: args.model ?? null,
          });
          reloadScheduler();
          return {
            content: [{
              type: "text" as const,
              text: `Created job "${job.name}" (ID: ${job.id}, type: ${job.type}, status: ${job.status})`,
            }],
          };
        }
      ),

      tool(
        "job_list",
        "List all scheduled jobs with their status, schedule, and last run time.",
        {},
        async () => {
          const jobs = getAllJobs();
          if (jobs.length === 0) {
            return { content: [{ type: "text" as const, text: "No jobs configured." }] };
          }
          const lines = jobs.map((j) => {
            const sched = j.type === "cron" ? `cron: ${j.schedule}` : `once: ${j.run_at ?? "not set"}`;
            const pauseInfo: string[] = [];
            if (j.paused_until) pauseInfo.push(`paused until ${j.paused_until}`);
            if (j.skip_runs > 0) pauseInfo.push(`skipping ${j.skip_runs} runs`);
            const statusLabel = pauseInfo.length > 0 ? `${j.status}, ${pauseInfo.join(", ")}` : j.status;
            return `- **${j.name}** (ID: ${j.id}) [${statusLabel}] ${sched} | budget: $${j.max_budget_usd} | last run: ${j.last_run_at ?? "never"}`;
          });
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }
      ),

      tool(
        "job_get",
        "Get details of a specific job including its prompt and recent runs.",
        {
          job_id: z.number().describe("Job ID"),
        },
        async (args) => {
          const job = getJob(args.job_id);
          if (!job) {
            return { content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }], isError: true };
          }
          const runs = getJobRuns(job.id, 5);
          const runsText = runs.length > 0
            ? runs.map((r) => `  - ${r.status} at ${r.started_at} (${r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : "-"})`).join("\n")
            : "  No runs yet.";
          const pauseParts: string[] = [];
          if (job.paused_until) pauseParts.push(`Paused Until: ${job.paused_until}`);
          if (job.skip_runs > 0) pauseParts.push(`Skip Runs: ${job.skip_runs}`);
          const pauseSection = pauseParts.length > 0 ? `\n${pauseParts.join("\n")}` : "";
          const text = `**${job.name}** (ID: ${job.id})
Status: ${job.status}
Type: ${job.type}
Schedule: ${job.schedule ?? job.run_at ?? "none"}
Budget: $${job.max_budget_usd}
Model: ${job.model ?? "(default)"}
Browser: ${job.use_browser ? "yes" : "no"}${pauseSection}
Prompt: ${job.prompt}

Recent runs:
${runsText}`;
          return { content: [{ type: "text" as const, text }] };
        }
      ),

      tool(
        "job_update",
        "Update a job's settings. Only provided fields are changed.",
        {
          job_id: z.number().describe("Job ID to update"),
          name: z.string().optional().describe("New name"),
          prompt: z.string().optional().describe("New prompt"),
          schedule: z.string().optional().describe("New cron schedule"),
          run_at: z.string().optional().describe("New run_at datetime"),
          max_budget_usd: z.number().optional().describe("New budget limit"),
          use_browser: z.boolean().optional().describe("Enable/disable browser"),
          model: z.string().optional().describe("Claude model to use (e.g. 'claude-sonnet-4-5-20250929')"),
          status: z.enum(["enabled", "disabled"]).optional().describe("Enable or disable the job"),
        },
        async (args) => {
          const job = getJob(args.job_id);
          if (!job) {
            return { content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }], isError: true };
          }
          const { job_id, ...updates } = args;
          updateJob(job_id, updates);
          reloadScheduler();
          return { content: [{ type: "text" as const, text: `Updated job "${job.name}" (ID: ${job_id}).` }] };
        }
      ),

      tool(
        "job_delete",
        "Permanently delete a job.",
        {
          job_id: z.number().describe("Job ID to delete"),
        },
        async (args) => {
          const job = getJob(args.job_id);
          if (!job) {
            return { content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }], isError: true };
          }
          deleteJob(args.job_id);
          reloadScheduler();
          return { content: [{ type: "text" as const, text: `Deleted job "${job.name}" (ID: ${args.job_id}).` }] };
        }
      ),

      tool(
        "job_trigger",
        "Manually trigger a job to run immediately. Bypasses any pause conditions.",
        {
          job_id: z.number().describe("Job ID to trigger"),
        },
        async (args) => {
          const job = getJob(args.job_id);
          if (!job) {
            return { content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }], isError: true };
          }
          triggerJob(args.job_id);
          return { content: [{ type: "text" as const, text: `Triggered job "${job.name}" (ID: ${args.job_id}). It will run in the background.` }] };
        }
      ),

      tool(
        "job_pause",
        "Pause a job. Provide 'until' (ISO datetime) to pause until a date, or 'skip_runs' to skip N scheduled executions. Both can be set together.",
        {
          job_id: z.number().describe("Job ID to pause"),
          until: z.string().optional().describe("ISO 8601 datetime to pause until (e.g. '2026-02-15T09:00:00')"),
          skip_runs: z.number().optional().describe("Number of scheduled runs to skip"),
        },
        async (args) => {
          const job = getJob(args.job_id);
          if (!job) {
            return { content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }], isError: true };
          }
          if (!args.until && args.skip_runs === undefined) {
            return { content: [{ type: "text" as const, text: "Provide 'until' and/or 'skip_runs' to pause the job." }], isError: true };
          }
          const updates: Record<string, string | number | null> = {};
          if (args.until) updates.paused_until = args.until;
          if (args.skip_runs !== undefined) updates.skip_runs = args.skip_runs;
          updateJob(args.job_id, updates as Parameters<typeof updateJob>[1]);
          const parts: string[] = [];
          if (args.until) parts.push(`until ${args.until}`);
          if (args.skip_runs !== undefined) parts.push(`skipping ${args.skip_runs} runs`);
          return { content: [{ type: "text" as const, text: `Paused job "${job.name}" (ID: ${args.job_id}): ${parts.join(", ")}.` }] };
        }
      ),

      tool(
        "job_resume",
        "Clear all pause conditions on a job, resuming normal execution.",
        {
          job_id: z.number().describe("Job ID to resume"),
        },
        async (args) => {
          const job = getJob(args.job_id);
          if (!job) {
            return { content: [{ type: "text" as const, text: `Job ${args.job_id} not found.` }], isError: true };
          }
          updateJob(args.job_id, { paused_until: null, skip_runs: 0 });
          return { content: [{ type: "text" as const, text: `Resumed job "${job.name}" (ID: ${args.job_id}). All pause conditions cleared.` }] };
        }
      ),

      // --- Telegram tools ---
      tool(
        "telegram_send_message",
        "Send a text message via Telegram. Can send to the user's DM or to a group chat. Supports Markdown formatting and posting to group topics/threads.",
        {
          text: z.string().describe("Message text. Supports Markdown formatting (bold, italic, code blocks, links)."),
          chat_id: z.string().optional().describe("Telegram chat ID. Use a negative number for groups (e.g. '-5247377543'). Defaults to the primary user's DM."),
          topic_id: z.number().optional().describe("Message thread/topic ID for posting to a specific topic in a group with topics enabled."),
          parse_mode: z.enum(["MarkdownV2", "HTML", "plain"]).optional().describe("Parse mode for formatting. Defaults to MarkdownV2 (auto-converted from standard Markdown)."),
        },
        async (args) => {
          const bot = getBot();
          if (!bot) {
            return {
              content: [{ type: "text" as const, text: "Telegram bot not available." }],
              isError: true,
            };
          }

          const chatId = args.chat_id ? Number(args.chat_id) : defaultChatIds[0];
          if (!chatId) {
            return {
              content: [{ type: "text" as const, text: "No chat ID available." }],
              isError: true,
            };
          }

          if (!allAllowedChatIds.includes(chatId)) {
            return {
              content: [{ type: "text" as const, text: `Chat ID ${chatId} is not in the allowed list. Allowed: ${allAllowedChatIds.join(", ")}` }],
              isError: true,
            };
          }

          try {
            const { markdownToTelegramV2, splitMessage } = await import("../telegram/format.ts");
            const parseMode = args.parse_mode ?? "MarkdownV2";
            const formatted = parseMode === "MarkdownV2" ? markdownToTelegramV2(args.text) : args.text;
            const chunks = splitMessage(formatted);

            for (const chunk of chunks) {
              const options: Record<string, unknown> = {};
              if (parseMode !== "plain") options.parse_mode = parseMode;
              if (args.topic_id) options.message_thread_id = args.topic_id;
              await bot.api.sendMessage(chatId, chunk, options);
            }

            const topicInfo = args.topic_id ? ` (topic ${args.topic_id})` : "";
            log.info("Sent message via Telegram", { chatId, topicId: args.topic_id, chunks: chunks.length });
            return {
              content: [{ type: "text" as const, text: `Message sent to chat ${chatId}${topicInfo}. (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to send message: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "telegram_send_photo",
        "Send an image file via Telegram. Can send to user DM or group chat, optionally to a specific topic.",
        {
          image_path: z.string().describe("Absolute path to the image file"),
          caption: z.string().optional().describe("Optional caption for the image"),
          chat_id: z.string().optional().describe("Telegram chat ID. Use a negative number for groups. Defaults to the primary user."),
          topic_id: z.number().optional().describe("Message thread/topic ID for group topics."),
        },
        async (args) => {
          const bot = getBot();
          if (!bot) {
            return {
              content: [{ type: "text" as const, text: "Telegram bot not available." }],
              isError: true,
            };
          }

          if (!existsSync(args.image_path)) {
            return {
              content: [{ type: "text" as const, text: `Image file not found: ${args.image_path}` }],
              isError: true,
            };
          }

          const chatId = args.chat_id ? Number(args.chat_id) : defaultChatIds[0];
          if (!chatId) {
            return {
              content: [{ type: "text" as const, text: "No chat ID available." }],
              isError: true,
            };
          }

          try {
            const fileData = await Bun.file(args.image_path).arrayBuffer();
            const { InputFile } = await import("grammy");
            const options: Record<string, unknown> = {};
            if (args.caption) options.caption = args.caption;
            if (args.topic_id) options.message_thread_id = args.topic_id;
            await bot.api.sendPhoto(
              chatId,
              new InputFile(new Uint8Array(fileData), basename(args.image_path)),
              Object.keys(options).length > 0 ? options : undefined
            );
            log.info("Sent photo via Telegram", { chatId, path: args.image_path });
            return {
              content: [{ type: "text" as const, text: `Photo sent to chat ${chatId}.` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to send photo: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "telegram_send_voice",
        "Send an audio file as a voice message via Telegram. OGG files play inline as voice messages; MP3/WAV are sent as audio files. Can send to group topics.",
        {
          audio_path: z.string().describe("Absolute path to the audio file"),
          caption: z.string().optional().describe("Optional caption"),
          chat_id: z.string().optional().describe("Telegram chat ID. Use a negative number for groups. Defaults to the primary user."),
          topic_id: z.number().optional().describe("Message thread/topic ID for group topics."),
        },
        async (args) => {
          const bot = getBot();
          if (!bot) {
            return {
              content: [{ type: "text" as const, text: "Telegram bot not available." }],
              isError: true,
            };
          }

          if (!existsSync(args.audio_path)) {
            return {
              content: [{ type: "text" as const, text: `Audio file not found: ${args.audio_path}` }],
              isError: true,
            };
          }

          const chatId = args.chat_id ? Number(args.chat_id) : defaultChatIds[0];
          if (!chatId) {
            return {
              content: [{ type: "text" as const, text: "No chat ID available." }],
              isError: true,
            };
          }

          try {
            const fileData = await Bun.file(args.audio_path).arrayBuffer();
            const { InputFile } = await import("grammy");
            const inputFile = new InputFile(new Uint8Array(fileData), basename(args.audio_path));
            const isOgg = args.audio_path.endsWith(".ogg") || args.audio_path.endsWith(".oga");
            const options: Record<string, unknown> = {};
            if (args.caption) options.caption = args.caption;
            if (args.topic_id) options.message_thread_id = args.topic_id;

            if (isOgg) {
              await bot.api.sendVoice(chatId, inputFile, Object.keys(options).length > 0 ? options : undefined);
            } else {
              await bot.api.sendAudio(chatId, inputFile, Object.keys(options).length > 0 ? options : undefined);
            }

            log.info("Sent audio via Telegram", { chatId, path: args.audio_path, isOgg });
            return {
              content: [{ type: "text" as const, text: `Audio sent to chat ${chatId}.` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to send audio: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      // --- Worktree tools ---
      tool(
        "worktree_create",
        "Create a git worktree for isolated coding sessions. Clones the repo as a bare repo (if needed) and creates a worktree checkout.",
        {
          repo_url: z.string().describe("Git repository URL to clone"),
          branch: z.string().optional().describe("Branch to check out (default: 'main')"),
          name: z.string().optional().describe("Name for the worktree directory (default: derived from repo + branch)"),
        },
        async (args) => {
          try {
            mkdirSync(reposDir, { recursive: true });
            mkdirSync(worktreesDir, { recursive: true });

            // Extract repo name from URL
            const repoName = basename(args.repo_url).replace(/\.git$/, "");
            const barePath = join(reposDir, `${repoName}.git`);
            const branch = args.branch ?? "main";
            const wtName = args.name ?? `${repoName}-${branch}`;
            const wtPath = join(worktreesDir, wtName);

            if (existsSync(wtPath)) {
              return {
                content: [{ type: "text" as const, text: `Worktree already exists at: ${wtPath}` }],
              };
            }

            // Clone bare repo if not cached
            if (!existsSync(barePath)) {
              log.info("Cloning bare repo", { url: args.repo_url, barePath });
              const cloneProc = Bun.spawn(
                ["git", "clone", "--bare", args.repo_url, barePath],
                { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
              );
              const stderr = await new Response(cloneProc.stderr).text();
              const exitCode = await cloneProc.exited;
              if (exitCode !== 0) {
                return {
                  content: [{ type: "text" as const, text: `Failed to clone repo: ${stderr.slice(0, 500)}` }],
                  isError: true,
                };
              }
            }

            // Create worktree
            log.info("Creating worktree", { barePath, wtPath, branch });
            const wtProc = Bun.spawn(
              ["git", "-C", barePath, "worktree", "add", wtPath, branch],
              { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
            );
            const wtStderr = await new Response(wtProc.stderr).text();
            const wtExit = await wtProc.exited;
            if (wtExit !== 0) {
              return {
                content: [{ type: "text" as const, text: `Failed to create worktree: ${wtStderr.slice(0, 500)}` }],
                isError: true,
              };
            }

            log.info("Worktree created", { wtPath });
            return {
              content: [{ type: "text" as const, text: `Worktree created at: ${wtPath}\nBranch: ${branch}` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Worktree creation error: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "worktree_list",
        "List all active git worktrees under ~/.psibot/worktrees/ with their current branch and last commit.",
        {},
        async () => {
          try {
            if (!existsSync(worktreesDir)) {
              return {
                content: [{ type: "text" as const, text: "No worktrees directory found. Create a worktree first." }],
              };
            }

            const entries = readdirSync(worktreesDir, { withFileTypes: true })
              .filter((e) => e.isDirectory());

            if (entries.length === 0) {
              return {
                content: [{ type: "text" as const, text: "No worktrees found." }],
              };
            }

            const lines: string[] = [];
            for (const entry of entries) {
              const wtPath = join(worktreesDir, entry.name);

              const branchProc = Bun.spawn(
                ["git", "-C", wtPath, "branch", "--show-current"],
                { stdout: "pipe", stderr: "pipe" }
              );
              const branch = (await new Response(branchProc.stdout).text()).trim();

              const logProc = Bun.spawn(
                ["git", "-C", wtPath, "log", "--oneline", "-1"],
                { stdout: "pipe", stderr: "pipe" }
              );
              const lastCommit = (await new Response(logProc.stdout).text()).trim();

              lines.push(`- **${entry.name}** (${wtPath})\n  Branch: ${branch || "detached"}\n  Last: ${lastCommit || "no commits"}`);
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error listing worktrees: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "worktree_remove",
        "Remove a git worktree by name.",
        {
          name: z.string().describe("Name of the worktree directory to remove"),
        },
        async (args) => {
          const wtPath = join(worktreesDir, args.name);
          if (!existsSync(wtPath)) {
            return {
              content: [{ type: "text" as const, text: `Worktree not found: ${args.name}` }],
              isError: true,
            };
          }

          try {
            // Find the bare repo that owns this worktree
            const gitDirProc = Bun.spawn(
              ["git", "-C", wtPath, "rev-parse", "--git-common-dir"],
              { stdout: "pipe", stderr: "pipe" }
            );
            const gitDir = (await new Response(gitDirProc.stdout).text()).trim();

            const proc = Bun.spawn(
              ["git", "-C", gitDir, "worktree", "remove", wtPath],
              { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
            );
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
              return {
                content: [{ type: "text" as const, text: `Failed to remove worktree: ${stderr.slice(0, 500)}` }],
                isError: true,
              };
            }

            log.info("Worktree removed", { name: args.name });
            return {
              content: [{ type: "text" as const, text: `Worktree "${args.name}" removed.` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Error removing worktree: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      // --- Portfolio tools ---
      tool(
        "portfolio_status",
        "Get the current paper trading portfolio status including cash balance, open positions, P/L, and allocation.",
        {},
        async () => {
          try {
            const { config, positions, totalValue, investedValue, totalPnl, totalPnlPct } = getPortfolioSummary();
            const lines: string[] = [
              `Paper Portfolio Status`,
              `=====================`,
              `Starting Cash: $${config.starting_cash.toLocaleString()}`,
              `Current Cash:  $${config.current_cash.toFixed(2)}`,
              `Invested:      $${investedValue.toFixed(2)}`,
              `Total Value:   $${totalValue.toFixed(2)}`,
              `Total P/L:     $${totalPnl.toFixed(2)} (${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%)`,
              `Open Positions: ${positions.length} / ${config.max_positions}`,
              ``,
              `Config: max_position=${config.max_position_pct}%, take_profit=${config.default_take_profit_pct}%, rsi_exit=${config.rsi_exit_threshold}`,
              ``,
            ];

            if (positions.length > 0) {
              lines.push(`Ticker | Sector | Entry | Current | P/L% | Stop | Target | Days`);
              lines.push(`-------|--------|-------|---------|------|------|--------|-----`);
              for (const p of positions) {
                const daysHeld = Math.floor(
                  (Date.now() - new Date(p.entry_date).getTime()) / (1000 * 60 * 60 * 24)
                );
                const pnl = p.current_pnl_pct ?? 0;
                lines.push(
                  `${p.ticker} | ${p.sector} | $${p.entry_price.toFixed(2)} | $${(p.current_price ?? p.entry_price).toFixed(2)} | ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}% | $${p.stop_loss_price.toFixed(2)} | $${p.take_profit_price.toFixed(2)} | ${daysHeld}`
                );
              }
            } else {
              lines.push("No open positions.");
            }

            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Portfolio status error: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "portfolio_open_position",
        "Open a new paper trading position. Position is auto-sized based on portfolio config (5% for STRONG_BUY, 3% for BUY). Stop loss is set dynamically using ATR (entry - 2*ATR). Take profit uses the configured default percentage.",
        {
          ticker: z.string().describe("Stock ticker symbol"),
          sector: z.string().describe("Sector classification"),
          price: z.number().describe("Entry price"),
          atr: z.number().describe("Current ATR(14) value for dynamic stop loss"),
          signal: z.string().describe("The signal that triggered entry (e.g. 'STRONG_BUY', 'BUY')"),
          reasons: z.string().describe("Comma-separated reasons for entry"),
          screener_date: z.string().describe("Date of the stock screen (YYYY-MM-DD)"),
        },
        async (args) => {
          try {
            // Check for existing position
            const existing = getPositionByTicker(args.ticker);
            if (existing) {
              return {
                content: [{ type: "text" as const, text: `Already holding ${args.ticker} (position #${existing.id}, entered ${existing.entry_date}).` }],
                isError: true,
              };
            }

            const config = getPortfolioConfig();
            const positions = getOpenPositions();

            // Check max positions
            if (positions.length >= config.max_positions) {
              return {
                content: [{ type: "text" as const, text: `Max positions reached (${config.max_positions}). Close a position first.` }],
                isError: true,
              };
            }

            // Position sizing: 5% for STRONG_BUY, 3% for BUY
            const totalValue = config.current_cash + positions.reduce(
              (sum, p) => sum + (p.current_price ?? p.entry_price) * p.shares, 0
            );
            const sizePct = args.signal.includes("STRONG") ? config.max_position_pct : config.max_position_pct * 0.6;
            const positionValue = totalValue * (sizePct / 100);

            // Enforce 25% cash reserve
            const maxSpend = config.current_cash - (totalValue * 0.25);
            if (maxSpend <= 0) {
              return {
                content: [{ type: "text" as const, text: `Insufficient cash after 25% reserve. Cash: $${config.current_cash.toFixed(2)}, reserve required: $${(totalValue * 0.25).toFixed(2)}` }],
                isError: true,
              };
            }

            const actualSpend = Math.min(positionValue, maxSpend);
            const shares = Math.floor(actualSpend / args.price);
            if (shares <= 0) {
              return {
                content: [{ type: "text" as const, text: `Position too small. Available: $${actualSpend.toFixed(2)}, price: $${args.price}` }],
                isError: true,
              };
            }

            // Dynamic stop loss: entry - 2*ATR
            const stopLossPrice = Math.round((args.price - 2 * args.atr) * 100) / 100;
            // Take profit: entry * (1 + take_profit_pct/100)
            const takeProfitPrice = Math.round(args.price * (1 + config.default_take_profit_pct / 100) * 100) / 100;

            const today = new Date().toISOString().split("T")[0];
            const position = openPosition({
              ticker: args.ticker,
              sector: args.sector,
              shares,
              entry_price: args.price,
              entry_date: today,
              entry_signal: args.signal,
              entry_reasons: args.reasons,
              entry_atr: args.atr,
              stop_loss_price: stopLossPrice,
              take_profit_price: takeProfitPrice,
              screener_date: args.screener_date,
            });

            const cost = shares * args.price;
            const stopPct = ((stopLossPrice - args.price) / args.price * 100).toFixed(1);
            const tpPct = config.default_take_profit_pct.toFixed(1);

            return {
              content: [{
                type: "text" as const,
                text: `Opened: ${shares} shares of ${args.ticker} @ $${args.price.toFixed(2)} ($${cost.toFixed(2)})\nSignal: ${args.signal} | ${args.reasons}\nStop: $${stopLossPrice.toFixed(2)} (${stopPct}%, 2x ATR=$${args.atr.toFixed(2)}) | Target: $${takeProfitPrice.toFixed(2)} (+${tpPct}%)\nPosition ID: ${position.id}`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to open position: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "portfolio_close_position",
        "Close a paper trading position with exit signal and reasons.",
        {
          ticker: z.string().describe("Stock ticker to close"),
          price: z.number().describe("Exit price"),
          signal: z.string().describe("Exit signal (STOP_LOSS, TAKE_PROFIT, RSI_OVERBOUGHT, TREND_REVERSAL, MACD_BEAR_CROSS, BB_UPPER_TOUCH, VOLUME_SPIKE_DECLINE, NEWS_EXIT, MANUAL)"),
          reasons: z.string().describe("Human-readable explanation for the exit"),
        },
        async (args) => {
          try {
            const existing = getPositionByTicker(args.ticker);
            if (!existing) {
              return {
                content: [{ type: "text" as const, text: `No open position for ${args.ticker}.` }],
                isError: true,
              };
            }

            const today = new Date().toISOString().split("T")[0];
            const position = closePosition({
              id: existing.id,
              exit_price: args.price,
              exit_date: today,
              exit_signal: args.signal,
              exit_reasons: args.reasons,
            });

            const pnl = position.realized_pnl ?? 0;
            const pnlPct = ((args.price - existing.entry_price) / existing.entry_price * 100);
            const daysHeld = Math.floor(
              (Date.now() - new Date(existing.entry_date).getTime()) / (1000 * 60 * 60 * 24)
            );

            return {
              content: [{
                type: "text" as const,
                text: `Closed: ${existing.shares} shares of ${args.ticker} @ $${args.price.toFixed(2)}\nEntry: $${existing.entry_price.toFixed(2)} | P/L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%) | Days held: ${daysHeld}\nSignal: ${args.signal} | ${args.reasons}`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to close position: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "portfolio_update_prices",
        "Update current prices for all open positions. Pass JSON of ticker:price pairs.",
        {
          prices: z.string().describe("JSON object of ticker:price pairs, e.g. '{\"AAPL\":252.82,\"QCOM\":129.39}'"),
        },
        async (args) => {
          try {
            const priceMap: Record<string, number> = JSON.parse(args.prices);
            const positions = getOpenPositions();
            let updated = 0;

            for (const pos of positions) {
              const price = priceMap[pos.ticker];
              if (price !== undefined && typeof price === "number") {
                updatePositionPrice(pos.id, price);
                updated++;
              }
            }

            return {
              content: [{ type: "text" as const, text: `Updated prices for ${updated} of ${positions.length} open positions.` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to update prices: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "portfolio_save_snapshot",
        "Save a daily portfolio snapshot for historical tracking.",
        {},
        async () => {
          try {
            const { config, positions, totalValue, investedValue, totalPnl, totalPnlPct } = getPortfolioSummary();
            const today = new Date().toISOString().split("T")[0];

            // Get yesterday's snapshot for day P/L calculation
            const recent = getRecentSnapshots(1);
            const prevValue = recent.length > 0 ? recent[0].total_value : config.starting_cash;
            const dayPnl = totalValue - prevValue;
            const dayPnlPct = prevValue > 0 ? (dayPnl / prevValue) * 100 : 0;

            const positionsJson = JSON.stringify(
              positions.map((p) => ({
                ticker: p.ticker,
                shares: p.shares,
                entry_price: p.entry_price,
                current_price: p.current_price ?? p.entry_price,
                pnl_pct: p.current_pnl_pct ?? 0,
                pnl_usd: ((p.current_price ?? p.entry_price) - p.entry_price) * p.shares,
                days_held: Math.floor(
                  (Date.now() - new Date(p.entry_date).getTime()) / (1000 * 60 * 60 * 24)
                ),
              }))
            );

            insertDailySnapshot({
              snapshot_date: today,
              total_value: totalValue,
              cash: config.current_cash,
              invested: investedValue,
              open_positions: positions.length,
              day_pnl: dayPnl,
              day_pnl_pct: dayPnlPct,
              total_pnl: totalPnl,
              total_pnl_pct: totalPnlPct,
              positions_json: positionsJson,
            });

            return {
              content: [{
                type: "text" as const,
                text: `Snapshot saved for ${today}. Value: $${totalValue.toFixed(2)}, Day P/L: ${dayPnl >= 0 ? "+" : ""}$${dayPnl.toFixed(2)} (${dayPnlPct >= 0 ? "+" : ""}${dayPnlPct.toFixed(2)}%)`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to save snapshot: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "portfolio_history",
        "Get portfolio trade history: recent closed positions and daily performance snapshots.",
        {
          limit: z.number().optional().describe("Number of records (default 20)"),
        },
        async (args) => {
          try {
            const limit = args.limit ?? 20;
            const closed = getClosedPositions(limit);
            const snapshots = getRecentSnapshots(limit);

            const lines: string[] = ["Recent Closed Positions:", ""];

            if (closed.length > 0) {
              lines.push("Ticker | Entry | Exit | P/L% | P/L$ | Days | Exit Signal");
              lines.push("-------|-------|------|------|------|------|------------");
              for (const p of closed) {
                const daysHeld = p.exit_date && p.entry_date
                  ? Math.floor((new Date(p.exit_date).getTime() - new Date(p.entry_date).getTime()) / (1000 * 60 * 60 * 24))
                  : 0;
                const pnlPct = p.current_pnl_pct ?? 0;
                const pnlUsd = p.realized_pnl ?? 0;
                lines.push(
                  `${p.ticker} | $${p.entry_price.toFixed(2)} | $${(p.exit_price ?? 0).toFixed(2)} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} | ${daysHeld} | ${p.exit_signal ?? "-"}`
                );
              }
            } else {
              lines.push("No closed positions yet.");
            }

            lines.push("", "Recent Daily Snapshots:", "");
            if (snapshots.length > 0) {
              lines.push("Date | Value | Day P/L | Total P/L | Positions");
              lines.push("-----|-------|---------|-----------|----------");
              for (const s of snapshots) {
                lines.push(
                  `${s.snapshot_date} | $${s.total_value.toFixed(2)} | ${s.day_pnl >= 0 ? "+" : ""}$${s.day_pnl.toFixed(2)} (${s.day_pnl_pct >= 0 ? "+" : ""}${s.day_pnl_pct.toFixed(2)}%) | ${s.total_pnl >= 0 ? "+" : ""}$${s.total_pnl.toFixed(2)} (${s.total_pnl_pct >= 0 ? "+" : ""}${s.total_pnl_pct.toFixed(2)}%) | ${s.open_positions}`
                );
              }
            } else {
              lines.push("No snapshots yet.");
            }

            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Portfolio history error: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "portfolio_configure",
        "Update portfolio configuration: take profit, position size limits, RSI exit threshold, etc.",
        {
          default_take_profit_pct: z.number().optional().describe("Default take profit percentage (e.g. 10 for +10%)"),
          max_position_pct: z.number().optional().describe("Max position size as % of portfolio (e.g. 5 for 5%)"),
          max_positions: z.number().optional().describe("Maximum number of concurrent positions"),
          rsi_exit_threshold: z.number().optional().describe("RSI level to trigger overbought exit (e.g. 70)"),
        },
        async (args) => {
          try {
            updatePortfolioConfig(args);
            const config = getPortfolioConfig();
            return {
              content: [{
                type: "text" as const,
                text: `Portfolio config updated. Current: max_position=${config.max_position_pct}%, max_positions=${config.max_positions}, take_profit=${config.default_take_profit_pct}%, rsi_exit=${config.rsi_exit_threshold}`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Config update error: ${message}` }], isError: true };
          }
        }
      ),

      // --- Inbox Capture tools ---
      tool(
        "inbox_save",
        "Save a URL to the inbox capture queue for later triage. Use when the user shares a link worth keeping or when you encounter interesting content during research.",
        {
          url: z.string().describe("The URL to save"),
          title: z.string().optional().describe("Title of the content"),
          description: z.string().optional().describe("Brief description or why it's interesting"),
          source: z.enum(["chrome-extension", "reddit", "github", "telegram", "manual"]).optional().describe("Where the link came from"),
          platform: z.string().optional().describe("Platform/domain (e.g. github, reddit, x.com)"),
        },
        async (args) => {
          const item = insertPendingItem({
            url: args.url,
            title: args.title,
            description: args.description,
            source: args.source ?? "manual",
            platform: args.platform ?? new URL(args.url).hostname.replace("www.", ""),
            captured_at: new Date().toISOString(),
          });
          if (!item) {
            return { content: [{ type: "text" as const, text: "Item already exists in inbox." }] };
          }
          return { content: [{ type: "text" as const, text: `Saved to inbox: ${item.title ?? item.url} (ID: ${item.id})` }] };
        }
      ),

      tool(
        "inbox_list",
        "List items in the capture inbox. Shows pending items by default. Use to review what needs triage.",
        {
          status: z.enum(["pending", "triaged", "archived", "deleted"]).optional().describe("Filter by status (default: pending)"),
          limit: z.number().optional().describe("Max items to return (default: 20)"),
        },
        async (args) => {
          const items = getPendingItems(args.status ?? "pending", args.limit ?? 20);
          const counts = {
            pending: getPendingItemCount("pending"),
            triaged: getPendingItemCount("triaged"),
            total: getPendingItemCount(),
          };
          const summary = items.map((i) =>
            `[${i.id}] ${i.title ?? i.url}\n  Source: ${i.source} | Platform: ${i.platform ?? "unknown"} | Priority: ${i.priority ?? "unset"}`
          ).join("\n\n");
          return {
            content: [{
              type: "text" as const,
              text: `Inbox: ${counts.pending} pending, ${counts.triaged} triaged, ${counts.total} total\n\n${summary || "(empty)"}`,
            }],
          };
        }
      ),

      tool(
        "inbox_triage",
        "Update an inbox item after triage — set priority, category, status, and summary.",
        {
          id: z.number().describe("Item ID"),
          priority: z.number().min(1).max(5).optional().describe("Priority 1 (highest) to 5 (lowest)"),
          category: z.string().optional().describe("Category (e.g. research, reference, actionable, skip)"),
          status: z.enum(["pending", "triaged", "archived", "deleted"]).optional().describe("New status"),
          triage_summary: z.string().optional().describe("Brief summary of the content"),
          noteplan_path: z.string().optional().describe("NotePlan path if a note was created"),
        },
        async (args) => {
          const { id, ...updates } = args;
          updatePendingItem(id, updates);
          return { content: [{ type: "text" as const, text: `Item ${id} updated.` }] };
        }
      ),

      tool(
        "inbox_poll_reddit",
        "Poll Reddit saved posts and add new items to the inbox. Uses the configured Reddit feed token.",
        {},
        async () => {
          const captured = await pollRedditSaved();
          return { content: [{ type: "text" as const, text: `Reddit poll complete: ${captured} new items captured.` }] };
        }
      ),

      tool(
        "inbox_poll_github",
        "Poll GitHub starred repos and add new items to the inbox. Uses the configured GitHub token.",
        {},
        async () => {
          const captured = await pollGithubStars();
          return { content: [{ type: "text" as const, text: `GitHub poll complete: ${captured} new items captured.` }] };
        }
      ),

      tool(
        "inbox_auto_triage",
        "Automatically triage all pending inbox items using the GLM backend. Categorizes, scores priority, generates summaries, and routes to NotePlan. Much faster than manual triage for large batches.",
        {
          limit: z.number().optional().describe("Max items to triage (default: 50)"),
        },
        async (args) => {
          const count = await triageAllPending(args.limit);
          return { content: [{ type: "text" as const, text: `Auto-triage complete: ${count} items processed.` }] };
        }
      ),

      // --- Reminder tools ---
      tool(
        "create_reminder",
        "Create a reminder that will be sent to the user via Telegram with action buttons (PAID/SKIP/SNOOZE/MORE). Use this for bills, follow-ups, and items needing user acknowledgment.",
        {
          type: z.enum(["bill", "action", "research", "follow_up"]).describe("Reminder type"),
          title: z.string().describe("Short title shown on the button notification"),
          description: z.string().optional().describe("Detailed description shown when user taps MORE"),
          priority: z.number().min(1).max(5).optional().describe("Priority 1-5, default 3"),
          max_reminds: z.number().optional().describe("Max reminder attempts before auto-dismiss, default 5"),
        },
        async (args) => {
          try {
            const reminder = insertReminder(args);
            const bot = getBot();
            if (bot) {
              for (const chatId of defaultChatIds) {
                const keyboard = args.type === "research"
                  ? approvalKeyboard(reminder.id)
                  : briefingActionKeyboard(reminder.id);
                const messageText = `${reminder.type.toUpperCase()}: ${reminder.title}${reminder.description ? "\n" + reminder.description : ""}`;
                await bot.api.sendMessage(chatId, messageText, {
                  reply_markup: keyboard,
                });
              }
            }
            return {
              content: [{
                type: "text" as const,
                text: `Reminder created (ID: ${reminder.id}). Sent to Telegram with action buttons.`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to create reminder: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      // --- Research tools ---
      tool(
        "research_item",
        "Run preliminary research on a captured item using web search. Returns a summary that can be presented to the user for approval before saving to NotePlan.",
        {
          item_id: z.number().describe("ID of the pending_item to research"),
          depth: z.enum(["preliminary", "deep"]).optional().describe("Research depth. 'preliminary' uses GLM (free), 'deep' uses Claude. Default: preliminary"),
        },
        async (args) => {
          try {
            const item = getPendingItemById(args.item_id);
            if (!item) {
              return {
                content: [{ type: "text" as const, text: `Item ${args.item_id} not found.` }],
                isError: true,
              };
            }

            const depth = args.depth ?? "preliminary";
            log.info("Running research", { itemId: item.id, depth, url: item.url });

            const research = depth === "deep"
              ? await deepResearch(item)
              : await preliminaryResearch(item);

            const findings = research.keyFindings.map((f) => `  - ${f}`).join("\n");
            const actions = research.suggestedActions.map((a) => `  - ${a}`).join("\n");
            const sources = research.sources.map((s) => `  - ${s}`).join("\n");

            const text = `Research: ${research.title}
Item ID: ${item.id}
Depth: ${depth}

Summary:
${research.summary}

Key Findings:
${findings}

Relevance:
${research.relevance}

Suggested Actions:
${actions}

Sources:
${sources}`;

            return { content: [{ type: "text" as const, text }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error("Research failed", { itemId: args.item_id, error: message });
            return {
              content: [{ type: "text" as const, text: `Research failed: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "research_approve",
        "Save approved research findings as a NotePlan note. Call this after presenting research to the user and getting approval.",
        {
          item_id: z.number().describe("ID of the pending_item"),
          title: z.string().describe("Research note title"),
          content: z.string().describe("Full markdown content for the NotePlan note"),
        },
        async (args) => {
          try {
            const item = getPendingItemById(args.item_id);
            if (!item) {
              return {
                content: [{ type: "text" as const, text: `Item ${args.item_id} not found.` }],
                isError: true,
              };
            }

            const research = {
              title: args.title,
              summary: "",
              keyFindings: [],
              relevance: "",
              suggestedActions: [],
              sources: [item.url],
              notePlanContent: args.content,
            };

            const notePath = createResearchNote(item, research);
            if (!notePath) {
              return {
                content: [{ type: "text" as const, text: "Failed to create NotePlan note." }],
                isError: true,
              };
            }

            // Update item status to archived since research is complete
            updatePendingItem(item.id, {
              status: "archived",
              noteplan_path: notePath,
            });

            return {
              content: [{
                type: "text" as const,
                text: `Research note saved: ${notePath}\nItem ${item.id} archived.`,
              }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Failed to save research note: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      // --- Task management (NotePlan calendar notes) ---
      tool(
        "task_add",
        "Add a task to a NotePlan calendar note. Read knowledge/TASKS.md for emoji and format standards. Tasks go on the due date's calendar note (YYYYMMDD.md).",
        {
          title: z.string().describe("Task title (short, actionable)"),
          emoji: z.string().describe("Category emoji prefix (e.g. 💰, 📋, 🔬, ⚠️, 🏠, 💻, 📧)"),
          source: z.string().describe("Where this task came from (gmail, briefing, triage, user, calendar, heartbeat)"),
          date: z.string().optional().describe("Due date YYYYMMDD. Defaults to today."),
          defer: z.string().optional().describe("Defer date YYYY-MM-DD if task should be scheduled later"),
        },
        async (args) => {
          const dateStr = args.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const calPath = join(
            process.env.HOME ?? "/tmp",
            "Documents/NotePlan-Notes/Calendar",
            `${dateStr}.md`
          );

          const deferTag = args.defer ? ` >${args.defer}` : "";
          const line = `* [ ] ${args.emoji} ${args.title} [source::${args.source}]${deferTag}`;

          try {
            const { existsSync: exists, readFileSync: readF, writeFileSync: writeF, appendFileSync: appendF } = await import("node:fs");
            if (exists(calPath)) {
              const content = readF(calPath, "utf-8");
              // Check for duplicates (same title, ignoring emoji)
              if (content.includes(args.title)) {
                return { content: [{ type: "text" as const, text: `Task already exists on ${dateStr}: ${args.title}` }] };
              }
              appendF(calPath, `\n${line}`);
            } else {
              writeF(calPath, `${line}\n`);
            }
            return { content: [{ type: "text" as const, text: `Task added to ${dateStr}: ${line}` }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to add task: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "task_complete",
        "Mark a task as completed on a NotePlan calendar note.",
        {
          title: z.string().describe("Task title (or substring) to match"),
          date: z.string().optional().describe("Calendar note date YYYYMMDD. Defaults to today."),
        },
        async (args) => {
          const dateStr = args.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const calPath = join(
            process.env.HOME ?? "/tmp",
            "Documents/NotePlan-Notes/Calendar",
            `${dateStr}.md`
          );

          try {
            const { existsSync: exists, readFileSync: readF, writeFileSync: writeF } = await import("node:fs");
            if (!exists(calPath)) {
              return { content: [{ type: "text" as const, text: `No calendar note for ${dateStr}` }], isError: true };
            }
            const content = readF(calPath, "utf-8");
            const lines = content.split("\n");
            let found = false;
            const today = new Date().toISOString().slice(0, 10);
            const updated = lines.map((line) => {
              if (!found && line.includes("* [ ]") && line.includes(args.title)) {
                found = true;
                return line.replace("* [ ]", "* [x]") + ` @done(${today})`;
              }
              return line;
            });
            if (!found) {
              return { content: [{ type: "text" as const, text: `Task not found on ${dateStr}: ${args.title}` }], isError: true };
            }
            writeF(calPath, updated.join("\n"));
            return { content: [{ type: "text" as const, text: `Task completed on ${dateStr}: ${args.title}` }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to complete task: ${message}` }], isError: true };
          }
        }
      ),

      tool(
        "task_list",
        "List tasks from a NotePlan calendar note.",
        {
          date: z.string().optional().describe("Calendar note date YYYYMMDD. Defaults to today."),
          include_done: z.boolean().optional().describe("Include completed tasks. Default: false."),
        },
        async (args) => {
          const dateStr = args.date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
          const calPath = join(
            process.env.HOME ?? "/tmp",
            "Documents/NotePlan-Notes/Calendar",
            `${dateStr}.md`
          );

          try {
            const { existsSync: exists, readFileSync: readF } = await import("node:fs");
            if (!exists(calPath)) {
              return { content: [{ type: "text" as const, text: `No calendar note for ${dateStr}` }] };
            }
            const content = readF(calPath, "utf-8");
            const tasks = content.split("\n").filter((line) => {
              if (!line.includes("* [")) return false;
              if (!args.include_done && line.includes("* [x]")) return false;
              return true;
            });
            if (tasks.length === 0) {
              return { content: [{ type: "text" as const, text: `No tasks on ${dateStr}` }] };
            }
            return { content: [{ type: "text" as const, text: `Tasks for ${dateStr}:\n${tasks.join("\n")}` }] };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: `Failed to list tasks: ${message}` }], isError: true };
          }
        }
      ),

      // --- Daemon management ---
      tool(
        "restart_daemon",
        "Schedule a daemon restart. The restart happens AFTER the current response is fully sent to the user. Use this after making code changes to the psibot codebase that need a process restart to take effect. Do NOT use Bash to run launchctl or psibot restart commands directly.",
        {
          reason: z.string().optional().describe("Reason for restart (logged for debugging)"),
        },
        async (args) => {
          scheduleRestart();
          log.info("Daemon restart scheduled", { reason: args.reason ?? "not specified" });
          return {
            content: [{
              type: "text" as const,
              text: "Restart scheduled. The daemon will restart after this response is sent. Your current conversation context will be lost — the user can resume the session with /resume.",
            }],
          };
        }
      ),
    ],
  });
}
