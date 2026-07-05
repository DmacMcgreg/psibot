import { Hono } from "hono";
import {
  tmaYoutubePage,
  tmaVideoListFragment,
  tmaVideoErrorFragment,
  tmaYoutubeTagsPage,
  tmaYoutubeChannelsPage,
} from "../../views/mini-app/youtube.ts";
import { tmaYoutubeGraphPage } from "../../views/mini-app/youtube-graph.ts";
import {
  listVideos,
  getVideoCount,
  getVideo,
  getAllTagsWithCounts,
  getAllChannelsWithCounts,
} from "../../../youtube/db.ts";
import {
  buildTopicClusterGraph,
  buildVideoSimilarityGraph,
  buildHybridGraph,
  getTopicWithRelations,
  getRelatedVideos,
} from "../../../youtube/graph.ts";
import type { ParsedTranscript } from "../../../youtube/analyzer.ts";
import { type MiniAppEnv, requireIntParam, log } from "./shared.ts";

export function registerYoutubeRoutes(app: Hono<MiniAppEnv>): void {
  app.get("/youtube", (c) => {
    const tag = c.req.query("tag")?.trim() || undefined;
    const channel = c.req.query("channel")?.trim() || undefined;
    const keyword = c.req.query("q")?.trim() || undefined;
    try {
      const videos = listVideos({ tag, channel, keyword, limit: 50 });
      return c.html(tmaYoutubePage(videos, getVideoCount(), { tag, channel, keyword }));
    } catch (err) {
      log.error("Failed to load youtube list", { error: String(err) });
      return c.html(tmaYoutubePage([], 0, { tag, channel, keyword }));
    }
  });

  app.get("/youtube/graph", (c) => c.html(tmaYoutubeGraphPage()));
  app.get("/youtube/tags", (c) => {
    try {
      return c.html(tmaYoutubeTagsPage(getAllTagsWithCounts()));
    } catch (err) {
      log.error("Failed to load youtube tags", { error: String(err) });
      return c.html(tmaYoutubeTagsPage([]));
    }
  });
  app.get("/youtube/channels", (c) => {
    try {
      return c.html(tmaYoutubeChannelsPage(getAllChannelsWithCounts()));
    } catch (err) {
      log.error("Failed to load youtube channels", { error: String(err) });
      return c.html(tmaYoutubeChannelsPage([]));
    }
  });

  // --- YouTube API ---

  app.get("/api/youtube/search", (c) => {
    const q = c.req.query("q")?.trim() || undefined;
    const tag = c.req.query("tag")?.trim() || undefined;
    const channel = c.req.query("channel")?.trim() || undefined;
    try {
      const videos = listVideos({ keyword: q, tag, channel, limit: 50 });
      return c.html(tmaVideoListFragment(videos));
    } catch (err) {
      log.error("YouTube search failed", { error: String(err) });
      return c.html(tmaVideoErrorFragment("Search failed. Please try again."));
    }
  });

  app.get("/api/youtube/graph/topics", (c) => {
    try {
      return c.json(buildTopicClusterGraph());
    } catch (err) {
      log.error("Failed to build topic cluster graph", { error: String(err) });
      return c.json({ error: "Failed to build graph" }, 500);
    }
  });
  app.get("/api/youtube/graph/similarity", (c) => {
    const thresholdRaw = parseFloat(c.req.query("threshold") ?? "0.78");
    const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 0.78;
    const maxEdgesRaw = parseInt(c.req.query("maxEdges") ?? "5", 10);
    const maxEdges = Number.isFinite(maxEdgesRaw) ? maxEdgesRaw : 5;
    try {
      return c.json(buildVideoSimilarityGraph(threshold, maxEdges));
    } catch (err) {
      log.error("Failed to build similarity graph", { error: String(err) });
      return c.json({ error: "Failed to build graph" }, 500);
    }
  });
  app.get("/api/youtube/graph/hybrid", (c) => {
    try {
      return c.json(buildHybridGraph());
    } catch (err) {
      log.error("Failed to build hybrid graph", { error: String(err) });
      return c.json({ error: "Failed to build graph" }, 500);
    }
  });
  app.get("/api/youtube/graph/topic/:id", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.json({ error: "Bad id" }, 400);
    try {
      const topic = getTopicWithRelations(id);
      if (!topic) return c.json({ error: "Topic not found" }, 404);
      return c.json(topic);
    } catch (err) {
      log.error("Failed to load topic detail", { id, error: String(err) });
      return c.json({ error: "Failed to load topic" }, 500);
    }
  });
  app.get("/api/youtube/graph/video/:id", (c) => {
    const videoId = c.req.param("id");
    try {
      const video = getVideo(videoId);
      if (!video) return c.json({ error: "Video not found" }, 404);
      let analysis: ParsedTranscript | null = null;
      let tags: string[] = [];
      try {
        analysis = JSON.parse(video.analysis_json);
      } catch {
        analysis = null;
      }
      try {
        const parsed = JSON.parse(video.tags);
        if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
      } catch {
        tags = [];
      }
      const related = getRelatedVideos(videoId, 5);
      return c.json({
        video_id: video.video_id,
        title: video.title,
        channel_title: video.channel_title,
        url: video.url,
        tags,
        summary: video.markdown_summary,
        themes: analysis?.themes ?? [],
        related,
      });
    } catch (err) {
      log.error("Failed to load video detail", { videoId, error: String(err) });
      return c.json({ error: "Failed to load video" }, 500);
    }
  });
}
