import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("media-tools");

const DATA_DIR = resolve(process.cwd(), "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const AUDIO_DIR = join(DATA_DIR, "audio");

const PARAKEET_PATH = "/Users/davidmcgregor/.local/bin/parakeet-mlx";
const CHATTERBOX_PATH = "/Users/davidmcgregor/Documents/2_Code/chatterbox-2025-12-23-mlx/.venv/bin/mlx_audio.tts.generate";

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
          aspect_ratio: z.string().optional().describe("Aspect ratio (e.g. '16:9', '1:1', '4:3'). Default: '1:1'"),
        },
        async (args) => {
          ensureDir(IMAGES_DIR);

          const apiKey = getGeminiApiKey();
          const timestamp = Date.now();
          const outputPath = join(IMAGES_DIR, `${timestamp}.png`);

          log.info("Generating image", { prompt: args.prompt.slice(0, 100) });

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
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
                  responseModalities: ["IMAGE"],
                  ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}),
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
        "Transcribe an audio file to text using parakeet-mlx (local Apple Silicon STT). Supports wav, mp3, ogg, m4a, flac formats.",
        {
          audio_path: z.string().describe("Absolute path to the audio file to transcribe"),
          output_format: z.enum(["txt", "json", "srt"]).optional().describe("Output format (default: 'txt')"),
        },
        async (args) => {
          if (!existsSync(args.audio_path)) {
            return {
              content: [{ type: "text" as const, text: `Audio file not found: ${args.audio_path}` }],
              isError: true,
            };
          }

          const format = args.output_format ?? "txt";
          log.info("Transcribing audio", { path: args.audio_path, format });

          try {
            const proc = Bun.spawn(
              [PARAKEET_PATH, args.audio_path, "--output-format", format],
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

            log.info("Transcription complete", { outputLength: stdout.length });
            return {
              content: [{ type: "text" as const, text: stdout.trim() }],
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
        "Generate speech audio from text. Uses chatterbox (local MLX) for short text or edge-tts (Microsoft cloud) for longer text. Returns the file path to the generated audio.",
        {
          text: z.string().describe("Text to convert to speech"),
          engine: z.enum(["chatterbox", "edge"]).optional().describe("TTS engine. Default: 'chatterbox' for short text (<500 chars), 'edge' for longer text"),
          voice: z.string().optional().describe("Voice name (edge-tts only, e.g. 'en-US-AriaNeural'). Ignored for chatterbox."),
        },
        async (args) => {
          ensureDir(AUDIO_DIR);

          const engine = args.engine ?? (args.text.length > 500 ? "edge" : "chatterbox");
          const timestamp = Date.now();

          log.info("Generating TTS", { engine, textLength: args.text.length });

          if (engine === "chatterbox") {
            const outputPath = join(AUDIO_DIR, `${timestamp}.wav`);

            try {
              const proc = Bun.spawn(
                [CHATTERBOX_PATH, "--text", args.text, "--output", outputPath],
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
                log.error("Chatterbox TTS failed", { exitCode, stderr: stderr.slice(0, 500) });
                return {
                  content: [{ type: "text" as const, text: `Chatterbox TTS failed (exit ${exitCode}): ${stderr.slice(0, 500)}` }],
                  isError: true,
                };
              }

              log.info("Chatterbox TTS complete", { outputPath });
              return {
                content: [{ type: "text" as const, text: `Audio saved to: ${outputPath}` }],
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [{ type: "text" as const, text: `Chatterbox TTS error: ${message}` }],
                isError: true,
              };
            }
          } else {
            const outputPath = join(AUDIO_DIR, `${timestamp}.mp3`);
            const voice = args.voice ?? "en-US-AriaNeural";

            try {
              const proc = Bun.spawn(
                ["edge-tts", "--text", args.text, "--write-media", outputPath, "--voice", voice],
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
                log.error("Edge TTS failed", { exitCode, stderr: stderr.slice(0, 500) });
                return {
                  content: [{ type: "text" as const, text: `Edge TTS failed (exit ${exitCode}): ${stderr.slice(0, 500)}` }],
                  isError: true,
                };
              }

              log.info("Edge TTS complete", { outputPath, voice });
              return {
                content: [{ type: "text" as const, text: `Audio saved to: ${outputPath}` }],
              };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              return {
                content: [{ type: "text" as const, text: `Edge TTS error: ${message}` }],
                isError: true,
              };
            }
          }
        }
      ),
    ],
  });
}
