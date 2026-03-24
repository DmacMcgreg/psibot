import { mkdirSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("youtube:transcript");

const STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const STT_CMD = "mlx_audio.stt.generate";

interface ParakeetSentence {
  text: string;
  start: number;
  end: number;
  duration: number;
}

interface ParakeetJson {
  text: string;
  sentences: ParakeetSentence[];
}

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

export interface TranscriptOptions {
  onProgress?: (message: string) => Promise<void>;
}

/**
 * Extract transcript from a YouTube video using yt-dlp.
 * Falls back to audio download + parakeet STT if no captions available.
 */
export async function extractTranscript(videoId: string, options?: TranscriptOptions): Promise<Transcript | null> {
  const notify = options?.onProgress ?? (async () => {});
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
      log.info("yt-dlp caption extraction failed, falling back to audio transcription", { videoId, exitCode, stderr: stderr.slice(0, 500) });
      await notify("No captions available, downloading audio for local transcription (parakeet)...");
      return extractTranscriptViaAudio(videoId, notify);
    }

    // Find the .json3 subtitle file
    const files = readdirSync(tmpDir);
    const jsonFile = files.find(f => f.endsWith(".json3"));

    if (!jsonFile) {
      log.info("No captions found, falling back to audio transcription", { videoId });
      await notify("No captions available, downloading audio for local transcription (parakeet)...");
      return extractTranscriptViaAudio(videoId, notify);
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
      log.info("No transcript segments in captions, falling back to audio transcription", { videoId });
      await notify("Captions empty, downloading audio for local transcription (parakeet)...");
      return extractTranscriptViaAudio(videoId, notify);
    }

    log.info("Transcript extracted", { videoId, segments: segments.length });
    return { segments, fullText: fullText.trim() };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("Caption extraction error, falling back to audio transcription", { videoId, error: msg });
    try {
      await notify("Caption extraction error, trying audio transcription (parakeet)...");
      return await extractTranscriptViaAudio(videoId, notify);
    } catch (audioError) {
      const audioMsg = audioError instanceof Error ? audioError.message : String(audioError);
      log.error("Audio transcription fallback also failed", { videoId, error: audioMsg });
      return null;
    }
  } finally {
    // Clean up temp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

/**
 * Fallback: download audio via yt-dlp and transcribe with parakeet STT.
 * Returns timestamped segments from parakeet's sentence-level output.
 */
async function extractTranscriptViaAudio(videoId: string, notify?: (message: string) => Promise<void>): Promise<Transcript | null> {
  const progress = notify ?? (async () => {});
  const tmpDir = join(tmpdir(), `psi-audio-${videoId}-${Date.now()}`);

  try {
    mkdirSync(tmpDir, { recursive: true });

    // Download audio as mp3
    log.info("Downloading audio for transcription", { videoId });
    await progress("Downloading audio...");
    const dlProc = Bun.spawn(
      [
        "yt-dlp",
        "-f", "bestaudio",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "128K",
        "-o", `${videoId}.%(ext)s`,
        `https://youtube.com/watch?v=${videoId}`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: tmpDir,
        env: { ...process.env },
      }
    );

    const [, dlStderr] = await Promise.all([
      new Response(dlProc.stdout).text(),
      new Response(dlProc.stderr).text(),
    ]);

    const dlExit = await dlProc.exited;
    if (dlExit !== 0) {
      log.error("Audio download failed", { videoId, exitCode: dlExit, stderr: dlStderr.slice(0, 500) });
      return null;
    }

    // Find the mp3 file
    const files = readdirSync(tmpDir);
    const audioFile = files.find(f => f.endsWith(".mp3"));
    if (!audioFile) {
      log.error("No mp3 file found after download", { videoId, files });
      return null;
    }

    const audioPath = join(tmpDir, audioFile);
    const outputBase = join(tmpDir, `${videoId}-stt`);

    // Transcribe with parakeet
    log.info("Transcribing audio with parakeet", { videoId, audioPath });
    await progress("Audio downloaded, transcribing with parakeet STT...");
    const sttProc = Bun.spawn(
      [STT_CMD, "--model", STT_MODEL, "--audio", audioPath, "--output-path", outputBase, "--format", "json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      }
    );

    const [, sttStderr] = await Promise.all([
      new Response(sttProc.stdout).text(),
      new Response(sttProc.stderr).text(),
    ]);

    const sttExit = await sttProc.exited;
    if (sttExit !== 0) {
      log.error("Parakeet transcription failed", { videoId, exitCode: sttExit, stderr: sttStderr.slice(0, 500) });
      return null;
    }

    // Read JSON output
    const jsonPath = `${outputBase}.json`;
    if (!existsSync(jsonPath)) {
      log.error("Parakeet JSON output not found", { videoId, expected: jsonPath });
      return null;
    }

    const rawJson = readFileSync(jsonPath, "utf-8");
    const parakeetData = JSON.parse(rawJson) as ParakeetJson;

    if (!parakeetData.sentences || parakeetData.sentences.length === 0) {
      log.info("Parakeet produced no sentences", { videoId });
      if (parakeetData.text?.trim()) {
        // Full text available but no sentence segmentation -- wrap as single segment
        return {
          segments: [{ text: parakeetData.text.trim(), start: 0, duration: 0 }],
          fullText: parakeetData.text.trim(),
        };
      }
      return null;
    }

    const segments: TranscriptSegment[] = parakeetData.sentences.map(s => ({
      text: s.text.trim(),
      start: s.start,
      duration: s.duration,
    }));

    const fullText = segments.map(s => s.text).join(" ");

    log.info("Audio transcript extracted via parakeet", { videoId, segments: segments.length, textLength: fullText.length });
    return { segments, fullText };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error("Audio transcription fallback error", { videoId, error: msg });
    return null;
  } finally {
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
