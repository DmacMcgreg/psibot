import { describe, it, expect } from "bun:test";
import {
  analyzeTranscript,
  parseAnalysisResponse,
  buildAnalysisPrompt,
  AnalysisFailedError,
  STRICT_RETRY_SUFFIX,
} from "./analyzer.ts";
import type { Transcript } from "./transcript.ts";

const transcript = {
  segments: [
    { start: 0, duration: 5, text: "Today we cut drone footage with ffmpeg." },
    { start: 65, duration: 5, text: "Use a speed ramp with setpts on the reveal." },
  ],
  fullText: "Today we cut drone footage with ffmpeg. Use a speed ramp with setpts on the reveal.",
} as unknown as Transcript;

const good = JSON.stringify({
  markdown_summary: "## Overview\nThe video shows how to cut drone footage with ffmpeg.\n\n## Key Points\n- [00:01:05] Speed ramps use setpts.",
  tags: ["drone-editing"],
  themes: [{ id: "t1", name: "ffmpeg drone editing", summary: "Cutting aerials with ffmpeg." }],
  key_topics: [{ timestamp: "00:01:05", topic: "Speed ramps", theme_id: "t1", summary: "setpts ramps." }],
  insights: [{ timestamp: "00:01:05", insight: "Speed ramps are built with setpts.", theme_id: "t1" }],
  quotes: [],
});

describe("parseAnalysisResponse", () => {
  it("parses a fenced JSON reply", () => {
    const p = parseAnalysisResponse("```json\n" + good + "\n```");
    expect(p.themes[0].name).toBe("ffmpeg drone editing");
    expect(p.tags).toEqual(["drone-editing"]);
  });

  it("rejects prose, broken JSON and empty summaries", () => {
    expect(() => parseAnalysisResponse("Not logged in · Please run /login")).toThrow();
    expect(() => parseAnalysisResponse('```json\n{"markdown_summary": "## Overview\nunterminated\n```')).toThrow();
    expect(() => parseAnalysisResponse('{"markdown_summary": "", "tags": []}')).toThrow();
  });

  it("defaults missing arrays instead of crashing downstream", () => {
    const p = parseAnalysisResponse(JSON.stringify({ markdown_summary: "## Overview\nA factual overview that is long enough." }));
    expect(p.themes).toEqual([]);
    expect(p.insights).toEqual([]);
  });
});

describe("analyzeTranscript", () => {
  it("retries once with a stricter prompt, then succeeds", async () => {
    const prompts: string[] = [];
    const replies = ["Sorry, here is a summary: {broken", good];
    const out = await analyzeTranscript(transcript, "Drone edit", {
      ask: async (p) => { prompts.push(p); return replies.shift()!; },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1].endsWith(STRICT_RETRY_SUFFIX)).toBe(true);
    expect(out.markdown_summary).toContain("ffmpeg");
  });

  it("throws AnalysisFailedError after the retry fails — no fallback placeholder", async () => {
    let calls = 0;
    const run = analyzeTranscript(transcript, "Drone edit", {
      ask: async () => { calls++; return "You've hit your weekly limit"; },
    });
    await expect(run).rejects.toBeInstanceOf(AnalysisFailedError);
    expect(calls).toBe(2);
  });

  it("treats a thrown model call like a bad reply", async () => {
    let calls = 0;
    const run = analyzeTranscript(transcript, "Drone edit", {
      ask: async () => { calls++; throw new Error("Not logged in"); },
    });
    await expect(run).rejects.toThrow(/analysis_failed/);
    expect(calls).toBe(2);
  });
});

describe("buildAnalysisPrompt", () => {
  it("asks for facts, not imperative advice", () => {
    const p = buildAnalysisPrompt(transcript, "Drone edit");
    expect(p).not.toContain("Actionable Insights");
    expect(p).not.toContain("imperative");
    expect(p).toContain("## Key Points");
    expect(p).toContain("[00:01:05] Use a speed ramp");
  });
});
