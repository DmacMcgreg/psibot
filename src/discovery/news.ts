import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { cosineSimilarity } from "./scoring.ts";
import { getInterestWeights } from "./db.ts";

const log = createLogger("discovery:news");

const EMBEDDING_DIMENSIONS = 768;

// Two videos whose summary embeddings are within this cosine similarity are
// clustered together (talking about the same thing).
const CLUSTER_SIMILARITY_THRESHOLD = 0.78;

// A cluster's centroid must be at least this far (cosine) from EVERY video
// summary older than the window to count as "novel" (a genuinely new story,
// not the continuation of an ongoing thread).
const NOVELTY_DISTANCE = 0.30; // i.e. similarity < (1 - 0.30) = 0.70 to all old videos

const WINDOW_HOURS = 48;
const MIN_CLUSTER_VIDEOS = 1; // a single high-novelty video can be a story
const MAX_NEWS_ITEMS = 5;

export interface NewsItem {
  headline: string;
  what: string;
  whyItMatters: string;
  sourceVideos: Array<{ videoId: string; title: string; channel: string }>;
  novelty: number; // 0..1 — higher = more novel
  videoCount: number;
}

export interface NewsMineResult {
  items: NewsItem[];
  clustersConsidered: number;
  videosInWindow: number;
}

interface VideoWithVector {
  videoId: string;
  title: string;
  channel: string;
  summary: string;
  vector: Float32Array;
}

/**
 * Mine news from the last WINDOW_HOURS of processed videos (including ones
 * freshly processed this run). Pipeline:
 *   1. Gather summary embeddings for videos processed in the window.
 *   2. Greedy cluster by cosine similarity.
 *   3. Novelty: a cluster is "news" if its centroid is far from all video
 *      summaries BEFORE the window (a new thread, not an ongoing one).
 *   4. For each significant cluster, one small LLM pass produces a structured
 *      news item (headline / what / why_it_matters / sources).
 *   5. Rank by novelty × profile-relevance, cap at MAX_NEWS_ITEMS.
 */
export async function mineNews(): Promise<NewsMineResult> {
  const db = getDb();

  const inWindow = await gatherRecentVideos(WINDOW_HOURS);
  if (inWindow.length === 0) {
    log.info("No videos in the news window — nothing to mine");
    return { items: [], clustersConsidered: 0, videosInWindow: 0 };
  }

  const clusters = clusterVideos(inWindow);
  log.info("Clustered window videos", { videos: inWindow.length, clusters: clusters.length });

  // Pre-window embeddings for novelty comparison.
  const preWindow = await gatherRecentVectors(720, WINDOW_HOURS); // last 30d, excluding window

  // Top interest topic names, to bias the digest toward what the user cares about.
  const interestNames = getInterestWeights()
    .slice(0, 10)
    .map((w) => db.prepare<{ display_name: string }, [number]>(
      `SELECT display_name FROM youtube_topics WHERE id = ?`,
    ).get(w.topic_id)?.display_name)
    .filter((n): n is string => !!n);

  const candidateClusters = clusters
    .map((cluster) => {
      const novelty = clusterNovelty(cluster, preWindow);
      return { cluster, novelty };
    })
    .filter(({ cluster, novelty }) =>
      cluster.length >= MIN_CLUSTER_VIDEOS && (novelty > 0 || cluster.length >= 2),
    )
    .sort((a, b) => (b.novelty * b.cluster.length) - (a.novelty * a.cluster.length))
    .slice(0, MAX_NEWS_ITEMS);

  const items: NewsItem[] = [];
  for (const { cluster, novelty } of candidateClusters) {
    try {
      const item = await summarizeCluster(cluster, novelty, interestNames);
      if (item) items.push(item);
    } catch (err) {
      log.warn("Cluster summarization failed", { error: String(err) });
    }
  }

  log.info("News mining complete", {
    videosInWindow: inWindow.length,
    clustersConsidered: clusters.length,
    items: items.length,
  });

  return { items, clustersConsidered: clusters.length, videosInWindow: inWindow.length };
}

/**
 * Gather videos processed in the last `hours`, each with its summary vector.
 *
 * Vectors are produced by batch-embedding the summaries via Gemini rather than
 * reading youtube_vec. On a long-lived bun:sqlite connection, interleaving vec0
 * virtual-table reads with other queries corrupts Bun's column-count metadata
 * ("SQLite query expected 1 values, received 2"). Re-embedding is one batch
 * call for the small window (typically <30 videos) and keeps news mining off
 * the vec tables entirely.
 */
async function gatherRecentVideos(hours: number): Promise<VideoWithVector[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT video_id, title, channel_title, markdown_summary
       FROM youtube_videos
       WHERE processed_at >= datetime('now', ?)
       ORDER BY processed_at DESC`,
    )
    .all(`-${hours} hours`) as {
      video_id: string; title: string; channel_title: string; markdown_summary: string;
    }[];

  if (rows.length === 0) return [];

  // Batch-embed the summaries (cap each to keep the call focused).
  const { embedBatch } = await import("../shared/embeddings.ts");
  const texts = rows.map((r) => `${r.title}\n\n${r.markdown_summary}`.slice(0, 800));
  const vectors = await embedBatch(texts);

  return rows.map((r, i) => ({
    videoId: r.video_id,
    title: r.title,
    channel: r.channel_title,
    summary: r.markdown_summary,
    vector: vectors[i],
  }));
}

/**
 * Gather summary vectors for the pre-window baseline (used for novelty
 * comparison). Re-embeds via Gemini rather than reading youtube_vec — see
 * gatherRecentVideos for the rationale.
 */
async function gatherRecentVectors(spanHours: number, excludeRecentHours: number): Promise<Float32Array[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT title, markdown_summary
       FROM youtube_videos
       WHERE processed_at < datetime('now', ?)
         AND processed_at >= datetime('now', ?)`,
    )
    .all(`-${excludeRecentHours} hours`, `-${excludeRecentHours + spanHours} hours`) as {
      title: string; markdown_summary: string;
    }[];

  if (rows.length === 0) return [];

  const { embedBatch } = await import("../shared/embeddings.ts");
  const texts = rows.map((r) => `${r.title}\n\n${r.markdown_summary}`.slice(0, 800));
  const vectors = await embedBatch(texts);
  return vectors;
}

/** Greedy agglomerative-ish clustering: assign each video to the nearest existing cluster. */
function clusterVideos(videos: VideoWithVector[]): VideoWithVector[][] {
  const clusters: VideoWithVector[][] = [];
  for (const v of videos) {
    let bestCluster = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      // Compare against the cluster centroid.
      const centroid = averageVector(clusters[i]);
      const sim = cosineSimilarity(v.vector, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = i;
      }
    }
    if (bestCluster >= 0 && bestSim >= CLUSTER_SIMILARITY_THRESHOLD) {
      clusters[bestCluster].push(v);
    } else {
      clusters.push([v]);
    }
  }
  return clusters;
}

/** Novelty = 1 - max similarity of cluster centroid to any pre-window vector. */
function clusterNovelty(cluster: VideoWithVector[], preWindow: Float32Array[]): number {
  if (preWindow.length === 0) return 1; // nothing to compare to → treat as novel
  const centroid = averageVector(cluster);
  let maxSim = 0;
  for (const pv of preWindow) {
    const sim = cosineSimilarity(centroid, pv);
    if (sim > maxSim) maxSim = sim;
  }
  // similarity >= (1 - NOVELTY_DISTANCE) means "ongoing story" → low novelty.
  return Math.max(0, 1 - NOVELTY_DISTANCE - maxSim + (1 - NOVELTY_DISTANCE));
}

function averageVector(videos: VideoWithVector[]): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMENSIONS);
  for (const v of videos) {
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) out[i] += v.vector[i];
  }
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) out[i] /= videos.length;
  return out;
}

/** One small LLM pass to turn a video cluster into a structured news item. */
async function summarizeCluster(
  cluster: VideoWithVector[],
  novelty: number,
  interestNames: string[],
): Promise<NewsItem | null> {
  const summaries = cluster
    .slice(0, 6)
    .map((v, i) => `Video ${i + 1}: "${v.title}" by ${v.channel}\n${v.summary.slice(0, 600)}`)
    .join("\n\n---\n\n");

  const interestHint = interestNames.length > 0
    ? `\nThe user's current interest topics (bias relevance toward these): ${interestNames.join(", ")}.`
    : "";

  const prompt = `You are distilling a cluster of YouTube video summaries into a concise NEWS item.
Below are ${cluster.length} recently-processed video summaries that appear to cover a common theme.${interestHint}

${summaries}

Produce a JSON object with this schema (return ONLY the JSON in a code block):
\`\`\`json
{
  "headline": "a single punchy line naming the news/significant development (max ~90 chars)",
  "what": "2-3 sentences: what's happening, grounded in the videos",
  "why_it_matters": "1-2 sentences on why this is significant or worth attention",
  "source_video_indices": [1-based indices of the most relevant source videos]
}
\`\`\``;

  let response = "";
  try {
    for await (const msg of query({ prompt, options: { maxTurns: 1 } })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? block.text : "")
          .join("");
      }
    }
  } catch (err) {
    log.warn("News summarization query failed", { error: String(err) });
    return null;
  }

  const jsonString = extractJson(response);
  if (!jsonString) return null;
  let parsed: {
    headline?: string; what?: string; why_it_matters?: string; source_video_indices?: number[];
  };
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return null;
  }

  const indices = (parsed.source_video_indices ?? [1]).filter((i) => i >= 1 && i <= cluster.length);
  const sourceVideos = (indices.length > 0 ? indices : [1]).map((i) => ({
    videoId: cluster[i - 1].videoId,
    title: cluster[i - 1].title,
    channel: cluster[i - 1].channel,
  }));

  return {
    headline: parsed.headline ?? cluster[0].title,
    what: parsed.what ?? "",
    whyItMatters: parsed.why_it_matters ?? "",
    sourceVideos,
    novelty,
    videoCount: cluster.length,
  };
}

function extractJson(response: string): string | null {
  const codeBlock = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    const extracted = codeBlock[1].trim();
    if (extracted.startsWith("{") && extracted.endsWith("}")) return extracted;
  }
  const first = response.indexOf("{");
  const last = response.lastIndexOf("}");
  if (first !== -1 && last > first) return response.slice(first, last + 1);
  return null;
}
