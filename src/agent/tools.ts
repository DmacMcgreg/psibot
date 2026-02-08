import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MemorySystem } from "../memory/index.ts";
import { runBrowserTask } from "../browser/index.ts";
import {
  createJob,
  getAllJobs,
  getJob,
  updateJob,
  deleteJob,
  getJobRuns,
} from "../db/queries.ts";

interface ToolDeps {
  memory: MemorySystem;
  reloadScheduler: () => void;
  triggerJob: (jobId: number) => void;
}

export function createAgentTools(deps: ToolDeps) {
  const { memory, reloadScheduler, triggerJob } = deps;
  return createSdkMcpServer({
    name: "agent-tools",
    version: "1.0.0",
    tools: [
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

      tool(
        "browser_task",
        "Execute a browser automation task using agent-browser. Can navigate to URLs, interact with pages, and extract information.",
        {
          instruction: z
            .string()
            .describe("Natural language instruction for the browser"),
          url: z
            .string()
            .optional()
            .describe("Starting URL to navigate to"),
        },
        async (args) => {
          const result = await runBrowserTask(
            args.instruction,
            args.url
          );
          if (!result.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Browser task failed: ${result.error ?? "Unknown error"}\n\nOutput: ${result.output}`,
                },
              ],
              isError: true,
            };
          }
          return {
            content: [{ type: "text" as const, text: result.output }],
          };
        }
      ),

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
            return `- **${j.name}** (ID: ${j.id}) [${j.status}] ${sched} | budget: $${j.max_budget_usd} | last run: ${j.last_run_at ?? "never"}`;
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
          const text = `**${job.name}** (ID: ${job.id})
Status: ${job.status}
Type: ${job.type}
Schedule: ${job.schedule ?? job.run_at ?? "none"}
Budget: $${job.max_budget_usd}
Browser: ${job.use_browser ? "yes" : "no"}
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
        "Manually trigger a job to run immediately.",
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
    ],
  });
}
