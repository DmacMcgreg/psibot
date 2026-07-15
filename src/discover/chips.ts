import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../shared/logger.ts";
import { getItem, setChips, type DiscoverItem } from "./db.ts";

const log = createLogger("discover:chips");

export interface ReasonChips {
  pos: string[]; // reasons it might be interesting
  neg: string[]; // reasons it might not be
}

/** Always-available generic chips, shown alongside any agent-generated ones. */
export const GENERIC_CHIPS: ReasonChips = {
  pos: ["Exactly my interest", "Great source", "Want more like this", "Save for later"],
  neg: [
    "Not interested",
    "Don't care",
    "Not my genre",
    "Wrong topic",
    "Already know this",
    "Too long",
    "Low quality",
  ],
};

/**
 * Return per-item reason chips, generating + caching them on first access.
 * Cheap single-turn LLM call from the item's title + summary; on any failure
 * we return empty agent chips (the UI still shows the generic set).
 */
export async function getOrGenerateChips(atlasItemId: number): Promise<ReasonChips> {
  const item = getItem(atlasItemId);
  if (!item) return { pos: [], neg: [] };
  if (item.chips_json) {
    try {
      const parsed = JSON.parse(item.chips_json);
      if (parsed && Array.isArray(parsed.pos) && Array.isArray(parsed.neg)) return parsed;
    } catch { /* regenerate below */ }
  }
  const chips = await generate(item);
  try {
    setChips(atlasItemId, JSON.stringify(chips));
  } catch (err) {
    log.warn("Failed to cache chips", { atlasItemId, error: String(err) });
  }
  return chips;
}

async function generate(item: DiscoverItem): Promise<ReasonChips> {
  const body = (item.body ?? "").slice(0, 800);
  const prompt = `A user is triaging a saved item in their content digest and will mark it interesting or not. Suggest short, specific reason chips they could tap — grounded in THIS item, not generic.

TITLE: ${item.title}
${item.channel_title ? `SOURCE: ${item.channel_title}\n` : ""}SUMMARY: ${body}

Return ONLY JSON in a code block:
\`\`\`json
{
  "pos": ["2-3 reasons this could be worth their time (max 4 words each)"],
  "neg": ["2-3 reasons they might skip it (max 4 words each)"]
}
\`\`\``;

  let response = "";
  try {
    for await (const msg of query({ prompt, options: { maxTurns: 1 } })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((b: { type: string; text?: string }) => (b.type === "text" ? b.text : ""))
          .join("");
      }
    }
  } catch (err) {
    log.warn("Chip generation LLM call failed", { error: String(err) });
    return { pos: [], neg: [] };
  }

  const fence = response.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fence ? fence[1] : response;
  try {
    const parsed = JSON.parse(raw.trim());
    return {
      pos: Array.isArray(parsed?.pos) ? parsed.pos.slice(0, 4).map(String) : [],
      neg: Array.isArray(parsed?.neg) ? parsed.neg.slice(0, 4).map(String) : [],
    };
  } catch {
    log.warn("Could not parse chip JSON");
    return { pos: [], neg: [] };
  }
}
