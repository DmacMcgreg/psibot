---
name: youtube
description: Summarize YouTube videos, store with vector embeddings, and search semantically. Use when the user shares a YouTube link, asks to summarize a video, search their saved video notes, or look up what videos they have about a topic.
---

# YouTube Video Summarizer

## Available Tools

These tools are available via the `youtube-tools` MCP server:

### youtube_summarize
Summarize a YouTube video by URL or video ID. Extracts transcript via yt-dlp, analyzes with Claude, stores in SQLite with vector embeddings.

```
youtube_summarize({ video: "https://youtube.com/watch?v=dQw4w9WgXcQ" })
youtube_summarize({ video: "dQw4w9WgXcQ" })
```

### youtube_search
Semantic vector search across all stored video summaries. Finds relevant themes, topics, insights, and quotes.

```
youtube_search({ query: "quantum physics experiments", limit: 5 })
```

### youtube_list
List stored videos with optional filters.

```
youtube_list({})
youtube_list({ keyword: "physics", channel: "Veritasium", limit: 10 })
```

### youtube_get
Get full details for a specific video.

```
youtube_get({ video_id: "dQw4w9WgXcQ" })
```

## Trigger Phrases

- "summarize this video" + YouTube URL
- "what videos do I have about X"
- "search my video notes for X"
- "list my saved videos"
- Any YouTube URL shared in conversation
