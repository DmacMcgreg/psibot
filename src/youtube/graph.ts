import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import type { ParsedTranscript } from "./analyzer.ts";

const log = createLogger("youtube:graph");

// --- Types ---

export interface TopicNode {
  id: number;
  name: string;
  display_name: string;
  description: string;
  video_count: number;
}

export interface TopicLink {
  topic_id: number;
  video_id: string;
  theme_summary: string;
}

export interface TopicRelation {
  topic_a_id: number;
  topic_b_id: number;
  co_occurrence_count: number;
}

export interface TopicWithRelations extends TopicNode {
  related_topics: Array<{ id: number; name: string; display_name: string; co_occurrence_count: number }>;
  videos: Array<{ video_id: string; title: string; channel_title: string; theme_summary: string }>;
}

export interface GraphData {
  nodes: Array<{
    id: string;
    label: string;
    type: "video" | "topic";
    size: number;
    color?: string;
    channel?: string;
    videoCount?: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    weight: number;
  }>;
}

// --- Normalization ---

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

// --- Topic CRUD ---

/**
 * Get or create a topic by normalized name.
 * If the topic already exists, returns it. Otherwise creates it.
 */
export function getOrCreateTopic(themeName: string, themeSummary: string): TopicNode {
  const db = getDb();
  const normalized = normalizeName(themeName);

  const existing = db
    .prepare<TopicNode, [string]>(`SELECT * FROM youtube_topics WHERE name = ?`)
    .get(normalized);

  if (existing) return existing;

  return db
    .prepare<TopicNode, [string, string, string]>(
      `INSERT INTO youtube_topics (name, display_name, description) VALUES (?, ?, ?) RETURNING *`
    )
    .get(normalized, themeName, themeSummary)!;
}

/**
 * Link a video to a topic. Increments video_count on the topic.
 * Idempotent -- skips if link already exists.
 */
export function linkVideoToTopic(topicId: number, videoId: string, themeSummary: string): boolean {
  const db = getDb();

  const existing = db
    .prepare<{ id: number }, [number, string]>(
      `SELECT id FROM youtube_topic_links WHERE topic_id = ? AND video_id = ?`
    )
    .get(topicId, videoId);

  if (existing) return false;

  db.prepare(`INSERT INTO youtube_topic_links (topic_id, video_id, theme_summary) VALUES (?, ?, ?)`)
    .run(topicId, videoId, themeSummary);

  db.prepare(`UPDATE youtube_topics SET video_count = video_count + 1 WHERE id = ?`)
    .run(topicId);

  return true;
}

/**
 * Add or increment a co-occurrence relation between two topics.
 * Always stores with smaller ID first for consistency.
 */
export function addTopicRelation(topicAId: number, topicBId: number): void {
  const db = getDb();
  const [a, b] = topicAId < topicBId ? [topicAId, topicBId] : [topicBId, topicAId];

  db.prepare(
    `INSERT INTO youtube_topic_relations (topic_a_id, topic_b_id, co_occurrence_count)
     VALUES (?, ?, 1)
     ON CONFLICT(topic_a_id, topic_b_id)
     DO UPDATE SET co_occurrence_count = co_occurrence_count + 1`
  ).run(a, b);
}

// --- Extract topics from a video's analysis ---

/**
 * Extract themes from a video's analysis and update the topic graph.
 * Creates topics, links video to topics, and updates co-occurrence relations.
 */
export function indexVideoTopics(videoId: string, analysis: ParsedTranscript): number {
  const topicIds: number[] = [];

  for (const theme of analysis.themes) {
    const topic = getOrCreateTopic(theme.name, theme.summary);
    const isNew = linkVideoToTopic(topic.id, videoId, theme.summary);
    if (isNew) {
      topicIds.push(topic.id);
    }
  }

  // Update co-occurrence for all topic pairs in this video
  for (let i = 0; i < topicIds.length; i++) {
    for (let j = i + 1; j < topicIds.length; j++) {
      addTopicRelation(topicIds[i], topicIds[j]);
    }
  }

  return topicIds.length;
}

// --- Queries ---

/**
 * List all topics, optionally filtered by search query.
 */
export function listTopics(query?: string, limit: number = 100): TopicNode[] {
  const db = getDb();

  if (query) {
    const pattern = `%${query}%`;
    return db
      .prepare<TopicNode, [string, string, number]>(
        `SELECT * FROM youtube_topics WHERE name LIKE ? OR display_name LIKE ? ORDER BY video_count DESC LIMIT ?`
      )
      .all(pattern, pattern, limit);
  }

  return db
    .prepare<TopicNode, [number]>(
      `SELECT * FROM youtube_topics ORDER BY video_count DESC LIMIT ?`
    )
    .all(limit);
}

/**
 * Get a topic with its related topics and linked videos.
 */
export function getTopicWithRelations(topicId: number): TopicWithRelations | null {
  const db = getDb();

  const topic = db
    .prepare<TopicNode, [number]>(`SELECT * FROM youtube_topics WHERE id = ?`)
    .get(topicId);

  if (!topic) return null;

  const related = db
    .prepare<
      { id: number; name: string; display_name: string; co_occurrence_count: number },
      [number, number, number]
    >(
      `SELECT t.id, t.name, t.display_name, r.co_occurrence_count
       FROM youtube_topic_relations r
       JOIN youtube_topics t ON t.id = CASE WHEN r.topic_a_id = ? THEN r.topic_b_id ELSE r.topic_a_id END
       WHERE r.topic_a_id = ? OR r.topic_b_id = ?
       ORDER BY r.co_occurrence_count DESC`
    )
    .all(topicId, topicId, topicId);

  const videos = db
    .prepare<
      { video_id: string; title: string; channel_title: string; theme_summary: string },
      [number]
    >(
      `SELECT l.video_id, v.title, v.channel_title, l.theme_summary
       FROM youtube_topic_links l
       JOIN youtube_videos v ON v.video_id = l.video_id
       WHERE l.topic_id = ?
       ORDER BY v.processed_at DESC`
    )
    .all(topicId);

  return { ...topic, related_topics: related, videos };
}

/**
 * Find topics shared between two videos.
 */
export function getSharedTopics(videoIdA: string, videoIdB: string): TopicNode[] {
  const db = getDb();
  return db
    .prepare<TopicNode, [string, string]>(
      `SELECT t.* FROM youtube_topics t
       JOIN youtube_topic_links la ON la.topic_id = t.id AND la.video_id = ?
       JOIN youtube_topic_links lb ON lb.topic_id = t.id AND lb.video_id = ?
       ORDER BY t.video_count DESC`
    )
    .all(videoIdA, videoIdB);
}

/**
 * Find videos related to a given video by shared topics.
 * Returns videos ranked by number of shared topics.
 */
export function getRelatedVideos(
  videoId: string,
  limit: number = 10
): Array<{ video_id: string; title: string; channel_title: string; shared_topic_count: number; shared_topics: string }> {
  const db = getDb();
  return db
    .prepare<
      { video_id: string; title: string; channel_title: string; shared_topic_count: number; shared_topics: string },
      [string, string, number]
    >(
      `SELECT v.video_id, v.title, v.channel_title,
              COUNT(DISTINCT lb.topic_id) as shared_topic_count,
              GROUP_CONCAT(DISTINCT t.display_name) as shared_topics
       FROM youtube_topic_links la
       JOIN youtube_topic_links lb ON lb.topic_id = la.topic_id AND lb.video_id != la.video_id
       JOIN youtube_videos v ON v.video_id = lb.video_id
       JOIN youtube_topics t ON t.id = la.topic_id
       WHERE la.video_id = ? AND lb.video_id != ?
       GROUP BY v.video_id
       ORDER BY shared_topic_count DESC
       LIMIT ?`
    )
    .all(videoId, videoId, limit);
}

// --- Graph data builders (for D3 visualization) ---

/**
 * Build Topic Cluster graph: topics as nodes, co-occurrence as edges.
 */
export function buildTopicClusterGraph(): GraphData {
  const db = getDb();

  const topics = db
    .prepare<TopicNode, []>(`SELECT * FROM youtube_topics WHERE video_count > 0 ORDER BY video_count DESC`)
    .all();

  const relations = db
    .prepare<TopicRelation, []>(`SELECT * FROM youtube_topic_relations`)
    .all();

  const maxCount = Math.max(...topics.map((t) => t.video_count), 1);

  const nodes = topics.map((t) => ({
    id: `t-${t.id}`,
    label: t.display_name,
    type: "topic" as const,
    size: Math.max(8, Math.min(40, 8 + (t.video_count / maxCount) * 32)),
    videoCount: t.video_count,
  }));

  const edges = relations.map((r) => ({
    source: `t-${r.topic_a_id}`,
    target: `t-${r.topic_b_id}`,
    weight: r.co_occurrence_count,
  }));

  return { nodes, edges };
}

/**
 * Build Video Similarity graph: videos as nodes, edges from summary chunk cosine similarity.
 * Computes pairwise similarity on-the-fly using summary embeddings.
 */
export function buildVideoSimilarityGraph(similarityThreshold: number = 0.78, maxEdgesPerNode: number = 5): GraphData {
  const db = getDb();

  // Get all videos with their summary chunk embedding
  const videos = db
    .prepare<
      { video_id: string; title: string; channel_title: string; chunk_id: number },
      []
    >(
      `SELECT v.video_id, v.title, v.channel_title, c.id as chunk_id
       FROM youtube_videos v
       JOIN youtube_chunks c ON c.video_id = v.video_id AND c.chunk_type = 'summary'`
    )
    .all();

  // Fetch embeddings for all summary chunks
  const embeddingMap = new Map<string, Float32Array>();
  for (const v of videos) {
    const row = db
      .prepare<{ embedding: Float32Array }, [number]>(
        `SELECT embedding FROM youtube_vec WHERE rowid = ?`
      )
      .get(v.chunk_id);
    if (row) {
      embeddingMap.set(v.video_id, row.embedding);
    }
  }

  const nodes = videos.map((v) => ({
    id: `v-${v.video_id}`,
    label: v.title.length > 40 ? v.title.slice(0, 37) + "..." : v.title,
    type: "video" as const,
    size: 12,
    channel: v.channel_title,
    color: undefined as string | undefined,
  }));

  // Compute pairwise cosine similarity, keep only top-k per node
  const videoIds = [...embeddingMap.keys()];
  const topEdges = new Map<string, Array<{ target: string; sim: number }>>();

  for (const vid of videoIds) {
    topEdges.set(vid, []);
  }

  for (let i = 0; i < videoIds.length; i++) {
    for (let j = i + 1; j < videoIds.length; j++) {
      const embA = embeddingMap.get(videoIds[i])!;
      const embB = embeddingMap.get(videoIds[j])!;
      const sim = cosineSimilarity(embA, embB);

      if (sim < similarityThreshold) continue;

      // Track top-k for both nodes
      const listA = topEdges.get(videoIds[i])!;
      const listB = topEdges.get(videoIds[j])!;

      listA.push({ target: videoIds[j], sim });
      if (listA.length > maxEdgesPerNode * 2) {
        listA.sort((a, b) => b.sim - a.sim);
        listA.length = maxEdgesPerNode;
      }

      listB.push({ target: videoIds[i], sim });
      if (listB.length > maxEdgesPerNode * 2) {
        listB.sort((a, b) => b.sim - a.sim);
        listB.length = maxEdgesPerNode;
      }
    }
  }

  // Deduplicate edges (A->B and B->A)
  const edgeSet = new Set<string>();
  const edges: GraphData["edges"] = [];

  for (const [vid, candidates] of topEdges) {
    candidates.sort((a, b) => b.sim - a.sim);
    for (const { target, sim } of candidates.slice(0, maxEdgesPerNode)) {
      const key = vid < target ? `${vid}:${target}` : `${target}:${vid}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({
        source: `v-${vid}`,
        target: `v-${target}`,
        weight: sim,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Build Hybrid Knowledge Graph: both video and topic nodes, video-to-topic edges.
 */
export function buildHybridGraph(): GraphData {
  const db = getDb();

  const topics = db
    .prepare<TopicNode, []>(`SELECT * FROM youtube_topics WHERE video_count > 0`)
    .all();

  const videos = db
    .prepare<{ video_id: string; title: string; channel_title: string }, []>(
      `SELECT video_id, title, channel_title FROM youtube_videos`
    )
    .all();

  const links = db
    .prepare<{ topic_id: number; video_id: string }, []>(
      `SELECT topic_id, video_id FROM youtube_topic_links`
    )
    .all();

  const maxCount = Math.max(...topics.map((t) => t.video_count), 1);

  const nodes: GraphData["nodes"] = [
    ...topics.map((t) => ({
      id: `t-${t.id}`,
      label: t.display_name,
      type: "topic" as const,
      size: Math.max(10, Math.min(35, 10 + (t.video_count / maxCount) * 25)),
      videoCount: t.video_count,
    })),
    ...videos.map((v) => ({
      id: `v-${v.video_id}`,
      label: v.title.length > 35 ? v.title.slice(0, 32) + "..." : v.title,
      type: "video" as const,
      size: 10,
      channel: v.channel_title,
    })),
  ];

  const edges = links.map((l) => ({
    source: `t-${l.topic_id}`,
    target: `v-${l.video_id}`,
    weight: 1,
  }));

  return { nodes, edges };
}

// --- Utilities ---

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Backfill ---

/**
 * Rebuild the entire topic graph from all existing videos.
 * Clears existing graph data and rebuilds from analysis_json.
 */
export function rebuildTopicGraph(): { topicCount: number; linkCount: number; relationCount: number } {
  const db = getDb();

  log.info("Rebuilding topic graph from all videos...");

  // Clear existing graph data
  db.prepare(`DELETE FROM youtube_topic_relations`).run();
  db.prepare(`DELETE FROM youtube_topic_links`).run();
  db.prepare(`DELETE FROM youtube_topics`).run();

  // Process all videos
  const videos = db
    .prepare<{ video_id: string; analysis_json: string }, []>(
      `SELECT video_id, analysis_json FROM youtube_videos`
    )
    .all();

  let totalLinks = 0;
  for (const video of videos) {
    const analysis: ParsedTranscript = JSON.parse(video.analysis_json);
    totalLinks += indexVideoTopics(video.video_id, analysis);
  }

  const topicCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topics`).get()!.c;
  const linkCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topic_links`).get()!.c;
  const relationCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topic_relations`).get()!.c;

  log.info("Topic graph rebuilt", { topicCount, linkCount, relationCount, videoCount: videos.length });

  return { topicCount, linkCount, relationCount };
}
