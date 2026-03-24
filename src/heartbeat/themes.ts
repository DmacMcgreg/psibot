import { query } from "@anthropic-ai/claude-agent-sdk";
import { getConfig } from "../config.ts";
import { createLogger } from "../shared/logger.ts";
import {
  getPendingItems,
  getThemes,
  getThemeByName,
  createTheme,
  addThemeItem,
  updateTheme,
  updatePendingItem,
} from "../db/queries.ts";
import type { PendingItem, Theme } from "../shared/types.ts";

const log = createLogger("heartbeat:themes");

interface ClusterProposal {
  theme_name: string;
  item_ids: number[];
  description: string;
}

/**
 * Detect thematic clusters among recently triaged items.
 * Compares new items against each other and existing themes.
 * Uses GLM to judge similarity in a single batch call.
 */
export async function detectThemes(): Promise<number> {
  const config = getConfig();
  if (!config.GLM_AUTH_TOKEN) return 0;

  // Get unthemed triaged items
  const triaged = getPendingItems("triaged", 100);
  const unthemed = triaged.filter((item) => !item.theme_id);
  if (unthemed.length < 3) return 0; // Need at least 3 for a cluster

  // Get existing themes
  const existingThemes = getThemes("active");

  // Build the prompt
  const itemSummaries = unthemed.slice(0, 30).map((item) => ({
    id: item.id,
    title: item.title ?? "Untitled",
    value: item.extracted_value ?? item.triage_summary ?? "",
    platform: item.platform ?? "unknown",
    value_type: item.value_type ?? "unknown",
  }));

  const themeSummaries = existingThemes.map((t) => ({
    name: t.name,
    description: t.description,
    item_count: t.item_count,
  }));

  const prompt = `You are a thematic clustering agent. Group related items into themes.

## Existing Themes
${JSON.stringify(themeSummaries, null, 2)}

## Unthemed Items
${JSON.stringify(itemSummaries, null, 2)}

## Instructions
1. For each item, check if it fits an existing theme. If so, assign it.
2. If 3+ items share a topic not covered by existing themes, propose a new theme.
3. Items with no clear cluster should be left unassigned.
4. Theme names should be specific and descriptive (e.g. "Agent Orchestration Frameworks" not "AI").

Return a JSON object:
- "assignments": array of { "item_id": number, "theme_name": string } for items assigned to existing themes
- "new_themes": array of { "theme_name": string, "item_ids": number[], "description": string } for new clusters
- "unassigned": array of item_ids that don't fit any cluster

Return ONLY the JSON object.`;

  const envOverride: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: config.GLM_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.GLM_AUTH_TOKEN,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.GLM_SONNET_MODEL,
  };

  let response = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: "sonnet",
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        env: envOverride,
      },
    })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? (block.text ?? "") : ""
          )
          .join("");
      }
    }
  } catch (err) {
    log.error("Theme clustering query failed", { error: String(err) });
    return 0;
  }

  // Parse response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    log.warn("Theme clustering returned no JSON");
    return 0;
  }

  try {
    const result = JSON.parse(jsonMatch[0]) as {
      assignments: { item_id: number; theme_name: string }[];
      new_themes: ClusterProposal[];
      unassigned: number[];
    };

    let assignedCount = 0;

    // Process assignments to existing themes
    for (const assignment of result.assignments ?? []) {
      const theme = getThemeByName(assignment.theme_name);
      if (theme) {
        addThemeItem(theme.id, assignment.item_id);
        updatePendingItem(assignment.item_id, { theme_id: theme.id });
        updateTheme(theme.id, {
          item_count: theme.item_count + 1,
          last_activity_at: new Date().toISOString(),
        });
        assignedCount++;
      }
    }

    // Create new themes
    for (const proposal of result.new_themes ?? []) {
      if (proposal.item_ids.length < 3) continue;

      const existing = getThemeByName(proposal.theme_name);
      if (existing) continue; // Don't duplicate

      const theme = createTheme({
        name: proposal.theme_name,
        description: proposal.description,
      });

      for (const itemId of proposal.item_ids) {
        addThemeItem(theme.id, itemId);
        updatePendingItem(itemId, { theme_id: theme.id });
      }

      updateTheme(theme.id, {
        item_count: proposal.item_ids.length,
        last_activity_at: new Date().toISOString(),
      });

      assignedCount += proposal.item_ids.length;
      log.info("New theme created", {
        name: proposal.theme_name,
        itemCount: proposal.item_ids.length,
      });
    }

    log.info("Theme clustering complete", { assigned: assignedCount });
    return assignedCount;
  } catch (err) {
    log.error("Theme clustering parse failed", { error: String(err) });
    return 0;
  }
}
