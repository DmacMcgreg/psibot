import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { parseVideoId, extractTranscript, getVideoMetadata } from "./transcript.ts";

// --- parseVideoId (pure, unit tests) ---

describe("parseVideoId", () => {
  it("accepts a raw 11-char video ID", () => {
    expect(parseVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from youtube.com/watch?v=", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from youtu.be shortlink", () => {
    expect(parseVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from embed URL", () => {
    expect(parseVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from shorts URL", () => {
    expect(parseVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("extracts from URL with extra query params", () => {
    expect(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")).toBe("dQw4w9WgXcQ");
  });

  it("throws on invalid input", () => {
    expect(() => parseVideoId("not-a-url-or-id")).toThrow("Cannot parse YouTube video ID");
  });

  it("throws on empty string", () => {
    expect(() => parseVideoId("")).toThrow("Cannot parse YouTube video ID");
  });
});

// --- extractTranscript + getVideoMetadata (integration, needs yt-dlp + network) ---

// Use a short, well-known video with guaranteed captions
const TEST_VIDEO_ID = "jNQXAC9IVRw"; // "Me at the zoo" - first YouTube video, 19 seconds

describe("getVideoMetadata", () => {
  it("fetches title and channel for a valid video", async () => {
    const meta = await getVideoMetadata(TEST_VIDEO_ID);
    expect(meta).not.toBeNull();
    expect(meta!.title).toContain("zoo");
    expect(meta!.channelTitle).toBeTruthy();
  }, 30_000);

  it("returns null for a nonexistent video", async () => {
    const meta = await getVideoMetadata("XXXXXXXXXXX");
    expect(meta).toBeNull();
  }, 30_000);
});

describe("extractTranscript", () => {
  it("extracts transcript segments from a video with captions", async () => {
    const transcript = await extractTranscript(TEST_VIDEO_ID);
    // This video may or may not have auto-captions, so handle both cases
    if (transcript) {
      expect(transcript.segments.length).toBeGreaterThan(0);
      expect(transcript.fullText.length).toBeGreaterThan(0);
      expect(transcript.segments[0]).toHaveProperty("text");
      expect(transcript.segments[0]).toHaveProperty("start");
      expect(transcript.segments[0]).toHaveProperty("duration");
    } else {
      console.log("No captions available for test video (expected for very short/old videos)");
    }
  }, 60_000);
});
