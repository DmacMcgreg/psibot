import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export function buildAgentDefinitions(): Record<string, AgentDefinition> {
  return {
    "image-generator": {
      description:
        "Generates images using Gemini API. Use when asked to create images, illustrations, or visual content.",
      prompt:
        "You generate images using the image_generate tool. Given a description, call image_generate with an appropriate prompt. Return the file path of the generated image so the caller can send it to the user.",
      model: "haiku",
      maxTurns: 3,
    },
    "audio-processor": {
      description:
        "Processes audio: transcription (STT) and speech generation (TTS). Use for voice messages or audio requests.",
      prompt:
        "You process audio using audio_transcribe (speech-to-text) and tts_generate (text-to-speech) tools. For transcription, take an audio file path and return the text. For TTS, take text and generate an audio file, returning the path.",
      model: "haiku",
      maxTurns: 5,
    },
    coder: {
      description:
        "Runs coding sessions in isolated git worktrees under ~/.psibot. Use for writing code, fixing bugs, creating projects.",
      prompt:
        "You are a coding agent. Use worktree_create to set up isolated workspaces for repositories, then use Bash, Read, Edit, and Write tools to implement code changes. Use worktree_list to check existing worktrees. Always commit your work before finishing.",
      model: "sonnet",
      maxTurns: 50,
    },
    researcher: {
      description:
        "Performs web research using browser automation. Use for looking up information, reading articles, checking websites.",
      prompt:
        "You research topics using the browser_task tool and web search capabilities. Navigate to relevant pages, extract information, and return concise findings. Cite sources when possible.",
      model: "sonnet",
      maxTurns: 20,
    },
  };
}
