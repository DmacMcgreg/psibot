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
} from "../db/queries.ts";
import { createLogger } from "../shared/logger.ts";
import type { Bot, InputFile as GrammyInputFile } from "grammy";

const log = createLogger("tools");

export interface ToolDeps {
  memory: MemorySystem;
  reloadScheduler: () => void;
  triggerJob: (jobId: number) => void;
  getBot: () => Bot | null;
  defaultChatIds: number[];
  psibotDir: string;
}

export function createAgentTools(deps: ToolDeps) {
  const { memory, reloadScheduler, triggerJob, getBot, defaultChatIds, psibotDir } = deps;

  const reposDir = join(psibotDir, "repos");
  const worktreesDir = join(psibotDir, "worktrees");

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

      // --- Telegram media tools ---
      tool(
        "telegram_send_photo",
        "Send an image file to the user via Telegram.",
        {
          image_path: z.string().describe("Absolute path to the image file"),
          caption: z.string().optional().describe("Optional caption for the image"),
          chat_id: z.string().optional().describe("Telegram chat ID. Defaults to the primary user."),
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
            await bot.api.sendPhoto(
              chatId,
              new InputFile(new Uint8Array(fileData), basename(args.image_path)),
              args.caption ? { caption: args.caption } : undefined
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
        "Send an audio file as a voice message via Telegram. OGG files play inline as voice messages; MP3/WAV are sent as audio files.",
        {
          audio_path: z.string().describe("Absolute path to the audio file"),
          caption: z.string().optional().describe("Optional caption"),
          chat_id: z.string().optional().describe("Telegram chat ID. Defaults to the primary user."),
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

            if (isOgg) {
              await bot.api.sendVoice(chatId, inputFile, args.caption ? { caption: args.caption } : undefined);
            } else {
              await bot.api.sendAudio(chatId, inputFile, args.caption ? { caption: args.caption } : undefined);
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
    ],
  });
}
