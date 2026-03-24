import { Hono } from "hono";
import {
  buildTopicClusterGraph,
  buildVideoSimilarityGraph,
  buildHybridGraph,
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
    const threshold = parseFloat(c.req.query("threshold") ?? "0.78");
    const maxEdges = parseInt(c.req.query("maxEdges") ?? "5", 10);
    const data = buildVideoSimilarityGraph(threshold, maxEdges);
    return c.json(data);
  });

  // API: Hybrid Knowledge graph data
  app.get("/api/youtube/graph/hybrid", (c) => {
    const data = buildHybridGraph();
    return c.json(data);
  });

  // API: Topic detail
  app.get("/api/youtube/graph/topic/:id", (c) => {
    const id = parseInt(c.req.param("id"), 10);
    const topic = getTopicWithRelations(id);
    if (!topic) return c.json({ error: "Topic not found" }, 404);
    return c.json(topic);
  });

  // API: Video detail
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
