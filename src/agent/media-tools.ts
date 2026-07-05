import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("media-tools");

const DATA_DIR = resolve(process.cwd(), "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const AUDIO_DIR = join(DATA_DIR, "audio");

const STT_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const STT_CMD = "mlx_audio.stt.generate";
const TTS_CMD = "edge-tts";
const TTS_VOICE = "en-GB-SoniaNeural";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_AUTH_CANDIDATES = [
  process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : null,
  process.env.CHATGPT_LOCAL_HOME ? join(process.env.CHATGPT_LOCAL_HOME, "auth.json") : null,
  join(process.env.HOME ?? "", ".codex", "auth.json"),
  join(process.env.HOME ?? "", ".chatgpt-local", "auth.json"),
].filter(Boolean) as string[];

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

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

let cachedGeminiKey: string | null = null;

function getGeminiApiKey(): string {
  if (!cachedGeminiKey) {
    cachedGeminiKey = loadGeminiApiKey();
  }
  return cachedGeminiKey;
}

// --- Codex OAuth Auth ---

type CodexAuth = {
  accessToken: string;
  accountId: string;
  refreshToken: string;
  authFilePath: string;
};

let cachedCodexAuth: CodexAuth | null = null;
let lastRefreshTime = 0;

function findAuthFile(): string | null {
  for (const candidate of CODEX_AUTH_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseJwtExp(token: string): number {
  try {
    const payload = token.split(".")[1];
    const padded = payload + "=".repeat(4 - (payload.length % 4));
    const claims = JSON.parse(Buffer.from(padded, "base64url").toString());
    return claims.exp ?? 0;
  } catch {
    return 0;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string } | null> {
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
        scope: "openid profile email offline_access",
      }),
    });
    if (!response.ok) {
      log.error("OAuth token refresh failed", { status: response.status });
      return null;
    }
    const data = (await response.json()) as { access_token: string; refresh_token: string };
    return data;
  } catch (err) {
    log.error("OAuth token refresh error", { error: String(err) });
    return null;
  }
}

async function loadCodexAuth(): Promise<CodexAuth | null> {
  const now = Math.floor(Date.now() / 1000);

  // Return cached if token not expired (5 min buffer)
  if (cachedCodexAuth) {
    const exp = parseJwtExp(cachedCodexAuth.accessToken);
    if (exp > now + 300 && Date.now() - lastRefreshTime < 55 * 60 * 1000) {
      return cachedCodexAuth;
    }
  }

  const authFilePath = findAuthFile();
  if (!authFilePath) {
    log.error("No Codex auth file found", { candidates: CODEX_AUTH_CANDIDATES });
    return null;
  }

  try {
    const raw = readFileSync(authFilePath, "utf-8");
    const data = JSON.parse(raw) as {
      tokens: { access_token: string; refresh_token: string; account_id: string };
    };

    let accessToken = data.tokens.access_token;
    let refreshToken = data.tokens.refresh_token;
    const accountId = data.tokens.account_id;

    // Check if token needs refresh
    const exp = parseJwtExp(accessToken);
    if (exp <= now + 300) {
      log.info("Codex access token expired or expiring, refreshing...");
      const refreshed = await refreshAccessToken(refreshToken);
      if (refreshed) {
        accessToken = refreshed.access_token;
        refreshToken = refreshed.refresh_token;
        // Write back to auth file
        data.tokens.access_token = accessToken;
        data.tokens.refresh_token = refreshToken;
        writeFileSync(authFilePath, JSON.stringify(data, null, 2));
        log.info("Codex auth tokens refreshed and saved");
      } else {
        log.error("Failed to refresh Codex auth token");
        return null;
      }
    }

    cachedCodexAuth = { accessToken, accountId, refreshToken, authFilePath };
    lastRefreshTime = Date.now();
    return cachedCodexAuth;
  } catch (err) {
    log.error("Failed to load Codex auth", { error: String(err), path: authFilePath });
    return null;
  }
}

// --- Image Generation ---

// Codex OAuth image_generation tool uses the Responses API with gpt-5.2
// which has the image_generation tool built in. This is FREE via ChatGPT account.
const CODEX_IMAGE_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "4:5": "1024x1280",
  "3:4": "768x1024",
  "2:3": "768x1152",
  "9:16": "720x1280",
  "5:4": "1280x1024",
  "4:3": "1024x768",
  "3:2": "1152x768",
  "16:9": "1280x720",
};

// gpt-image-2 accepts any size if all constraints are met:
// - max edge <= 3840, both edges multiples of 16, long:short <= 3:1,
// - 655,360 <= total pixels <= 8,294,400.
const OPENAI_SIZE_BY_RATIO: Record<string, string> = {
  "1:1": "2048x2048",
  "4:5": "1600x2000",
  "3:4": "1536x2048",
  "2:3": "1536x2304",
  "5:8": "1440x2304",
  "9:16": "1440x2560",
  "9:21": "1152x2688",
  "5:4": "2000x1600",
  "4:3": "2048x1536",
  "3:2": "2304x1536",
  "8:5": "2304x1440",
  "16:9": "2560x1440",
  "21:9": "2688x1152",
};

function aspectRatioToOpenaiSize(aspectRatio: string | undefined): string {
  if (!aspectRatio) return "auto";
  const ratio = aspectRatio.trim();
  return OPENAI_SIZE_BY_RATIO[ratio] ?? "auto";
}

type ImageQuality = "low" | "medium" | "high" | "auto";

type ImageGenArgs = {
  prompt: string;
  image_paths?: string[];
  aspect_ratio?: string;
  quality?: ImageQuality;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function generateWithCodexOAuth(args: ImageGenArgs, outputPath: string): Promise<ToolResult> {
  const auth = await loadCodexAuth();
  if (!auth) {
    return {
      content: [{ type: "text" as const, text: "Codex OAuth auth not available. Run 'npx @openai/codex login' to authenticate." }],
      isError: true,
    };
  }

  const quality: ImageQuality = args.quality ?? "auto";
  const size = args.aspect_ratio ? (CODEX_IMAGE_SIZES[args.aspect_ratio] ?? "auto") : "auto";

  log.info("Generating image via Codex OAuth (free)", {
    prompt: args.prompt.slice(0, 100),
    quality,
    size,
  });

  // Build the image_generation tool config
  const imageGenTool: Record<string, unknown> = { type: "image_generation" };
  if (quality !== "auto") (imageGenTool as Record<string, unknown>).quality = quality;
  if (size !== "auto") (imageGenTool as Record<string, unknown>).size = size;

  const requestBody = {
    model: "gpt-5.2",
    instructions: "Generate the requested image using the image_generation tool. Do not output any text.",
    input: [{ role: "user", content: args.prompt }],
    tools: [imageGenTool],
    store: false,
    stream: true,
  };

  const response = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${auth.accessToken}`,
      "chatgpt-account-id": auth.accountId,
      "OpenAI-Beta": "responses=experimental",
      "Content-Type": "application/json",
      "User-Agent": "codex-cli/0.77.0",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log.error("Codex OAuth image error", { status: response.status, error: errorText.slice(0, 500) });

    // If 401/403, invalidate cache so next attempt re-reads auth
    if (response.status === 401 || response.status === 403) {
      cachedCodexAuth = null;
    }

    return {
      content: [{ type: "text" as const, text: `Codex OAuth image generation failed: ${response.status} - ${errorText.slice(0, 300)}` }],
      isError: true,
    };
  }

  // Parse SSE stream to extract image
  const text = await response.text();
  const lines = text.split("\n");
  let imageB64: string | null = null;

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const eventData = line.slice(6);
    try {
      const event = JSON.parse(eventData) as {
        type?: string;
        item?: { type?: string; result?: string };
      };

      // The image comes in response.output_item.done with type=image_generation_call
      if (
        event.type === "response.output_item.done" &&
        event.item?.type === "image_generation_call" &&
        event.item?.result
      ) {
        imageB64 = event.item.result;
        break;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  if (!imageB64) {
    log.error("Codex OAuth: no image in response stream");
    return {
      content: [{ type: "text" as const, text: "Image generation completed but no image data was returned." }],
      isError: true,
    };
  }

  const imageBuffer = Buffer.from(imageB64, "base64");
  await Bun.write(outputPath, imageBuffer);

  log.info("Image generated (codex-oauth, free)", { outputPath, sizeBytes: imageBuffer.length });
  return {
    content: [{ type: "text" as const, text: `Image saved to: ${outputPath}` }],
  };
}

async function generateWithOpenAI(args: ImageGenArgs, outputPath: string): Promise<ToolResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      content: [{ type: "text" as const, text: "No OPENAI_API_KEY set. Cannot use paid OpenAI API for image edits." }],
      isError: true,
    };
  }

  const size = aspectRatioToOpenaiSize(args.aspect_ratio);
  const quality: ImageQuality = args.quality ?? "auto";
  const hasInputImages = args.image_paths && args.image_paths.length > 0;

  log.info("Generating image via OpenAI API (paid)", {
    prompt: args.prompt.slice(0, 100),
    inputImages: args.image_paths?.length ?? 0,
    size,
    quality,
    endpoint: hasInputImages ? "edits" : "generations",
  });

  let response: Response;

  if (hasInputImages) {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", args.prompt);
    if (size !== "auto") form.append("size", size);
    if (quality !== "auto") form.append("quality", quality);

    for (const imagePath of args.image_paths!) {
      if (!existsSync(imagePath)) {
        return {
          content: [{ type: "text" as const, text: `Input image not found: ${imagePath}` }],
          isError: true,
        };
      }
      const bytes = readFileSync(imagePath);
      const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeType = MIME_TYPES[ext] ?? "image/png";
      const filename = imagePath.split("/").pop() ?? `image.${ext}`;
      form.append("image[]", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    }

    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-image-2",
        prompt: args.prompt,
        n: 1,
        size,
        ...(quality !== "auto" ? { quality } : {}),
      }),
    });
  }

  if (!response.ok) {
    const errorText = await response.text();
    log.error("OpenAI image API error", { status: response.status, error: errorText.slice(0, 500) });
    return {
      content: [{ type: "text" as const, text: `Image generation failed: ${response.status} - ${errorText.slice(0, 300)}` }],
      isError: true,
    };
  }

  const data = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) {
    return {
      content: [{ type: "text" as const, text: "OpenAI image generation returned no image data." }],
      isError: true,
    };
  }

  const imageBuffer = Buffer.from(b64, "base64");
  await Bun.write(outputPath, imageBuffer);

  log.info("Image generated (openai-paid)", { outputPath, sizeBytes: imageBuffer.length });
  return {
    content: [{ type: "text" as const, text: `Image saved to: ${outputPath}` }],
  };
}

async function generateWithGemini(args: ImageGenArgs, outputPath: string): Promise<ToolResult> {
  const apiKey = getGeminiApiKey();

  log.info("Generating image via Gemini", {
    prompt: args.prompt.slice(0, 100),
    inputImages: args.image_paths?.length ?? 0,
  });

  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [
    { text: args.prompt },
  ];

  if (args.image_paths) {
    for (const imagePath of args.image_paths) {
      if (!existsSync(imagePath)) {
        return {
          content: [{ type: "text" as const, text: `Input image not found: ${imagePath}` }],
          isError: true,
        };
      }
      const imageBytes = readFileSync(imagePath);
      const base64Data = Buffer.from(imageBytes).toString("base64");
      const ext = imagePath.split(".").pop()?.toLowerCase() ?? "png";
      const mimeType = MIME_TYPES[ext] ?? "image/png";
      parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
    }
  }

  const imageConfig: Record<string, string> = {};
  if (args.aspect_ratio) imageConfig.aspectRatio = args.aspect_ratio;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
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
      content?: { parts?: Array<{ inlineData?: { mimeType: string; data: string } }> };
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

  log.info("Image generated (gemini)", { outputPath, sizeBytes: imageBuffer.length });
  return {
    content: [{ type: "text" as const, text: `Image saved to: ${outputPath}` }],
  };
}

export function createMediaTools() {
  return createSdkMcpServer({
    name: "media-tools",
    version: "1.0.0",
    tools: [
      tool(
        "image_generate",
        "Generate or edit images. Defaults to Codex OAuth (FREE, uses ChatGPT account via gpt-5.2 + image_generation tool). For image editing with input images, uses paid OpenAI API (gpt-image-2). Set provider='gemini' to use Gemini 3 Pro. Returns the file path to the saved PNG image.",
        {
          prompt: z.string().describe("Text prompt describing the image to generate or the edit to apply"),
          image_paths: z.array(z.string()).optional().describe("Absolute paths to input images for editing or inspiration. When provided, uses paid OpenAI API (edits endpoint)."),
          aspect_ratio: z
            .enum([
              "1:1",
              "4:5",
              "3:4",
              "2:3",
              "5:8",
              "9:16",
              "9:21",
              "5:4",
              "4:3",
              "3:2",
              "8:5",
              "16:9",
              "21:9",
            ])
            .optional()
            .describe(
              "Aspect ratio for the generated image."
            ),
          quality: z
            .enum(["low", "medium", "high", "auto"])
            .optional()
            .describe(
              "Rendering quality. 'low' is fastest, 'high' is best. Default: 'auto'."
            ),
          provider: z.enum(["openai", "gemini"]).optional().describe("Image model provider. Defaults to Codex OAuth (free). Set 'openai' for paid API (higher res, edits), 'gemini' for Gemini 3 Pro."),
        },
        async (args) => {
          ensureDir(IMAGES_DIR);
          const timestamp = Date.now();
          const outputPath = join(IMAGES_DIR, `${timestamp}.png`);
          const hasInputImages = args.image_paths && args.image_paths.length > 0;

          // Route: gemini if explicitly requested
          if (args.provider === "gemini") {
            return generateWithGemini(args, outputPath);
          }

          // Route: paid OpenAI if explicitly requested OR if input images provided (edits)
          if (args.provider === "openai" || hasInputImages) {
            return generateWithOpenAI(args, outputPath);
          }

          // Default: Codex OAuth (free)
          return generateWithCodexOAuth(args, outputPath);
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
        "Generate speech audio from text using Edge TTS (Microsoft neural voices). Returns the file path to the generated MP3 audio.",
        {
          text: z.string().describe("Text to convert to speech"),
          name: z.string().optional().describe("Short descriptive name for the audio file (e.g. 'article', 'summary', 'greeting'). Will be formatted as psi-<name>-YYYY-MM-DD.mp3"),
          rate: z.string().optional().describe("Speech rate adjustment (e.g. '+10%', '-20%', '+0%'). Default: '+0%'"),
        },
        async (args) => {
          const ttsOutputDir = join(AUDIO_DIR, "tts");
          ensureDir(ttsOutputDir);

          const date = new Date().toISOString().slice(0, 10);
          const slug = args.name ? args.name.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase() : "audio";
          const outputPath = join(ttsOutputDir, `psi-${slug}-${date}.mp3`);

          log.info("Generating TTS", { textLength: args.text.length, voice: TTS_VOICE });

          try {
            const cmdArgs = [TTS_CMD, "-t", args.text, "-v", TTS_VOICE, "--write-media", outputPath];
            if (args.rate) {
              cmdArgs.push("--rate", args.rate);
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
              log.error("Edge TTS failed", { exitCode, stderr: stderr.slice(0, 500) });
              return {
                content: [{ type: "text" as const, text: `TTS failed (exit ${exitCode}): ${stderr.slice(0, 500)}` }],
                isError: true,
              };
            }

            if (!existsSync(outputPath)) {
              return {
                content: [{ type: "text" as const, text: `TTS completed but output file not found at ${outputPath}` }],
                isError: true,
              };
            }

            log.info("TTS complete", { outputPath });
            return {
              content: [{ type: "text" as const, text: `Audio saved to: ${outputPath}` }],
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
