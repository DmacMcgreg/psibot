// graph-viz.ts — D3-facing graph data builders, split from graph.ts (which was
// 618 physical lines; cap 500). graph.ts re-exports this module's surface so
// existing `./graph.ts` importers (src/web routes, graph.test.ts) are
// unchanged; import from here directly in new code.

import { getDb } from "../db/index.ts";
import { decodeVecBlob } from "./embeddings.ts";
import type { GraphData, TopicNode, TopicRelation } from "./graph.ts";

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

  // Fetch embeddings for all summary chunks. bun:sqlite returns the vec0
  // column as raw bytes, so decode before use — indexing the bytes directly
  // made every pair look similar (all components 0..255, all positive).
  const embeddingStmt = db.prepare<{ embedding: Uint8Array }, [number]>(
    `SELECT embedding FROM youtube_vec WHERE rowid = ?`
  );
  const embeddingMap = new Map<string, Float32Array>();
  for (const v of videos) {
    const vec = decodeVecBlob(embeddingStmt.get(v.chunk_id)?.embedding);
    if (vec) {
      embeddingMap.set(v.video_id, vec);
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
  const topEdges = topEdgesByVideo(embeddingMap, similarityThreshold, maxEdgesPerNode);

  // Deduplicate edges (A->B and B->A)
  const edges = edgesFromTopK(topEdges, maxEdgesPerNode);

  return { nodes, edges };
}

/** Pairwise cosine similarity over the embedding map, keeping the top-k
 * candidate edges per node (over-collected by 2x, trimmed after sorting). */
function topEdgesByVideo(
  embeddingMap: Map<string, Float32Array>,
  similarityThreshold: number,
  maxEdgesPerNode: number,
): Map<string, Array<{ target: string; sim: number }>> {
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
  return topEdges;
}

/** Sort each node's candidates by similarity, take the top-k, and drop the
 * A->B / B->A duplicates. */
function edgesFromTopK(
  topEdges: Map<string, Array<{ target: string; sim: number }>>,
  maxEdgesPerNode: number,
): GraphData["edges"] {
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
  return edges;
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
