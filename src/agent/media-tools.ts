import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("media-tools");

const DATA_DIR = resolve(process.cwd(), "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const AUDIO_DIR = join(DATA_DIR, "audio");

const STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const TTS_MODEL = "mlx-community/Soprano-80M-bf16";
const TTS_VOICE = "sonia";
const STT_CMD = "mlx_audio.stt.generate";
const TTS_CMD = "mlx_audio.tts.generate";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadGeminiApiKey(): string {
  const envKey = process.env.GEMINI_API_KEY;
  if (envKey) return envKey;

  const configPath = join(process.env.HOME ?? "", ".openclaw", "openclaw.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as {
      skills?: { entries?: { "nano-banana-pro"?: { apiKey?: string } } };
    };
    const key = config.skills?.entries?.["nano-banana-pro"]?.apiKey;
    if (key) return key;
  } catch {
    // fall through
  }

  throw new Error("No Gemini API key found. Set GEMINI_API_KEY env var or configure ~/.openclaw/openclaw.json");
}

let cachedApiKey: string | null = null;

function getGeminiApiKey(): string {
  if (!cachedApiKey) {
    cachedApiKey = loadGeminiApiKey();
  }
  return cachedApiKey;
}

export function createMediaTools() {
  return createSdkMcpServer({
    name: "media-tools",
    version: "1.0.0",
    tools: [
      tool(
        "image_generate",
        "Generate an image using the Gemini API. Returns the file path to the saved PNG image.",
        {
          prompt: z.string().describe("Text prompt describing the image to generate"),
          aspect_ratio: z.string().optional().describe("Aspect ratio. Supported: 1:1 (default), 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9"),
        },
        async (args) => {
          ensureDir(IMAGES_DIR);

          const apiKey = getGeminiApiKey();
          const timestamp = Date.now();
          const outputPath = join(IMAGES_DIR, `${timestamp}.png`);

          log.info("Generating image", { prompt: args.prompt.slice(0, 100) });

          const imageConfig: Record<string, string> = {};
          if (args.aspect_ratio) {
            imageConfig.aspectRatio = args.aspect_ratio;
          }

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [{ text: args.prompt }],
                  },
                ],
                generationConfig: {
                  responseModalities: ["TEXT", "IMAGE"],
                  ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
                },
              }),
            }
          );

          if (!response.ok) {
            const errorText = await response.text();
            log.error("Gemini API error", { status: response.status, error: errorText.slice(0, 500) });
            return {
              content: [{ type: "text" as const, text: `Image generation failed: ${response.status} - ${errorText.slice(0, 200)}` }],
              isError: true,
            };
          }

          const data = (await response.json()) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
              };
            }>;
          };

          const part = data.candidates?.[0]?.content?.parts?.find(
            (p) => p.inlineData?.mimeType?.startsWith("image/")
          );

          if (!part?.inlineData?.data) {
            return {
              content: [{ type: "text" as const, text: "Image generation returned no image data." }],
              isError: true,
            };
          }

          const imageBuffer = Buffer.from(part.inlineData.data, "base64");
          await Bun.write(outputPath, imageBuffer);

          log.info("Image generated", { outputPath, sizeBytes: imageBuffer.length });
          return {
            content: [{ type: "text" as const, text: `Image saved to: ${outputPath}` }],
          };
        }
      ),

      tool(
        "audio_transcribe",
        "Transcribe an audio file to text using mlx-audio parakeet (local Apple Silicon STT). Supports wav, mp3, ogg, m4a, flac formats.",
        {
          audio_path: z.string().describe("Absolute path to the audio file to transcribe"),
          output_format: z.enum(["txt", "json", "srt", "vtt"]).optional().describe("Output format (default: 'txt')"),
        },
        async (args) => {
          if (!existsSync(args.audio_path)) {
            return {
              content: [{ type: "text" as const, text: `Audio file not found: ${args.audio_path}` }],
              isError: true,
            };
          }

          const format = args.output_format ?? "txt";
          const timestamp = Date.now();
          const sttOutputDir = join(DATA_DIR, "stt");
          ensureDir(sttOutputDir);
          const outputBase = join(sttOutputDir, `${timestamp}`);

          log.info("Transcribing audio", { path: args.audio_path, format, model: STT_MODEL });

          try {
            const proc = Bun.spawn(
              [STT_CMD, "--model", STT_MODEL, "--audio", args.audio_path, "--output", outputBase, "--format", format],
              {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env },
              }
            );

            const [stdout, stderr] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]);

            const exitCode = await proc.exited;

            if (exitCode !== 0) {
              log.error("Transcription failed", { exitCode, stderr: stderr.slice(0, 500) });
              return {
                content: [{ type: "text" as const, text: `Transcription failed (exit ${exitCode}): ${stderr.slice(0, 500)}` }],
                isError: true,
              };
            }

            const outputFile = `${outputBase}.${format}`;
            let transcription = stdout.trim();
            if (existsSync(outputFile)) {
              transcription = readFileSync(outputFile, "utf-8").trim();
            }

            log.info("Transcription complete", { outputLength: transcription.length });
            return {
              content: [{ type: "text" as const, text: transcription }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `Transcription error: ${message}` }],
              isError: true,
            };
          }
        }
      ),

      tool(
        "tts_generate",
        "Generate speech audio from text using Soprano (local MLX TTS on Apple Silicon). Returns the file path to the generated WAV audio.",
        {
          text: z.string().describe("Text to convert to speech"),
          speed: z.number().optional().describe("Speech speed multiplier (default: 1.0)"),
        },
        async (args) => {
          const ttsOutputDir = join(AUDIO_DIR, "tts");
          ensureDir(ttsOutputDir);

          const timestamp = Date.now();
          const filePrefix = join(ttsOutputDir, `${timestamp}`);
          const expectedOutput = `${filePrefix}_000.wav`;

          const cleanText = args.text.replace(/\\/g, "");

          log.info("Generating TTS", { textLength: cleanText.length, model: TTS_MODEL, voice: TTS_VOICE });

          try {
            const cmdArgs = [TTS_CMD, "--model", TTS_MODEL, "--text", cleanText, "--voice", TTS_VOICE, "--file_prefix", filePrefix];
            if (args.speed !== undefined) {
              cmdArgs.push("--speed", String(args.speed));
            }

            const proc = Bun.spawn(cmdArgs, {
              stdout: "pipe",
              stderr: "pipe",
              env: { ...process.env },
            });

            const [, stderr] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]);

            const exitCode = await proc.exited;

            if (exitCode !== 0) {
              log.error("Soprano TTS failed", { exitCode, stderr: stderr.slice(0, 500) });
              return {
                content: [{ type: "text" as const, text: `TTS failed (exit ${exitCode}): ${stderr.slice(0, 500)}` }],
                isError: true,
              };
            }

            if (!existsSync(expectedOutput)) {
              return {
                content: [{ type: "text" as const, text: `TTS completed but output file not found at ${expectedOutput}` }],
                isError: true,
              };
            }

            log.info("TTS complete", { outputPath: expectedOutput });
            return {
              content: [{ type: "text" as const, text: `Audio saved to: ${expectedOutput}` }],
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              content: [{ type: "text" as const, text: `TTS error: ${message}` }],
              isError: true,
            };
          }
        }
      ),
    ],
  });
}
