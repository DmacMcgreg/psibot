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
 * Thrown when the model's reply still can't be parsed after one stricter
 * retry (or the model call itself failed twice). Callers treat the video as
 * failed: nothing is stored, so no placeholder summary, "General Content"
 * theme, triage item or discovery seed comes out of it, and the Watch Later
 * processor retries the video on its next run.
 */
export class AnalysisFailedError extends Error {
  constructor(message: string) {
    super(`analysis_failed: ${message}`);
    this.name = "AnalysisFailedError";
  }
}

/** One model turn → raw reply text. Swappable for tests. */
export type AnalyzerAsk = (prompt: string, model?: string) => Promise<string>;

async function askModel(prompt: string, model?: string): Promise<string> {
  let response = "";
  for await (const msg of query({ prompt, options: { maxTurns: 1, ...(model ? { model } : {}) } })) {
    if (msg.type === "assistant" && msg.message) {
      response += msg.message.content
        .map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : ""))
        .join("");
    } else if (msg.type === "result") {
      log.info("Analysis complete", {
        turns: msg.num_turns,
        durationMs: msg.duration_ms,
        cost: msg.total_cost_usd?.toFixed(6),
      });
    }
  }
  return response;
}

/** First balanced {...} in the text, string-aware. */
function firstJsonObject(text: string): string | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = firstBrace; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === "\\") { escapeNext = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return text.substring(firstBrace, i + 1);
    }
  }
  return null;
}

const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * Parse and validate a model reply. Throws when there is no JSON, the JSON is
 * broken, or the summary is empty — the cases that used to produce fallback
 * placeholder rows.
 */
export function parseAnalysisResponse(response: string): ParsedTranscript {
  const block = response.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim();
  const jsonString = block && block.startsWith("{") && block.endsWith("}") ? block : firstJsonObject(response);
  if (!jsonString) throw new Error(`no JSON in reply: ${response.slice(0, 120).replace(/\s+/g, " ")}`);
  const raw = JSON.parse(jsonString) as Partial<ParsedTranscript>;
  const markdown_summary = typeof raw.markdown_summary === "string" ? raw.markdown_summary.trim() : "";
  if (markdown_summary.length < 40) throw new Error("reply has no usable markdown_summary");
  return {
    markdown_summary,
    tags: asArray<string>(raw.tags).filter((t) => typeof t === "string" && t.trim()),
    themes: asArray<Theme>(raw.themes).filter((t) => t && typeof t.name === "string" && t.name.trim()),
    key_topics: asArray<KeyTopic>(raw.key_topics),
    insights: asArray<Insight>(raw.insights).filter((i) => i && typeof i.insight === "string"),
    quotes: asArray<Quote>(raw.quotes).filter((q) => q && typeof q.quote === "string"),
  };
}

export const STRICT_RETRY_SUFFIX = `

IMPORTANT — your previous reply could not be parsed as JSON. Reply again with ONE valid JSON object and nothing else:
- no prose before or after, no code fence;
- escape every newline inside a string as \\n and every double quote as \\";
- keep "markdown_summary" under 2,500 characters and each quote under 200 characters.`;

/**
 * Summarise a transcript for recall and search: a short factual overview plus
 * key points, themes, tags and quotes. It gives no advice — concrete assets
 * (tools, techniques, datasets, deadlines) are extracted separately from the
 * stored transcript by src/assets/extract*.
 *
 * `candidateTopics` is a soft hint: nearest existing canonical topics the
 * analyzer should prefer when naming themes, to keep the taxonomy clean.
 * `candidateTags` works the same way for the flat tag vocabulary.
 *
 * On a parse failure it retries once with a stricter prompt, then throws
 * AnalysisFailedError. It never returns placeholder text.
 */
export async function analyzeTranscript(
  transcript: Transcript,
  videoTitle: string,
  options?: {
    model?: string;
    candidateTopics?: Array<{ name: string; description: string }>;
    candidateTags?: string[];
    /** Test seam; defaults to one tool-less Agent SDK turn. */
    ask?: AnalyzerAsk;
  }
): Promise<ParsedTranscript> {
  const ask = options?.ask ?? askModel;
  log.info("Analyzing transcript", {
    videoTitle,
    segments: transcript.segments.length,
    candidateTopics: options?.candidateTopics?.length ?? 0,
    candidateTags: options?.candidateTags?.length ?? 0,
  });

  const prompt = buildAnalysisPrompt(transcript, videoTitle, options);

  let firstError: string;
  try {
    const parsed = parseAnalysisResponse(await ask(prompt, options?.model));
    logParsed(parsed);
    return parsed;
  } catch (error) {
    firstError = error instanceof Error ? error.message : String(error);
    log.warn("Analysis reply unusable, retrying once with a stricter prompt", { videoTitle, error: firstError });
  }

  try {
    const parsed = parseAnalysisResponse(await ask(prompt + STRICT_RETRY_SUFFIX, options?.model));
    logParsed(parsed);
    return parsed;
  } catch (error) {
    const secondError = error instanceof Error ? error.message : String(error);
    log.error("Analysis failed after retry; video will be marked failed", { videoTitle, firstError, secondError });
    throw new AnalysisFailedError(secondError.slice(0, 200));
  }
}

function logParsed(parsed: ParsedTranscript): void {
  log.info("Parsed analysis", {
    themes: parsed.themes.length,
    topics: parsed.key_topics.length,
    points: parsed.insights.length,
    quotes: parsed.quotes.length,
    tags: parsed.tags,
  });
}

export function buildAnalysisPrompt(
  transcript: Transcript,
  videoTitle: string,
  options?: { candidateTopics?: Array<{ name: string; description: string }>; candidateTags?: string[] },
): string {
  // One compact line per segment: the old pretty-printed JSON doubled the tokens.
  const transcriptLines = transcript.segments.map((seg) => `[${formatTimestamp(seg.start)}] ${seg.text}`).join("\n");

  const candidateTopicsSection = options?.candidateTopics && options.candidateTopics.length > 0
    ? `\n\nCanonical topic taxonomy (prefer these names when a theme clearly matches one of them; otherwise invent a new theme name):\n${options.candidateTopics
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n")}\n`
    : "";

  const candidateTagsSection = options?.candidateTags && options.candidateTags.length > 0
    ? `\n\nCanonical tag vocabulary (prefer these exact strings for the "tags" field when one clearly applies; only invent a new tag when no existing tag fits). Format: lowercase-hyphenated.\n${options.candidateTags.map((t) => `- ${t}`).join("\n")}\n`
    : "";

  return `Summarise this YouTube video transcript for later recall and search.

Report what the video says. Do not give advice, do not tell the reader what to do, and do not invent "insights" the speaker didn't state. Keep names, numbers, tools, links and steps exactly as spoken.

Title: ${videoTitle}
${candidateTopicsSection}${candidateTagsSection}
Transcript (one line per segment, [HH:MM:SS] text):
${transcriptLines}

Reply with ONE JSON object with this schema:

{
  "markdown_summary": "## Overview\\n(2-3 factual sentences: what the video covers and its main claim)\\n\\n## Key Points\\n(5-10 timestamped bullets, each a specific fact, claim, number, tool or step stated in the video)\\n\\n## Notable Quotes\\n(2-4 short quotes with timestamps)",
  "tags": ["2-5 categorization tags"],
  "themes": [
    { "id": "t1", "name": "specific subject name (not a catch-all)", "summary": "1-2 sentences" }
  ],
  "key_topics": [
    { "timestamp": "HH:MM:SS", "topic": "topic name", "theme_id": "t1", "summary": "1-2 sentences" }
  ],
  "insights": [
    { "timestamp": "HH:MM:SS or null", "insight": "one key point as a factual statement of what the video says (not advice)", "theme_id": "t1" }
  ],
  "quotes": [
    { "timestamp": "HH:MM:SS", "speaker": "speaker name or null", "quote": "the actual quote", "theme_id": "t1" }
  ]
}

Escape newlines inside strings as \\n. Return the JSON in a \`\`\`json code block and nothing else.`;
}
