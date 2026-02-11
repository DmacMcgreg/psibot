import { createLogger } from "../shared/logger.ts";
import { parseVideoId, extractTranscript, getVideoMetadata } from "./transcript.ts";
import { analyzeTranscript } from "./analyzer.ts";
import { embedBatch } from "./embeddings.ts";
import {
  insertVideo,
  insertChunk,
  deleteVideoChunks,
  getVideo,
  type VideoProcessingStatus,
} from "./db.ts";
import type { ParsedTranscript } from "./analyzer.ts";

const log = createLogger("youtube:process");

export interface ProcessVideoResult {
  videoId: string;
  title: string;
  channelTitle: string;
  markdownSummary: string;
  chunkCount: number;
  skipped: boolean;
}

/**
 * Build embedding chunks from a parsed transcript analysis.
 */
function buildChunks(analysis: ParsedTranscript, title: string): Array<{ type: string; text: string }> {
  const chunks: Array<{ type: string; text: string }> = [];

  chunks.push({ type: "summary", text: `${title}\n\n${analysis.markdown_summary}` });

  for (const theme of analysis.themes) {
    chunks.push({ type: "theme", text: `${theme.name}: ${theme.summary}` });
  }

  for (const topic of analysis.key_topics) {
    chunks.push({ type: "topic", text: `[${topic.timestamp}] ${topic.topic}: ${topic.summary}` });
  }

  for (const insight of analysis.insights) {
    const ts = insight.timestamp ? `[${insight.timestamp}] ` : "";
    chunks.push({ type: "insight", text: `${ts}${insight.insight}` });
  }

  for (const quote of analysis.quotes) {
    const speaker = quote.speaker ? ` (${quote.speaker})` : "";
    chunks.push({ type: "quote", text: `[${quote.timestamp}]${speaker}: "${quote.quote}"` });
  }

  return chunks;
}

/**
 * Process a single video: metadata -> transcript -> analyze -> embed -> store.
 * Returns the result or throws on failure.
 * If the video is already processed, returns with skipped=true.
 */
export async function processAndStoreVideo(
  videoInput: string,
  options?: {
    playlistItemId?: string;
    processingStatus?: VideoProcessingStatus;
    forceReprocess?: boolean;
    model?: string;
  }
): Promise<ProcessVideoResult> {
  const videoId = parseVideoId(videoInput);

  // Check if already processed
  if (!options?.forceReprocess) {
    const existing = getVideo(videoId);
    if (existing) {
      return {
        videoId,
        title: existing.title,
        channelTitle: existing.channel_title,
        markdownSummary: existing.markdown_summary,
        chunkCount: 0,
        skipped: true,
      };
    }
  }

  // Fetch metadata
  log.info("Fetching metadata", { videoId });
  const meta = await getVideoMetadata(videoId);
  if (!meta) {
    throw new Error(`Could not fetch metadata for video: ${videoId}`);
  }

  // Extract transcript
  log.info("Extracting transcript", { videoId, title: meta.title });
  const transcript = await extractTranscript(videoId);
  if (!transcript) {
    throw new Error(`No transcript/captions available for: "${meta.title}"`);
  }

  // Analyze with Claude
  log.info("Analyzing transcript", { videoId });
  const analysis = await analyzeTranscript(transcript, meta.title, { model: options?.model });

  // Store in database
  deleteVideoChunks(videoId);
  insertVideo({
    videoId,
    title: meta.title,
    channelTitle: meta.channelTitle,
    tags: analysis.tags,
    markdownSummary: analysis.markdown_summary,
    analysis,
    transcriptText: transcript.fullText,
    processingStatus: options?.processingStatus ?? "complete",
    playlistItemId: options?.playlistItemId,
  });

  // Generate embeddings and store chunks
  const chunks = buildChunks(analysis, meta.title);
  log.info("Generating embeddings", { videoId, chunkCount: chunks.length });

  const texts = chunks.map((c) => c.text);
  const embeddings = await embedBatch(texts);

  for (let i = 0; i < chunks.length; i++) {
    insertChunk({
      videoId,
      chunkType: chunks[i].type,
      chunkText: chunks[i].text,
      embedding: embeddings[i],
    });
  }

  log.info("Video processed and stored", {
    videoId,
    title: meta.title,
    chunks: chunks.length,
  });

  return {
    videoId,
    title: meta.title,
    channelTitle: meta.channelTitle,
    markdownSummary: analysis.markdown_summary,
    chunkCount: chunks.length,
    skipped: false,
  };
}
