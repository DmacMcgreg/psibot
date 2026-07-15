import { query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../shared/logger.ts";
import {
  EMBEDDING_DIMS,
  cosineSimilarity,
  listGroups,
  createGroup,
  relabelGroup,
  assignItem,
  saveGroupCentroid,
  loadGroupCentroid,
  getItemEmbedding,
  getUnassignedEligible,
  deleteAllGroups,
  getDbGroupCount,
  type DiscoverGroup,
} from "./db.ts";

const log = createLogger("discover:indexer");

/**
 * DiscoverIndexer — clusters eligible atlas items into topic "digests".
 *
 * Two modes:
 *  - Bootstrap (no groups yet, or an explicit rebuild): batch k-means over all
 *    eligible embeddings → K well-separated clusters, LLM-labelled. Gemini
 *    embeddings sit at a high cosine baseline, so online greedy would blob
 *    everything into one cluster; k-means gives balanced topics.
 *  - Incremental (groups exist): assign new items to the nearest centroid,
 *    only spawning a new cluster for a genuinely distant item.
 */

const MAX_GROUPS = 22;
// Below this cosine to EVERY existing centroid, an item is novel enough to seed
// its own cluster. Low, because k-means centroids are already well-spread.
const NEW_CLUSTER_FLOOR = 0.55;
const BOOTSTRAP_CAP = 2000; // max items to k-means in one bootstrap
const KMEANS_ITERS = 12;

interface Embedded {
  atlasItemId: number;
  vec: Float32Array;
}

export async function runDiscoverIndexer(opts?: { limit?: number; rebuild?: boolean }): Promise<{
  assigned: number;
  newGroups: number;
  mode: "bootstrap" | "incremental";
}> {
  if (opts?.rebuild) deleteAllGroups();
  const haveGroups = getDbGroupCount() > 0;
  if (!haveGroups) {
    return bootstrap();
  }
  return incremental(opts?.limit ?? 400);
}

// --- Bootstrap: batch k-means ---

async function bootstrap(): Promise<{ assigned: number; newGroups: number; mode: "bootstrap" }> {
  const pending = getUnassignedEligible(BOOTSTRAP_CAP);
  const items: Embedded[] = [];
  for (const p of pending) {
    const vec = getItemEmbedding(p.atlas_item_id);
    if (vec && vec.length === EMBEDDING_DIMS) items.push({ atlasItemId: p.atlas_item_id, vec });
  }
  if (items.length === 0) {
    log.info("Bootstrap: no embedded eligible items");
    return { assigned: 0, newGroups: 0, mode: "bootstrap" };
  }

  const k = Math.max(6, Math.min(MAX_GROUPS, Math.round(Math.sqrt(items.length / 3))));
  const { assignments, centroids } = kmeans(items.map((i) => i.vec), k);

  // Create a group per non-empty cluster, assign its members.
  const clusterToGroupId = new Map<number, number>();
  const newGroupIds: number[] = [];
  for (let cIdx = 0; cIdx < centroids.length; cIdx++) {
    const memberCount = assignments.filter((a) => a === cIdx).length;
    if (memberCount === 0) continue;
    const g = createGroup({ label: `Cluster ${cIdx + 1}`, emoji: null, centroid: centroids[cIdx], auto: true });
    clusterToGroupId.set(cIdx, g.id);
    newGroupIds.push(g.id);
  }
  let assigned = 0;
  for (let i = 0; i < items.length; i++) {
    const gid = clusterToGroupId.get(assignments[i]);
    if (!gid) continue;
    const sim = cosineSimilarity(items[i].vec, centroids[assignments[i]]);
    assignItem(items[i].atlasItemId, gid, sim);
    assigned++;
  }
  // Refresh item_count via a centroid save (its subquery recounts).
  for (let cIdx = 0; cIdx < centroids.length; cIdx++) {
    const gid = clusterToGroupId.get(cIdx);
    if (gid) saveGroupCentroid(gid, centroids[cIdx]);
  }

  await labelGroups(newGroupIds);
  // No taxonomy merge here — k-means already separates cleanly, and merging in
  // this compressed space would collapse distinct topics. Merges happen only in
  // incremental mode to dedupe organically-spawned clusters.
  log.info("Bootstrap complete", { items: items.length, k, groups: newGroupIds.length, assigned });
  return { assigned, newGroups: newGroupIds.length, mode: "bootstrap" };
}

/** Lloyd's k-means with k-means++ seeding. Deterministic seeding (no RNG). */
function kmeans(vectors: Float32Array[], k: number): { assignments: number[]; centroids: Float32Array[] } {
  const n = vectors.length;
  const kk = Math.min(k, n);
  // k-means++ style seeding without RNG: first centroid = item 0, then each
  // next centroid = the item farthest (min-cosine) from all chosen so far.
  const centroids: Float32Array[] = [Float32Array.from(vectors[0])];
  while (centroids.length < kk) {
    let farIdx = 0;
    let farScore = Infinity;
    for (let i = 0; i < n; i++) {
      let best = -Infinity;
      for (const c of centroids) best = Math.max(best, cosineSimilarity(vectors[i], c));
      if (best < farScore) { farScore = best; farIdx = i; }
    }
    centroids.push(Float32Array.from(vectors[farIdx]));
  }

  const assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < KMEANS_ITERS; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestSim = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const s = cosineSimilarity(vectors[i], centroids[c]);
        if (s > bestSim) { bestSim = s; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    // Recompute centroids as cluster means.
    const sums = centroids.map(() => new Float32Array(EMBEDDING_DIMS));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      const s = sums[c];
      const v = vectors[i];
      for (let d = 0; d < EMBEDDING_DIMS; d++) s[d] += v[d];
      counts[c]++;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < EMBEDDING_DIMS; d++) sums[c][d] /= counts[c];
      centroids[c] = sums[c];
    }
    if (!changed) break;
  }
  return { assignments, centroids };
}

// --- Incremental: nearest-centroid ---

function foldCentroid(centroid: Float32Array, count: number, v: Float32Array): Float32Array {
  const next = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i++) next[i] = (centroid[i] * count + v[i]) / (count + 1);
  return next;
}

async function incremental(limit: number): Promise<{ assigned: number; newGroups: number; mode: "incremental" }> {
  const pending = getUnassignedEligible(limit);
  if (pending.length === 0) return { assigned: 0, newGroups: 0, mode: "incremental" };

  const working = listGroups().map((g) => ({
    group: g,
    centroid: loadGroupCentroid(g),
    count: g.item_count,
    dirty: false,
  }));
  const newGroupIds: number[] = [];
  let assigned = 0;

  for (const { atlas_item_id } of pending) {
    const emb = getItemEmbedding(atlas_item_id);
    if (!emb) continue;
    let best: (typeof working)[number] | null = null;
    let bestSim = -1;
    for (const w of working) {
      if (!w.centroid) continue;
      const sim = cosineSimilarity(emb, w.centroid);
      if (sim > bestSim) { bestSim = sim; best = w; }
    }
    const canCreate = working.filter((w) => w.group.auto === 1).length < MAX_GROUPS;
    if (best && (bestSim >= NEW_CLUSTER_FLOOR || !canCreate)) {
      assignItem(atlas_item_id, best.group.id, bestSim);
      best.centroid = foldCentroid(best.centroid!, best.count, emb);
      best.count += 1;
      best.dirty = true;
      assigned++;
    } else {
      const g = createGroup({ label: "New topic", emoji: null, centroid: emb, auto: true });
      assignItem(atlas_item_id, g.id, 1);
      working.push({ group: g, centroid: Float32Array.from(emb), count: 1, dirty: true });
      newGroupIds.push(g.id);
      assigned++;
    }
  }

  for (const w of working) if (w.dirty && w.centroid) saveGroupCentroid(w.group.id, w.centroid);
  if (newGroupIds.length > 0) await labelGroups(newGroupIds);
  await refine();
  log.info("Incremental complete", { assigned, newGroups: newGroupIds.length });
  return { assigned, newGroups: newGroupIds.length, mode: "incremental" };
}

async function refine(): Promise<void> {
  try {
    const { refineTaxonomy } = await import("./taxonomy.ts");
    refineTaxonomy();
  } catch (err) {
    log.warn("Taxonomy refine failed (non-fatal)", { error: String(err) });
  }
}

// --- Labeling ---

async function labelGroups(groupIds: number[]): Promise<void> {
  if (groupIds.length === 0) return;
  const { getDb } = await import("../db/index.ts");
  const db = getDb();
  const samples = groupIds
    .map((id) => {
      const titles = db
        .prepare<{ title: string }, [number]>(
          `SELECT a.title FROM discover_item_groups ig
           JOIN atlas_items a ON a.id = ig.atlas_item_id
           WHERE ig.group_id = ? ORDER BY a.captured_at DESC LIMIT 6`,
        )
        .all(id)
        .map((r) => r.title);
      return { id, titles };
    })
    .filter((s) => s.titles.length > 0);
  if (samples.length === 0) return;

  const blocks = samples
    .map((s, i) => `Cluster ${i + 1} (id=${s.id}):\n${s.titles.map((t) => `  - ${t}`).join("\n")}`)
    .join("\n\n");

  const prompt = `You are naming topic clusters for a personal content digest. Each cluster groups saved items (YouTube videos, GitHub repos, Reddit posts) sharing a theme. For each cluster, give a short human topic label (2-4 words, Title Case) and one representative emoji.

${blocks}

Return ONLY a JSON array in a code block, one object per cluster, same order:
\`\`\`json
[{"id": 123, "label": "AI & Agents", "emoji": "🤖"}]
\`\`\``;

  const parsed = await llmJsonArray(prompt);
  if (!parsed) return;
  for (const entry of parsed) {
    const id = Number(entry?.id);
    const label = typeof entry?.label === "string" ? entry.label.trim() : "";
    const emoji = typeof entry?.emoji === "string" ? entry.emoji.trim() : null;
    if (id && label) relabelGroup(id, label, emoji);
  }
}

async function llmJsonArray(prompt: string): Promise<any[] | null> {
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
    log.warn("Labeling LLM call failed", { error: String(err) });
    return null;
  }
  const fence = response.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fence ? fence[1] : response;
  try {
    const parsed = JSON.parse(raw.trim());
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    log.warn("Could not parse labeling JSON");
    return null;
  }
}
