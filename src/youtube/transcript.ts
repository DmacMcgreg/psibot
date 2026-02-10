import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("youtube:transcript");

export interface TranscriptSegment {
  text: string;
  start: number;
  duration: number;
}

export interface Transcript {
  segments: TranscriptSegment[];
  fullText: string;
}

/**
 * Extract a YouTube video ID from a URL or return as-is if already an ID.
 */
export function parseVideoId(input: string): string {
  // Already a video ID (11 chars, alphanumeric + dash + underscore)
  if (/^[\w-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    // youtube.com/watch?v=xxx
    if (url.searchParams.has("v")) return url.searchParams.get("v")!;
    // youtu.be/xxx
    if (url.hostname === "youtu.be") return url.pathname.slice(1);
    // youtube.com/embed/xxx or youtube.com/v/xxx
    const embedMatch = url.pathname.match(/\/(embed|v)\/([\w-]{11})/);
    if (embedMatch) return embedMatch[2];
    // youtube.com/shorts/xxx
    const shortsMatch = url.pathname.match(/\/shorts\/([\w-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch {
    // Not a URL
  }

  throw new Error(`Cannot parse YouTube video ID from: ${input}`);
}

/**
 * Extract transcript from a YouTube video using yt-dlp.
 * Returns null if no captions are available.
 */
export async function extractTranscript(videoId: string): Promise<Transcript | null> {
  const tmpDir = join(tmpdir(), `psi-transcript-${videoId}-${Date.now()}`);

  try {
    log.info("Extracting transcript", { videoId });
    mkdirSync(tmpDir, { recursive: true });

    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--write-auto-sub",
        "--skip-download",
        "--sub-format", "json3",
        "--output", videoId,
        `https://youtube.com/watch?v=${videoId}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpDir,
        env: { ...process.env },
      }
    );

    const [, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      log.error("yt-dlp failed", { videoId, exitCode, stderr: stderr.slice(0, 500) });
      return null;
    }

    // Find the .json3 subtitle file
    const files = readdirSync(tmpDir);
    const jsonFile = files.find(f => f.endsWith(".json3"));

    if (!jsonFile) {
      log.info("No subtitle file found", { videoId });
      return null;
    }

    const subtitleContent = readFileSync(join(tmpDir, jsonFile), "utf-8");
    const subtitleData = JSON.parse(subtitleContent) as {
      events?: Array<{
        tStartMs?: number;
        dDurationMs?: number;
        segs?: Array<{ utf8: string }>;
      }>;
    };

    const segments: TranscriptSegment[] = [];
    let fullText = "";

    if (subtitleData.events) {
      for (const event of subtitleData.events) {
        if (event.segs) {
          const text = event.segs.map(seg => seg.utf8).join("");
          if (text.trim()) {
            segments.push({
              text: text.trim(),
              start: (event.tStartMs ?? 0) / 1000,
              duration: (event.dDurationMs ?? 0) / 1000,
            });
            fullText += text.trim() + " ";
          }
        }
      }
    }

    if (segments.length === 0) {
      log.info("No transcript segments found", { videoId });
      return null;
    }

    log.info("Transcript extracted", { videoId, segments: segments.length });
    return { segments, fullText: fullText.trim() };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("Transcript extraction error", { videoId, error: msg });
    return null;
  } finally {
    // Clean up temp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Get video metadata (title, channel) using yt-dlp --dump-json.
 */
export async function getVideoMetadata(videoId: string): Promise<{ title: string; channelTitle: string } | null> {
  try {
    const proc = Bun.spawn(
      ["yt-dlp", "--dump-json", "--skip-download", `https://youtube.com/watch?v=${videoId}`],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
    );

    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;

    const data = JSON.parse(stdout) as { title?: string; channel?: string; uploader?: string };
    return {
      title: data.title ?? "Unknown Title",
      channelTitle: data.channel ?? data.uploader ?? "Unknown Channel",
    };
  } catch {
    return null;
  }
}
