import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../shared/logger.ts";
import type { Transcript } from "./transcript.ts";

const log = createLogger("youtube:analyzer");

export interface Theme {
  id: string;
  name: string;
  summary: string;
}

export interface KeyTopic {
  timestamp: string;
  topic: string;
  theme_id: string;
  summary: string;
}

export interface Insight {
  timestamp: string | null;
  insight: string;
  theme_id: string;
}

export interface Quote {
  timestamp: string;
  speaker: string | null;
  quote: string;
  theme_id: string;
}

export interface ParsedTranscript {
  markdown_summary: string;
  tags: string[];
  themes: Theme[];
  key_topics: KeyTopic[];
  insights: Insight[];
  quotes: Quote[];
}

function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Parse a transcript with Claude Agent SDK into structured analysis.
 */
export async function analyzeTranscript(
  transcript: Transcript,
  videoTitle: string,
  options?: { model?: string }
): Promise<ParsedTranscript> {
  try {
    log.info("Analyzing transcript", { videoTitle, segments: transcript.segments.length });

    const transcriptData = transcript.segments.map((seg) => ({
      timestamp: formatTimestamp(seg.start),
      text: seg.text,
    }));

    const prompt = `Analyze this YouTube video transcript and create a structured summary.

Title: ${videoTitle}

Transcript:
${JSON.stringify(transcriptData, null, 2)}

Create a JSON object with this schema:

{
  "markdown_summary": "## Overview\\n(2-3 sentences)\\n\\n## Key Topics\\n(timestamped list)\\n\\n## Actionable Insights\\n(bulleted with timestamps, imperative verbs)\\n\\n## Notable Quotes\\n(4-6 key quotes with timestamps)\\n\\n## Follow-up Ideas\\n(optional next steps)",
  "tags": ["2-5 categorization tags"],
  "themes": [
    {
      "id": "t1",
      "name": "theme name",
      "summary": "1-2 sentences"
    }
  ],
  "key_topics": [
    {
      "timestamp": "HH:MM:SS",
      "topic": "topic name",
      "theme_id": "t1",
      "summary": "1-2 sentences"
    }
  ],
  "insights": [
    {
      "timestamp": "HH:MM:SS or null",
      "insight": "imperative phrasing (e.g., Consider..., Explore...)",
      "theme_id": "t1"
    }
  ],
  "quotes": [
    {
      "timestamp": "HH:MM:SS",
      "speaker": "speaker name or null",
      "quote": "the actual quote",
      "theme_id": "t1"
    }
  ]
}

Return the JSON in a markdown code block like this:
\`\`\`json
{
  "markdown_summary": "...",
  ...
}
\`\`\``;

    let response = "";
    for await (const msg of query({ prompt, options: { maxTurns: 1, ...(options?.model ? { model: options.model } : {}) } })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? block.text : ""
          )
          .join("");
      } else if (msg.type === "result") {
        log.info("Analysis complete", {
          turns: msg.num_turns,
          durationMs: msg.duration_ms,
          cost: msg.total_cost_usd?.toFixed(6),
        });
      }
    }

    // Extract JSON from response
    let jsonString: string | null = null;

    // Try 1: markdown code block
    const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      const extracted = codeBlockMatch[1].trim();
      if (extracted.startsWith("{") && extracted.endsWith("}")) {
        jsonString = extracted;
      }
    }

    // Try 2: brace matching
    if (!jsonString) {
      const firstBrace = response.indexOf("{");
      if (firstBrace !== -1) {
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        let endPos = -1;

        for (let i = firstBrace; i < response.length; i++) {
          const char = response[i];

          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (char === "\\") {
            escapeNext = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (char === "{") braceCount++;
            else if (char === "}") {
              braceCount--;
              if (braceCount === 0) {
                endPos = i;
                break;
              }
            }
          }
        }

        if (endPos !== -1) {
          jsonString = response.substring(firstBrace, endPos + 1);
        }
      }
    }

    if (!jsonString) {
      log.error("No JSON in agent response", { responsePreview: response.slice(0, 500) });
      throw new Error("Agent did not return valid JSON");
    }

    const parsed: ParsedTranscript = JSON.parse(jsonString);

    log.info("Parsed analysis", {
      themes: parsed.themes.length,
      topics: parsed.key_topics.length,
      insights: parsed.insights.length,
      quotes: parsed.quotes.length,
      tags: parsed.tags,
    });

    return parsed;
  } catch (error) {
    log.error("Analysis failed, using fallback", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallbackAnalysis(transcript, videoTitle);
  }
}

function fallbackAnalysis(transcript: Transcript, videoTitle: string): ParsedTranscript {
  const overview = transcript.fullText.substring(0, 300) + "...";
  const markdown_summary = `## Overview\n**${videoTitle}**\n\n${overview}\n\n## Key Topics\nAuto-generated fallback -- topics extracted at 5-minute intervals.\n\n## Actionable Insights\n- Review the full transcript for detailed insights\n\n## Notable Quotes\nNo quotes extracted in fallback mode.\n\n## Follow-up Ideas\nConsider re-processing for better analysis.`;

  const key_topics: KeyTopic[] = [];
  const INTERVAL = 300;
  for (let i = 0; i < transcript.segments.length; i++) {
    const segment = transcript.segments[i];
    if (segment.start % INTERVAL < 10 || i === 0) {
      key_topics.push({
        timestamp: formatTimestamp(segment.start),
        topic: `Content at ${formatTimestamp(segment.start)}`,
        theme_id: "t1",
        summary: segment.text.substring(0, 100) + "...",
      });
    }
  }

  return {
    markdown_summary,
    tags: ["auto-generated", "fallback"],
    themes: [{ id: "t1", name: "General Content", summary: "Auto-generated fallback theme." }],
    key_topics,
    insights: [{ timestamp: null, insight: "Re-process this video for detailed analysis", theme_id: "t1" }],
    quotes: [],
  };
}
