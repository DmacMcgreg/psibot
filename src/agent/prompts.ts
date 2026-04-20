import { MemorySystem } from "../memory/index.ts";
import type { ChatContext } from "../shared/types.ts";
import { listAgents } from "../db/queries.ts";

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

After generating media (images, audio), use telegram_send_photo or telegram_send_voice to deliver the results to the user.

## Telegram Group Posting

You can post messages, photos, and audio to Telegram groups using the telegram_send_message, telegram_send_photo, and telegram_send_voice tools with a group chat_id. For groups with topics/threads enabled, use the topic_id parameter to post to a specific topic. To discover available topic IDs, you can post to the General topic first (no topic_id needed) or the user will provide specific topic IDs.

${tradingPlaybook || tradingRegime ? `## Trading Context\n\nYou have access to a trading bot backend (localhost:8000) via the trading-bot MCP server. Use trading tools for market analysis, backtesting, ML predictions, portfolio management, and more.\n\n${tradingPlaybook ? `### Current Playbook\n\n${tradingPlaybook}\n` : ""}${tradingRegime ? `### Current Regime\n\n${tradingRegime}\n` : ""}` : ""}
${chatContext ? buildChatContextSection(chatContext, memory) : ""}
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
