/**
 * Loads knowledge/GOALS.md: David's money tracks, their weights and what counts
 * as a win. Every extractor, feed scorer and digest reads goals from here, so
 * editing that one file retargets the whole research system.
 */

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Track {
  id: string;
  weight: number;      // 0–3
  description: string; // the line under the heading
  wins: string;
  not: string;
}

export interface Goals {
  raw: string;
  tracks: Track[];
  mtimeMs: number;
}

export const GOALS_PATH = join(dirname(dirname(dirname(import.meta.path))), "knowledge/GOALS.md");

let cache: Goals | null = null;

export function parseGoals(raw: string): Track[] {
  const tracks: Track[] = [];
  const parts = raw.split(/^## track:\s*/m).slice(1);
  for (const part of parts) {
    const lines = part.split("\n");
    const id = lines[0].trim();
    if (!id) continue;
    const body = lines.slice(1).join("\n").split(/^## /m)[0];
    const weight = Number(body.match(/^weight:\s*(\d+(?:\.\d+)?)/m)?.[1] ?? 1);
    const description = body.split("\n").map((l) => l.trim()).find((l) => l && !/^weight:/.test(l) && !l.startsWith("-")) ?? "";
    const wins = body.match(/^- wins:\s*([\s\S]*?)(?=^- not:|$(?![\s\S]))/m)?.[1].replace(/\s+/g, " ").trim() ?? "";
    const not = body.match(/^- not:\s*([\s\S]*)/m)?.[1].replace(/\s+/g, " ").trim() ?? "";
    tracks.push({ id, weight, description, wins, not });
  }
  return tracks;
}

export function loadGoals(): Goals {
  const mtimeMs = statSync(GOALS_PATH).mtimeMs;
  if (cache && cache.mtimeMs === mtimeMs) return cache;
  const raw = readFileSync(GOALS_PATH, "utf-8");
  cache = { raw, tracks: parseGoals(raw), mtimeMs };
  return cache;
}

export function saveGoals(raw: string): Goals {
  const tracks = parseGoals(raw);
  if (tracks.length === 0) throw new Error("GOALS.md must keep at least one '## track: <id>' section");
  writeFileSync(GOALS_PATH, raw.endsWith("\n") ? raw : raw + "\n");
  cache = null;
  return loadGoals();
}

export function trackIds(): string[] {
  return loadGoals().tracks.map((t) => t.id);
}

export function trackWeight(id: string): number {
  return loadGoals().tracks.find((t) => t.id === id)?.weight ?? 1;
}

/** The goals file as a prompt block, for any model that scores or extracts. */
export function goalsPromptBlock(): string {
  return `<goals>\n${loadGoals().raw.trim()}\n</goals>`;
}
