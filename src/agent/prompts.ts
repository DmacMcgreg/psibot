import { MemorySystem } from "../memory/index.ts";
import type { ChatContext } from "../shared/types.ts";
import { listAgents } from "../db/queries.ts";
import { listSkills } from "../skills/index.ts";
import { markExposed } from "../skills/usage.ts";
import { scoreAllSkills } from "../curator/transitions.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("agent.prompts");

export function buildSystemPrompt(memory: MemorySystem, chatContext?: ChatContext): string {
  const memoryContent = memory.readMemory();
  const identity = memory.readKnowledgeFileOptional("IDENTITY.md") ?? "";
  const userContext = memory.readKnowledgeFileOptional("USER.md") ?? "";
  const tools = memory.readKnowledgeFileOptional("TOOLS.md") ?? "";
  const tradingPlaybook = memory.readKnowledgeFileOptional("trading/PLAYBOOK.md") ?? "";
  const tradingRegime = memory.readKnowledgeFileOptional("trading/REGIME.md") ?? "";

  const now = new Date();
  const localTime = now.toLocaleString("en-US", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const utcOffset = -now.getTimezoneOffset() / 60;
  const offsetStr = utcOffset >= 0 ? `+${utcOffset}` : String(utcOffset);

  return `${identity}

## Current Time

- Local time: ${localTime}
- Timezone: ${timezone} (UTC${offsetStr})
- UTC time: ${now.toISOString()}

**Important**: When creating jobs with run_at times, always use ISO 8601 format in UTC. Convert the user's local time to UTC before setting run_at. For cron schedules, note that cron expressions run in the server's local timezone (${timezone}).

${userContext ? `## User Context\n\n${userContext}\n` : ""}
${tools ? `## Infrastructure\n\n${tools}\n` : ""}
## Your Memory

The following is your current persistent memory. Use the memory tools to update it as you learn new information about the user or their preferences.

<memory>
${memoryContent}
</memory>

${buildSubagentListing()}

${buildSkillListing()}

After generating media (images, audio), use telegram_send_photo or telegram_send_voice to deliver the results to the user.

## Telegram Group Posting

You can post messages, photos, and audio to Telegram groups using the telegram_send_message, telegram_send_photo, and telegram_send_voice tools with a group chat_id. For groups with topics/threads enabled, use the topic_id parameter to post to a specific topic. To discover available topic IDs, you can post to the General topic first (no topic_id needed) or the user will provide specific topic IDs.

${tradingPlaybook || tradingRegime ? `## Trading Context\n\nYou have access to a trading bot backend (localhost:8000) via the trading-bot MCP server. Use trading tools for market analysis, backtesting, ML predictions, portfolio management, and more.\n\n${tradingPlaybook ? `### Current Playbook\n\n${tradingPlaybook}\n` : ""}${tradingRegime ? `### Current Regime\n\n${tradingRegime}\n` : ""}` : ""}
${chatContext ? buildChatContextSection(chatContext, memory) : ""}
## Knowledge Recall — Library-First (hard rule)

For any substantive topic question — explicit recall ("what did I save about X", "remember when", "do I have anything on Y") **and also** open-ended questions about a topic (a ticker, person, company, event, technology, concept) — **call atlas_search FIRST, before any WebSearch or WebFetch.** The user built this library specifically so it would be used; going straight to the web on a topic they've been capturing is a regression.

Rule of thumb: if the question could plausibly be answered or enriched by something the user has already saved — captured links, YouTube summaries, trading signals, research notes, scan archives, daily logs — you **must** run atlas_search first. Cost is a few hundred ms.

Flow:
1. Run \`atlas_search(topic)\` (and sometimes a second targeted call with a \`kind\` filter or \`since\` date).
2. If results are relevant, lead the answer with what the library contains — cite \`[kind#id]\` or titles so the user can open the item in the mini-app.
3. Then, **if** the user asked for "latest" / "current" / "today" / news-type info, OR the library is clearly stale or thin on the topic, supplement with WebSearch. Say plainly what came from library vs. web.
4. If the library has nothing, say so in one line ("library has no mentions of X"), then proceed to web.

Supporting tools:
- \`atlas_get(id)\` — full body of a single result.
- \`atlas_stats\` — verify coverage before declaring "I don't have it" (index may still be backfilling).
- \`kind\`: "inbox" | "youtube" | "signal" | "research" | "scan" | "daily_log".
- \`since\`: ISO date for time-bounded recall.
- Prefer \`atlas_search\` over \`memory_search\` for anything beyond the hand-maintained knowledge/*.md files.
- \`session_search\` — for "when did we last discuss X" / "what did we figure out last time" / "remind me what we decided". Returns the top N past conversation sessions with windowed transcript excerpts. Distinct from atlas_search (which indexes captured items, not chat). Use it whenever the question is about prior conversation history, not about saved content.

## Guidelines

- Be concise and helpful
- Remember important facts about the user using the memory tools
- When asked to remember something, store it in the appropriate memory section
- Use the browser when needed to look things up or interact with websites
- For knowledge that should persist, write it to the knowledge folder
- Always acknowledge when you've stored new information
- Use subagents for specialized tasks instead of trying to do everything yourself
- For audio tasks, you MUST use the **tts_generate** and **audio_transcribe** MCP tools (or the audio-processor subagent). For image tasks, you MUST use the **image_generate** MCP tool (or the image-generator subagent).

## Multi-Part Request Workflow

When the user asks for research + text output + audio:
1. Spawn a **researcher** Task to gather information. It returns text only.
2. **Write the findings as your own text response** so the user sees the content in the message.
3. Use the **tts_generate** MCP tool to generate audio from the text. Always provide the "name" parameter for descriptive file naming.
4. Use **telegram_send_voice** to send the audio file.

## Task Completion Rules

- Each Task MUST only be spawned once per purpose. When a Task returns results, treat them as final.
- Trust subagent results. When a Task reports it completed an action, accept that it was done.
- If a Task fails, try a different approach rather than retrying the exact same task. After two failures, report the issue to the user.`;
}

/**
 * Render the "Skill Library" section: the HOT tier (pinned + top-scored
 * skills) listed name + description so relevance-matching costs zero tool
 * calls — the model only spends a call on skill_view when there's a hit.
 * This mirrors how Claude Code surfaces skills (frontmatter descriptions
 * always in context). Discovery-by-instruction ("call skills_list first")
 * demonstrably never fired; discovery-by-listing is a fact in context.
 *
 * Side effect: stamps first_exposed_at on listed skills — the decay clock
 * starts at first exposure, not creation.
 */
export function buildSkillListing(): string {
  const header = `## Skill Library — procedural how-to memory

You have a library of class-level "how to do X" skills at \`<PSIBOT_DIR>/skills/\`. Distinct from \`knowledge/\` (static project context) and from subagents (personas).`;
  const footer = `- **\`skill_view name=<slug>\`** loads a skill's full body. Set \`load: true\` when you're actually following the procedure (not just looking).
- The list above is the most relevant subset — call \`skills_list\` to see the full library when nothing above matches a non-trivial task.
- A skill is a directory: \`SKILL.md\` plus optional \`references/\`, \`templates/\`, \`scripts/\`. The view tool returns SKILL.md plus a support-file manifest.
- Skills self-improve. After turns where the user corrects your style, workflow, or approach, a background review may patch the relevant skill or create a new one. Frustration signals like "stop doing X" or "I hate when you Y" go INTO the skill that governs that task class, not just memory.`;

  try {
    const scored = scoreAllSkills();
    const hot = scored.filter((s) => s.tier === "hot");
    if (hot.length === 0) return `${header}\n\n${footer}`;

    // Pinned first, then by score.
    hot.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.score - a.score));
    const descriptions = new Map(listSkills().map((s) => [s.name, s.description]));
    const lines = hot.map((s) => {
      const desc = descriptions.get(s.name) ?? "";
      return `- **${s.name}**${s.pinned ? " (pinned)" : ""} — ${desc}`;
    });

    markExposed(hot.map((s) => s.name));

    return `${header}

Skills most relevant to your recurring work (match on description; load before starting a task they cover):

${lines.join("\n")}

${footer}`;
  } catch (e) {
    // Prompt building must never fail on skill plumbing.
    log.warn("buildSkillListing failed", { error: String(e) });
    return `${header}\n\n${footer}`;
  }
}

/**
 * Render the "Available Subagents" section dynamically from the agents table.
 * This means new agents created via the dashboard are immediately discoverable
 * by the main conversation without a restart.
 */
function buildSubagentListing(): string {
  const agents = listAgents();
  if (agents.length === 0) {
    return "## Available Subagents\n\n(none registered)";
  }
  const lines = [
    "## Available Subagents",
    "",
    "You can spawn specialized subagents using the Task tool. Each handles a specific domain:",
    "",
  ];
  for (const agent of agents) {
    const blurb = agent.description || agent.role || agent.name;
    lines.push(`- **${agent.slug}**: ${blurb}`);
  }
  return lines.join("\n");
}

/**
 * Lightweight system prompt for scheduled jobs.
 * Jobs only need basic identity + time context — not the full persona,
 * memory, subagent docs, or trading context. This keeps token usage low
 * and avoids context window limits on smaller models (GLM/Haiku).
 */
export function buildJobPrompt(): string {
  const now = new Date();
  const localTime = now.toLocaleString("en-US", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return `You are PsiBot, a personal AI assistant running scheduled jobs. Be concise.

## Current Time
- Local: ${localTime} (${timezone})
- UTC: ${now.toISOString()}

## Instructions
- Use the available MCP tools to complete your task.
- Be brief in your response — report what was done and any issues.
- Do NOT add [SILENT] to your response. Notification filtering is handled externally.`;
}

/**
 * Known topic configurations for topic-aware prompt injection.
 * Each topic can specify a name, knowledge files to load, and a persona overlay.
 */
interface TopicConfig {
  name: string;
  knowledgeFiles: string[];
  persona: string;
}

const TOPIC_CONFIGS: Record<number, TopicConfig> = {
  103: {
    name: "Trading",
    knowledgeFiles: ["trading/GLOSSARY.md", "trading/CHAT_FORMAT.md"],
    persona: `You are in the **Trading** topic. In this context you are a trading analyst assistant.

Your priorities in this topic:
1. Use the trading-bot MCP tools to fetch live data before answering (analyze_symbol, get_options_flow, get_market_regime, etc.)
2. Always follow the CHAT_FORMAT.md formatting rules below — structured sections, expanded acronyms, bold tickers
3. Reference the GLOSSARY.md definitions when using technical terms — expand every acronym on first use
4. Synthesize across prior research: check PLAYBOOK.md for active positions, REGIME.md for current regime, and the user's recent questions in this session
5. Prefer spawning trading subagents (technical-analyst, fundamental-analyst, macro-strategist, sentiment-scout) for deep analysis
6. When presenting data for multiple tickers, use tables or per-ticker breakdowns — never walls of text
7. Every response with an actionable opinion MUST include specific price levels (support, resistance, entry, exit, stop)`,
  },
};

function buildChatContextSection(ctx: ChatContext, memory: MemorySystem): string {
  const isGroup = ctx.chatType === "group" || ctx.chatType === "supergroup";
  if (!isGroup) return "";

  const topicConfig = ctx.topicId ? TOPIC_CONFIGS[ctx.topicId] : undefined;

  const lines = [
    `## Current Chat Context`,
    ``,
    `You are responding to a message in a Telegram GROUP CHAT.`,
    `- Chat ID: ${ctx.chatId}`,
  ];

  if (ctx.topicId) {
    lines.push(`- Topic/Thread ID: ${ctx.topicId}${topicConfig ? ` (${topicConfig.name})` : ""}`);
  }

  lines.push(
    ``,
    `IMPORTANT: When using telegram_send_message, telegram_send_photo, or telegram_send_voice tools, you MUST specify chat_id="${ctx.chatId}"${ctx.topicId ? ` and topic_id=${ctx.topicId}` : ""} to send the response to the correct group${ctx.topicId ? " topic" : ""}. Do NOT omit these parameters or the message will go to the wrong chat.`,
    ``
  );

  // Inject topic-specific persona and knowledge
  if (topicConfig) {
    lines.push(`## Topic: ${topicConfig.name}`, ``, topicConfig.persona, ``);

    for (const file of topicConfig.knowledgeFiles) {
      const content = memory.readKnowledgeFileOptional(file);
      if (content) {
        lines.push(content, ``);
      }
    }
  }

  return lines.join("\n") + "\n";
}
