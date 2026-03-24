# YouTube Knowledge Graph Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a queryable topic knowledge graph from the YouTube video library with three D3 visualizations, exposed via MCP tools that teach the agent how to explore it.

**Architecture:** Extract themes from existing `analysis_json` into materialized graph tables (topics, links, relations). Expose via MCP tools with rich usage guides. Render all three graph views (Topic Clusters, Video Similarity, Hybrid Knowledge Graph) in a single web page using D3.js force simulation. No Python, no build step -- everything in Bun/TypeScript + CDN-loaded D3.

**Tech Stack:** SQLite (new tables), D3.js v7 (CDN), Hono routes, existing Gemini embeddings (768-dim), svg-based force-directed graphs.

---

### Task 1: Database Schema -- Topic Graph Tables

**Files:**
- Modify: `src/db/schema.ts` (add migrations)

**Step 1: Add three new table migrations to MIGRATIONS array**

Append these migrations to the end of the `MIGRATIONS` array in `src/db/schema.ts`:

```typescript
// --- YouTube Knowledge Graph ---
`CREATE TABLE IF NOT EXISTS youtube_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  video_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`,

`CREATE INDEX IF NOT EXISTS idx_youtube_topics_name ON youtube_topics(name)`,

`CREATE TABLE IF NOT EXISTS youtube_topic_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL REFERENCES youtube_videos(video_id) ON DELETE CASCADE,
  theme_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(topic_id, video_id)
)`,

`CREATE INDEX IF NOT EXISTS idx_youtube_topic_links_topic ON youtube_topic_links(topic_id)`,
`CREATE INDEX IF NOT EXISTS idx_youtube_topic_links_video ON youtube_topic_links(video_id)`,

`CREATE TABLE IF NOT EXISTS youtube_topic_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_a_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
  topic_b_id INTEGER NOT NULL REFERENCES youtube_topics(id) ON DELETE CASCADE,
  co_occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(topic_a_id, topic_b_id)
)`,

`CREATE INDEX IF NOT EXISTS idx_youtube_topic_relations_a ON youtube_topic_relations(topic_a_id)`,
`CREATE INDEX IF NOT EXISTS idx_youtube_topic_relations_b ON youtube_topic_relations(topic_b_id)`,
```

**Step 2: Verify migrations run**

```bash
bun run dev
```

Check that the server starts without migration errors, then stop it.

**Step 3: Commit**

```
feat: add youtube knowledge graph tables (topics, links, relations)
```

---

### Task 2: Topic Graph Data Module

**Files:**
- Create: `src/youtube/graph.ts`

This module handles all topic graph CRUD and queries. It reads `analysis_json` from videos, deduplicates themes by normalized name, and maintains the co-occurrence graph.

**Step 1: Create `src/youtube/graph.ts`**

```typescript
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
      [number, number]
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

  // Assign colors by rough frequency band
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
export function buildVideoSimilarityGraph(similarityThreshold: number = 0.65): GraphData {
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

  // Collect unique channels for coloring
  const channels = [...new Set(videos.map((v) => v.channel_title))];

  const nodes = videos.map((v) => ({
    id: `v-${v.video_id}`,
    label: v.title.length > 40 ? v.title.slice(0, 37) + "..." : v.title,
    type: "video" as const,
    size: 12,
    channel: v.channel_title,
    color: undefined as string | undefined,
  }));

  // Compute pairwise cosine similarity
  const edges: GraphData["edges"] = [];
  const videoIds = [...embeddingMap.keys()];

  for (let i = 0; i < videoIds.length; i++) {
    for (let j = i + 1; j < videoIds.length; j++) {
      const embA = embeddingMap.get(videoIds[i])!;
      const embB = embeddingMap.get(videoIds[j])!;
      const sim = cosineSimilarity(embA, embB);

      if (sim >= similarityThreshold) {
        edges.push({
          source: `v-${videoIds[i]}`,
          target: `v-${videoIds[j]}`,
          weight: sim,
        });
      }
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
```

**Step 2: Verify it compiles**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```
feat: add youtube knowledge graph data module with topic extraction, queries, and graph builders
```

---

### Task 3: Integrate Topic Indexing into Video Processing Pipeline

**Files:**
- Modify: `src/youtube/process.ts`

**Step 1: Add topic indexing after chunk insertion**

At the end of `processAndStoreVideo()`, after the embedding loop, add:

```typescript
import { indexVideoTopics } from "./graph.ts";

// After the embedding insertion loop:
const topicCount = indexVideoTopics(videoId, analysis);
log.info("Indexed topics", { videoId, topicCount });
```

This ensures every new video automatically updates the knowledge graph.

**Step 2: Verify it compiles**

```bash
bun run tsc --noEmit
```

**Step 3: Commit**

```
feat: auto-index video topics into knowledge graph during processing
```

---

### Task 4: Backfill Script

**Files:**
- Create: `scripts/rebuild-topic-graph.ts`

**Step 1: Create the backfill script**

```typescript
import "../src/db/index.ts"; // Initialize DB
import { rebuildTopicGraph } from "../src/youtube/graph.ts";

console.log("Rebuilding YouTube topic graph from all existing videos...\n");

const result = rebuildTopicGraph();

console.log(`Done!`);
console.log(`  Topics: ${result.topicCount}`);
console.log(`  Video-topic links: ${result.linkCount}`);
console.log(`  Topic co-occurrences: ${result.relationCount}`);
```

**Step 2: Run it**

```bash
bun run scripts/rebuild-topic-graph.ts
```

Expect output showing topic/link/relation counts matching your video library.

**Step 3: Commit**

```
feat: add topic graph backfill script
```

---

### Task 5: MCP Agent Tools

**Files:**
- Modify: `src/agent/youtube-tools.ts`

Add three new tools to the existing `createYoutubeTools` function's tools array. These tools have rich descriptions that teach the agent how to explore the knowledge graph.

**Step 1: Add imports at the top**

```typescript
import {
  listTopics,
  getTopicWithRelations,
  getRelatedVideos,
  getSharedTopics,
  rebuildTopicGraph,
} from "../youtube/graph.ts";
```

**Step 2: Add `youtube_topics` tool**

```typescript
tool(
  "youtube_topics",
  `Search and browse the topic knowledge graph built from your YouTube video library.
Each video's themes are extracted and deduplicated into a shared topic graph with co-occurrence relationships.

USAGE GUIDE:
- No arguments: lists all topics sorted by video count (most covered topics first)
- query param: search topics by name (e.g. "machine learning", "productivity")
- topic_id param: get a specific topic with its related topics and linked videos

EXPLORATION STRATEGIES:
1. "What do I know about X?" -> search topics for X, then check linked videos
2. "What connects topic A to B?" -> get both topics, look at shared related_topics
3. "What are my biggest knowledge areas?" -> list all topics, look at highest video_count
4. "Suggest something to watch" -> find topics with low video_count (gaps in knowledge)
5. Chain with youtube_get to dive deep into a specific video's full analysis
6. Chain with youtube_search for semantic search within a topic's videos`,
  {
    query: z.string().optional().describe("Search topics by name (fuzzy match)"),
    topic_id: z.number().optional().describe("Get a specific topic with its relations and videos"),
    limit: z.number().optional().describe("Max results (default: 50)"),
  },
  async (args) => {
    try {
      if (args.topic_id) {
        const topic = getTopicWithRelations(args.topic_id);
        if (!topic) {
          return {
            content: [{ type: "text" as const, text: `Topic not found: ${args.topic_id}` }],
            isError: true,
          };
        }

        const relatedStr = topic.related_topics.length > 0
          ? topic.related_topics.map((r) => `  - ${r.display_name} (${r.co_occurrence_count} shared videos)`).join("\n")
          : "  (none)";

        const videosStr = topic.videos.length > 0
          ? topic.videos.map((v) => `  - "${v.title}" by ${v.channel_title}\n    ${v.theme_summary}`).join("\n")
          : "  (none)";

        return {
          content: [{
            type: "text" as const,
            text: `Topic: ${topic.display_name} (${topic.video_count} videos)\n${topic.description}\n\nRelated Topics:\n${relatedStr}\n\nVideos:\n${videosStr}`,
          }],
        };
      }

      const topics = listTopics(args.query, args.limit ?? 50);
      if (topics.length === 0) {
        return {
          content: [{ type: "text" as const, text: args.query ? `No topics matching "${args.query}"` : "No topics yet. Process some videos first." }],
        };
      }

      const lines = topics.map((t) => `  ${t.id}. ${t.display_name} (${t.video_count} videos)`);
      return {
        content: [{
          type: "text" as const,
          text: `${topics.length} topics:\n${lines.join("\n")}\n\nUse topic_id to explore a specific topic's relations and videos.`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: `Topics query failed: ${message}` }], isError: true };
    }
  }
),
```

**Step 3: Add `youtube_related` tool**

```typescript
tool(
  "youtube_related",
  `Find videos related to a given video through shared topics in the knowledge graph.

USAGE GUIDE:
- Pass a video_id to find other videos that share topics with it
- Results ranked by number of shared topics (strongest connections first)
- Each result shows which topics are shared, so you can explain WHY they're related

EXPLORATION STRATEGIES:
1. User mentions a video -> find related videos to suggest more content
2. Compare two videos -> use compare_video_ids to see shared topics between them
3. "What else covers topic X?" -> use youtube_topics instead to get all videos for a topic
4. Combine with youtube_search for hybrid discovery (topic-based + semantic)`,
  {
    video_id: z.string().describe("YouTube video ID to find related videos for"),
    compare_video_id: z.string().optional().describe("Optional second video ID to find shared topics between two specific videos"),
    limit: z.number().optional().describe("Max results (default: 10)"),
  },
  async (args) => {
    try {
      if (args.compare_video_id) {
        const shared = getSharedTopics(args.video_id, args.compare_video_id);
        if (shared.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No shared topics between ${args.video_id} and ${args.compare_video_id}` }],
          };
        }
        const lines = shared.map((t) => `  - ${t.display_name} (${t.video_count} total videos)`);
        return {
          content: [{
            type: "text" as const,
            text: `${shared.length} shared topics between the videos:\n${lines.join("\n")}`,
          }],
        };
      }

      const related = getRelatedVideos(args.video_id, args.limit ?? 10);
      if (related.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No related videos found for ${args.video_id}. It may have unique topics.` }],
        };
      }

      const lines = related.map((r) =>
        `  - "${r.title}" by ${r.channel_title} (${r.shared_topic_count} shared topics: ${r.shared_topics})`
      );
      return {
        content: [{
          type: "text" as const,
          text: `${related.length} related videos:\n${lines.join("\n")}`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: `Related search failed: ${message}` }], isError: true };
    }
  }
),
```

**Step 4: Add `youtube_rebuild_graph` tool**

```typescript
tool(
  "youtube_rebuild_graph",
  `Rebuild the YouTube topic knowledge graph from all stored videos. Use this if the graph seems stale or after bulk-importing videos.
Clears all existing topic data and re-extracts from every video's analysis_json.`,
  {},
  async () => {
    try {
      const result = rebuildTopicGraph();
      return {
        content: [{
          type: "text" as const,
          text: `Topic graph rebuilt: ${result.topicCount} topics, ${result.linkCount} video-topic links, ${result.relationCount} co-occurrence relations`,
        }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: `Rebuild failed: ${message}` }], isError: true };
    }
  }
),
```

**Step 5: Verify compilation**

```bash
bun run tsc --noEmit
```

**Step 6: Commit**

```
feat: add youtube knowledge graph MCP tools (topics, related, rebuild)
```

---

### Task 6: Web API Routes for Graph Data

**Files:**
- Create: `src/web/routes/youtube-graph.ts`

**Step 1: Create the route file**

```typescript
import { Hono } from "hono";
import {
  buildTopicClusterGraph,
  buildVideoSimilarityGraph,
  buildHybridGraph,
  listTopics,
  getTopicWithRelations,
  getRelatedVideos,
} from "../../youtube/graph.ts";
import { getVideo } from "../../youtube/db.ts";
import { youtubeGraphPage } from "../views/youtube-graph.ts";
import type { ParsedTranscript } from "../../youtube/analyzer.ts";

export function createYoutubeGraphRoutes() {
  const app = new Hono();

  // Page
  app.get("/youtube/graph", (c) => {
    return c.html(youtubeGraphPage());
  });

  // API: Topic Cluster graph data
  app.get("/api/youtube/graph/topics", (c) => {
    const data = buildTopicClusterGraph();
    return c.json(data);
  });

  // API: Video Similarity graph data
  app.get("/api/youtube/graph/similarity", (c) => {
    const threshold = parseFloat(c.req.query("threshold") ?? "0.65");
    const data = buildVideoSimilarityGraph(threshold);
    return c.json(data);
  });

  // API: Hybrid Knowledge graph data
  app.get("/api/youtube/graph/hybrid", (c) => {
    const data = buildHybridGraph();
    return c.json(data);
  });

  // API: Topic detail (for click interactions)
  app.get("/api/youtube/graph/topic/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const topic = getTopicWithRelations(id);
    if (!topic) return c.json({ error: "Topic not found" }, 404);
    return c.json(topic);
  });

  // API: Video detail (for click interactions)
  app.get("/api/youtube/graph/video/:id", (c) => {
    const videoId = c.req.param("id");
    const video = getVideo(videoId);
    if (!video) return c.json({ error: "Video not found" }, 404);

    const analysis: ParsedTranscript = JSON.parse(video.analysis_json);
    const tags: string[] = JSON.parse(video.tags);
    const related = getRelatedVideos(videoId, 5);

    return c.json({
      video_id: video.video_id,
      title: video.title,
      channel_title: video.channel_title,
      url: video.url,
      tags,
      summary: video.markdown_summary,
      themes: analysis.themes,
      related,
    });
  });

  return app;
}
```

**Step 2: Mount routes in `src/web/index.ts`**

Add import:
```typescript
import { createYoutubeGraphRoutes } from "./routes/youtube-graph.ts";
```

Add route mount after the existing route group mounts (before the Mini App routes):
```typescript
app.route("/", createYoutubeGraphRoutes());
```

**Step 3: Add "Graph" to nav in `src/web/views/layout.ts`**

Add to the `navItems` array:
```typescript
{ href: "/youtube/graph", label: "Graph", id: "graph" },
```

**Step 4: Verify compilation**

```bash
bun run tsc --noEmit
```

**Step 5: Commit**

```
feat: add youtube graph web routes and nav link
```

---

### Task 7: D3 Visualization Page

**Files:**
- Create: `src/web/views/youtube-graph.ts`

This is the largest task. The page renders three graph views with tab switching, D3 force simulation, zoom/pan, hover tooltips, and click-to-detail panels.

**Step 1: Create the view file**

```typescript
import { layout } from "./layout.ts";

export function youtubeGraphPage(): string {
  return layout("Knowledge Graph", "graph", graphBody());
}

function graphBody(): string {
  return `
<div class="flex flex-col h-full">
  <!-- Tab bar -->
  <div class="flex gap-1 px-4 py-2 border-b border-zinc-800 shrink-0">
    <button onclick="switchTab('topics')" id="tab-topics" class="tab-btn px-3 py-1.5 rounded text-sm font-medium bg-indigo-600 text-white">Topic Clusters</button>
    <button onclick="switchTab('similarity')" id="tab-similarity" class="tab-btn px-3 py-1.5 rounded text-sm font-medium text-zinc-400 hover:text-white hover:bg-zinc-800">Video Similarity</button>
    <button onclick="switchTab('hybrid')" id="tab-hybrid" class="tab-btn px-3 py-1.5 rounded text-sm font-medium text-zinc-400 hover:text-white hover:bg-zinc-800">Knowledge Graph</button>
    <div class="flex-1"></div>
    <span id="graph-stats" class="text-xs text-zinc-500 self-center"></span>
  </div>

  <div class="flex flex-1 overflow-hidden relative">
    <!-- Graph canvas -->
    <div id="graph-container" class="flex-1 overflow-hidden">
      <svg id="graph-svg" class="w-full h-full"></svg>
    </div>

    <!-- Detail panel -->
    <div id="detail-panel" class="hidden w-80 border-l border-zinc-800 overflow-y-auto p-4 shrink-0 bg-zinc-950">
      <div class="flex justify-between items-center mb-3">
        <h3 id="detail-title" class="text-sm font-bold text-white truncate"></h3>
        <button onclick="closeDetail()" class="text-zinc-500 hover:text-white text-lg leading-none">&times;</button>
      </div>
      <div id="detail-content" class="text-sm text-zinc-300 space-y-3"></div>
    </div>
  </div>
</div>

<!-- D3.js -->
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>

<script>
const COLORS = {
  topic: '#818cf8',     // indigo-400
  video: '#34d399',     // emerald-400
  edge: '#3f3f46',      // zinc-700
  edgeHover: '#a5b4fc', // indigo-300
  text: '#d4d4d8',      // zinc-300
  textDim: '#71717a',   // zinc-500
  bg: '#09090b',        // zinc-950
};

const CHANNEL_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#34d399',
  '#22d3ee', '#60a5fa', '#a78bfa', '#f472b6', '#e879f9',
];

let currentTab = 'topics';
let simulation = null;
let graphData = null;
let channelColorMap = {};

// --- Tab switching ---

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.className = 'tab-btn px-3 py-1.5 rounded text-sm font-medium ' +
      (b.id === 'tab-' + tab ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-white hover:bg-zinc-800');
  });
  closeDetail();
  loadGraph(tab);
}

// --- Load graph data ---

async function loadGraph(tab) {
  const endpoints = {
    topics: '/api/youtube/graph/topics',
    similarity: '/api/youtube/graph/similarity',
    hybrid: '/api/youtube/graph/hybrid',
  };

  try {
    const res = await fetch(endpoints[tab]);
    graphData = await res.json();
    document.getElementById('graph-stats').textContent =
      graphData.nodes.length + ' nodes, ' + graphData.edges.length + ' edges';

    // Build channel color map
    const channels = [...new Set(graphData.nodes.filter(n => n.channel).map(n => n.channel))];
    channelColorMap = {};
    channels.forEach((ch, i) => { channelColorMap[ch] = CHANNEL_COLORS[i % CHANNEL_COLORS.length]; });

    renderGraph(graphData, tab);
  } catch (err) {
    console.error('Failed to load graph:', err);
    document.getElementById('graph-stats').textContent = 'Error loading graph data';
  }
}

// --- Render D3 force graph ---

function renderGraph(data, tab) {
  const svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();

  const container = document.getElementById('graph-container');
  const width = container.clientWidth;
  const height = container.clientHeight;

  svg.attr('viewBox', [0, 0, width, height]);

  const g = svg.append('g');

  // Zoom
  const zoom = d3.zoom()
    .scaleExtent([0.1, 5])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  // Force simulation
  if (simulation) simulation.stop();

  const maxWeight = Math.max(...data.edges.map(e => e.weight), 1);

  simulation = d3.forceSimulation(data.nodes)
    .force('link', d3.forceLink(data.edges)
      .id(d => d.id)
      .distance(d => 120 - (d.weight / maxWeight) * 60)
      .strength(d => 0.3 + (d.weight / maxWeight) * 0.7)
    )
    .force('charge', d3.forceManyBody()
      .strength(d => d.type === 'topic' ? -200 : -100)
    )
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(d => d.size + 4));

  // Edges
  const link = g.append('g')
    .selectAll('line')
    .data(data.edges)
    .join('line')
    .attr('stroke', COLORS.edge)
    .attr('stroke-width', d => Math.max(0.5, Math.min(4, d.weight / maxWeight * 4)))
    .attr('stroke-opacity', 0.4);

  // Nodes
  const node = g.append('g')
    .selectAll('g')
    .data(data.nodes)
    .join('g')
    .call(d3.drag()
      .on('start', dragstarted)
      .on('drag', dragged)
      .on('end', dragended)
    )
    .on('click', (event, d) => showDetail(d))
    .on('mouseenter', (event, d) => highlightConnections(d, data, link, node))
    .on('mouseleave', () => resetHighlight(link, node))
    .style('cursor', 'pointer');

  // Node shapes
  node.each(function(d) {
    const el = d3.select(this);
    if (d.type === 'topic') {
      // Diamond for topics
      const s = d.size;
      el.append('polygon')
        .attr('points', '0,' + (-s) + ' ' + s + ',0 0,' + s + ' ' + (-s) + ',0')
        .attr('fill', COLORS.topic)
        .attr('fill-opacity', 0.8)
        .attr('stroke', COLORS.topic)
        .attr('stroke-width', 1.5);
    } else {
      // Circle for videos
      const color = d.channel ? (channelColorMap[d.channel] || COLORS.video) : COLORS.video;
      el.append('circle')
        .attr('r', d.size)
        .attr('fill', color)
        .attr('fill-opacity', 0.7)
        .attr('stroke', color)
        .attr('stroke-width', 1.5);
    }
  });

  // Labels (only for larger nodes or topics)
  node.filter(d => d.type === 'topic' || d.size > 15)
    .append('text')
    .text(d => d.label)
    .attr('text-anchor', 'middle')
    .attr('dy', d => d.size + 14)
    .attr('fill', COLORS.text)
    .attr('font-size', '10px')
    .attr('pointer-events', 'none');

  // Tooltip
  const tooltip = d3.select('body').selectAll('.graph-tooltip').data([0]).join('div')
    .attr('class', 'graph-tooltip')
    .style('position', 'fixed')
    .style('pointer-events', 'none')
    .style('background', '#27272a')
    .style('border', '1px solid #3f3f46')
    .style('border-radius', '6px')
    .style('padding', '8px 12px')
    .style('font-size', '12px')
    .style('color', '#fafafa')
    .style('z-index', '1000')
    .style('display', 'none')
    .style('max-width', '300px');

  node
    .on('mouseenter', function(event, d) {
      highlightConnections(d, data, link, node);
      let html = '<strong>' + escapeHtml(d.label) + '</strong>';
      if (d.channel) html += '<br><span style="color:#a1a1aa">Channel: ' + escapeHtml(d.channel) + '</span>';
      if (d.videoCount) html += '<br><span style="color:#a1a1aa">' + d.videoCount + ' videos</span>';
      tooltip.html(html).style('display', 'block');
    })
    .on('mousemove', function(event) {
      tooltip.style('left', (event.clientX + 12) + 'px').style('top', (event.clientY - 12) + 'px');
    })
    .on('mouseleave', function() {
      resetHighlight(link, node);
      tooltip.style('display', 'none');
    });

  // Tick
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    node.attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');
  });

  // Initial zoom to fit
  setTimeout(() => {
    const bounds = g.node().getBBox();
    if (bounds.width > 0 && bounds.height > 0) {
      const scale = Math.min(width / (bounds.width + 80), height / (bounds.height + 80), 1.5);
      const tx = width / 2 - (bounds.x + bounds.width / 2) * scale;
      const ty = height / 2 - (bounds.y + bounds.height / 2) * scale;
      svg.transition().duration(500).call(
        zoom.transform,
        d3.zoomIdentity.translate(tx, ty).scale(scale)
      );
    }
  }, 1000);
}

// --- Highlight connected nodes ---

function highlightConnections(d, data, link, node) {
  const connectedIds = new Set();
  connectedIds.add(d.id);
  data.edges.forEach(e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    if (src === d.id) connectedIds.add(tgt);
    if (tgt === d.id) connectedIds.add(src);
  });

  node.style('opacity', n => connectedIds.has(n.id) ? 1 : 0.15);
  link.style('opacity', e => {
    const src = typeof e.source === 'object' ? e.source.id : e.source;
    const tgt = typeof e.target === 'object' ? e.target.id : e.target;
    return (src === d.id || tgt === d.id) ? 0.8 : 0.05;
  });
}

function resetHighlight(link, node) {
  node.style('opacity', 1);
  link.style('opacity', 0.4);
}

// --- Drag handlers ---

function dragstarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x;
  d.fy = d.y;
}

function dragged(event, d) {
  d.fx = event.x;
  d.fy = event.y;
}

function dragended(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null;
  d.fy = null;
}

// --- Detail panel ---

async function showDetail(d) {
  const panel = document.getElementById('detail-panel');
  const title = document.getElementById('detail-title');
  const content = document.getElementById('detail-content');

  panel.classList.remove('hidden');
  title.textContent = d.label;
  content.innerHTML = '<p class="text-zinc-500">Loading...</p>';

  try {
    if (d.type === 'topic') {
      const topicId = d.id.replace('t-', '');
      const res = await fetch('/api/youtube/graph/topic/' + topicId);
      const data = await res.json();

      let html = '<p class="text-zinc-400">' + escapeHtml(data.description || 'No description') + '</p>';
      html += '<p class="text-xs text-zinc-500 mt-1">' + data.video_count + ' videos</p>';

      if (data.related_topics && data.related_topics.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Related Topics</h4>';
        html += data.related_topics.map(r =>
          '<div class="text-xs py-1 border-b border-zinc-800">' + escapeHtml(r.display_name) + ' <span class="text-zinc-500">(' + r.co_occurrence_count + ' shared)</span></div>'
        ).join('');
        html += '</div>';
      }

      if (data.videos && data.videos.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Videos</h4>';
        html += data.videos.map(v =>
          '<div class="text-xs py-1.5 border-b border-zinc-800"><div class="text-white">' + escapeHtml(v.title) + '</div><div class="text-zinc-500">' + escapeHtml(v.channel_title) + '</div></div>'
        ).join('');
        html += '</div>';
      }

      content.innerHTML = html;
    } else {
      const videoId = d.id.replace('v-', '');
      const res = await fetch('/api/youtube/graph/video/' + videoId);
      const data = await res.json();

      let html = '<div class="text-xs text-zinc-500">' + escapeHtml(data.channel_title) + '</div>';
      html += '<a href="' + escapeHtml(data.url) + '" target="_blank" class="text-xs text-indigo-400 hover:underline">Watch on YouTube</a>';

      if (data.tags && data.tags.length > 0) {
        html += '<div class="flex flex-wrap gap-1 mt-2">';
        html += data.tags.map(t => '<span class="px-1.5 py-0.5 bg-zinc-800 rounded text-xs text-zinc-300">' + escapeHtml(t) + '</span>').join('');
        html += '</div>';
      }

      if (data.summary) {
        html += '<div class="mt-3 prose prose-invert prose-sm" data-md>' + escapeHtml(data.summary) + '</div>';
      }

      if (data.themes && data.themes.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Themes</h4>';
        html += data.themes.map(t =>
          '<div class="text-xs py-1 border-b border-zinc-800"><span class="text-white">' + escapeHtml(t.name) + '</span>: ' + escapeHtml(t.summary) + '</div>'
        ).join('');
        html += '</div>';
      }

      if (data.related && data.related.length > 0) {
        html += '<div class="mt-3"><h4 class="text-xs font-bold text-zinc-400 uppercase mb-1">Related Videos</h4>';
        html += data.related.map(r =>
          '<div class="text-xs py-1 border-b border-zinc-800">' + escapeHtml(r.title) + ' <span class="text-zinc-500">(' + r.shared_topic_count + ' topics)</span></div>'
        ).join('');
        html += '</div>';
      }

      content.innerHTML = html;
      renderMarkdown();
    }
  } catch (err) {
    content.innerHTML = '<p class="text-red-400">Failed to load details</p>';
  }
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
loadGraph('topics');
</script>`;
}
```

**Step 2: Verify compilation**

```bash
bun run tsc --noEmit
```

**Step 3: Test manually**

Start the server and navigate to `/youtube/graph`. Verify:
- Tab switching works
- Topic Cluster view shows nodes and edges
- Video Similarity view shows video nodes
- Hybrid view shows both node types
- Hover highlights connected nodes
- Click opens detail panel
- Zoom/pan works

**Step 4: Commit**

```
feat: add D3 knowledge graph visualization with three views
```

---

### Task 8: Visual Polish and Edge Cases

**Files:**
- Modify: `src/web/views/youtube-graph.ts` (if needed)
- Modify: `src/youtube/graph.ts` (if needed)

**Step 1: Handle empty state**

If no videos are processed yet, show a helpful message instead of an empty graph.

**Step 2: Handle disconnected nodes**

Videos with unique topics (no co-occurrence) should still appear in the graph but positioned at the periphery.

**Step 3: Test with actual data**

Run the backfill script (Task 4), then load each graph view and verify the data looks correct:

```bash
bun run scripts/rebuild-topic-graph.ts
bun run dev
```

Navigate to `http://localhost:3000/youtube/graph` and verify all three views.

**Step 4: Commit**

```
fix: handle edge cases in knowledge graph visualization
```

---

## Summary of New/Modified Files

| File | Action | Purpose |
|------|--------|---------|
| `src/db/schema.ts` | Modify | Add 3 graph tables + indexes |
| `src/youtube/graph.ts` | Create | Topic CRUD, graph queries, builders, backfill |
| `src/youtube/process.ts` | Modify | Hook topic indexing into pipeline |
| `scripts/rebuild-topic-graph.ts` | Create | One-time backfill script |
| `src/agent/youtube-tools.ts` | Modify | Add 3 MCP tools (topics, related, rebuild) |
| `src/web/routes/youtube-graph.ts` | Create | API endpoints + page route |
| `src/web/views/youtube-graph.ts` | Create | D3 visualization page |
| `src/web/views/layout.ts` | Modify | Add "Graph" nav item |
| `src/web/index.ts` | Modify | Mount graph routes |
