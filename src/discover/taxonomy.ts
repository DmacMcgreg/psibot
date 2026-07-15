import { createLogger } from "../shared/logger.ts";
import {
  listGroups,
  loadGroupCentroid,
  cosineSimilarity,
  reassignGroupItems,
  recomputeGroupCentroid,
  deleteGroup,
  type DiscoverGroup,
} from "./db.ts";

const log = createLogger("discover:taxonomy");

// Two auto clusters this close have effectively converged on one topic. Gemini
// embeddings are compressed (even distinct topics sit near ~0.90 cosine), so
// the bar for "the same topic" must be high or unrelated clusters get merged.
const MERGE_THRESHOLD = 0.96;

/**
 * Periodic taxonomy refinement — the "slow loop" that reshapes clusters as
 * feedback and new items shift the space:
 *  - retire empty auto groups,
 *  - merge auto groups whose centroids have converged (cosine ≥ MERGE_THRESHOLD).
 *
 * Pure vector + DB work (no LLM). User-curated groups (auto=0) are never merged
 * away or deleted. Bounded and idempotent; safe to run on every discovery tick.
 */
export function refineTaxonomy(): { merged: number; retired: number } {
  let groups = listGroups();
  let merged = 0;
  let retired = 0;

  // 1. Retire empty auto groups.
  for (const g of groups) {
    if (g.auto === 1 && g.item_count === 0) {
      deleteGroup(g.id);
      retired++;
    }
  }
  if (retired > 0) groups = listGroups();

  // 2. Merge converged auto groups. Compare every pair once; fold the smaller
  //    (fewer items) into the larger, then recompute the survivor's centroid.
  const withCentroids = groups
    .map((g) => ({ g, c: loadGroupCentroid(g) }))
    .filter((x): x is { g: DiscoverGroup; c: Float32Array } => x.c !== null);

  const removed = new Set<number>();
  for (let i = 0; i < withCentroids.length; i++) {
    const a = withCentroids[i];
    if (removed.has(a.g.id)) continue;
    for (let j = i + 1; j < withCentroids.length; j++) {
      const b = withCentroids[j];
      if (removed.has(b.g.id)) continue;
      // Only merge auto clusters; keep at least one user-curated label intact.
      if (a.g.auto === 0 && b.g.auto === 0) continue;
      const sim = cosineSimilarity(a.c, b.c);
      if (sim < MERGE_THRESHOLD) continue;

      // Survivor: prefer a user-curated group, else the larger one.
      let survivor = a.g, victim = b.g;
      if (b.g.auto === 0 && a.g.auto === 1) { survivor = b.g; victim = a.g; }
      else if (a.g.auto === b.g.auto && b.g.item_count > a.g.item_count) { survivor = b.g; victim = a.g; }

      reassignGroupItems(victim.id, survivor.id);
      deleteGroup(victim.id);
      recomputeGroupCentroid(survivor.id);
      removed.add(victim.id);
      merged++;
      log.info("Merged converged clusters", {
        survivor: survivor.label, victim: victim.label, sim: Number(sim.toFixed(3)),
      });
    }
  }

  if (merged > 0 || retired > 0) log.info("Taxonomy refined", { merged, retired });
  return { merged, retired };
}
