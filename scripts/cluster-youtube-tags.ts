import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";
import { embedBatch } from "../src/youtube/embeddings.ts";

loadConfig();
initDb();
const db = getDb();

const THRESHOLD = Number(process.argv.find((a) => a.startsWith("--t="))?.slice(4) ?? "0.55");
const MAP_PATH = "/tmp/yt_tag_cluster_map.json";
const CACHE_PATH = "/tmp/yt_tag_embeddings.json";

interface VideoRow {
  id: number;
  video_id: string;
  tags: string;
}

const rows = db.prepare<VideoRow, []>(`SELECT id, video_id, tags FROM youtube_videos`).all();

const tagCount = new Map<string, number>();
for (const row of rows) {
  let parsed: unknown;
  try { parsed = JSON.parse(row.tags); } catch { continue; }
  if (!Array.isArray(parsed)) continue;
  for (const t of parsed) {
    if (typeof t === "string" && t.trim().length > 0) {
      tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    }
  }
}

const PROTECTED_TAGS = new Set(["auto-generated", "fallback"]);
const uniqueTags = [...tagCount.keys()].filter((t) => !PROTECTED_TAGS.has(t)).sort();
console.log(`Unique tags: ${uniqueTags.length}`);

let embeddings: Float32Array[];
if (existsSync(CACHE_PATH)) {
  console.log(`Loading cached embeddings from ${CACHE_PATH}...`);
  const cached = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as { tags: string[]; embeddings: number[][] };
  const cacheTagsSig = cached.tags.join("|");
  const currentTagsSig = uniqueTags.join("|");
  if (cacheTagsSig !== currentTagsSig) {
    throw new Error(`Cache tag list does not match current tags (${cached.tags.length} vs ${uniqueTags.length}). Delete ${CACHE_PATH} to rebuild.`);
  }
  embeddings = cached.embeddings.map((arr) => new Float32Array(arr));
  console.log(`Loaded ${embeddings.length} embeddings from cache`);
} else {
  console.log(`Embedding ${uniqueTags.length} tags...`);
  embeddings = await embedBatch(uniqueTags.map((t) => t.replace(/-/g, " ")));
  writeFileSync(
    CACHE_PATH,
    JSON.stringify({ tags: uniqueTags, embeddings: embeddings.map((e) => Array.from(e)) })
  );
  console.log(`Cached embeddings to ${CACHE_PATH}`);
}
console.log(`Using threshold ${THRESHOLD}`);

function l2(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Greedy nearest-canonical assignment: sort tags by count desc, then each
// unassigned tag joins the nearest existing canonical within threshold, else
// becomes a new canonical. Avoids daisy-chain transitive merges.
const idxByCount = uniqueTags
  .map((_, i) => i)
  .sort((a, b) => {
    const ca = tagCount.get(uniqueTags[a]) ?? 0;
    const cb = tagCount.get(uniqueTags[b]) ?? 0;
    if (cb !== ca) return cb - ca;
    return uniqueTags[a].localeCompare(uniqueTags[b]);
  });

const assignment = new Array<number>(uniqueTags.length).fill(-1); // -1 until assigned to a canonical idx
const canonicalIdxs: number[] = [];

console.log("Computing greedy nearest-canonical clustering...");
for (const i of idxByCount) {
  let bestCanon = -1;
  let bestDist = Infinity;
  for (const c of canonicalIdxs) {
    const d = l2(embeddings[i], embeddings[c]);
    if (d < bestDist) {
      bestDist = d;
      bestCanon = c;
    }
  }
  if (bestCanon !== -1 && bestDist <= THRESHOLD) {
    assignment[i] = bestCanon;
  } else {
    assignment[i] = i;
    canonicalIdxs.push(i);
  }
}

const clusterMap = new Map<number, number[]>();
for (let i = 0; i < uniqueTags.length; i++) {
  const c = assignment[i];
  if (!clusterMap.has(c)) clusterMap.set(c, []);
  clusterMap.get(c)!.push(i);
}

interface Cluster {
  canonical: string;
  canonical_count: number;
  total_count: number;
  members: Array<{ tag: string; count: number }>;
}

const clusters: Cluster[] = [];
for (const memberIdxs of clusterMap.values()) {
  const members = memberIdxs
    .map((i) => ({ tag: uniqueTags[i], count: tagCount.get(uniqueTags[i]) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  clusters.push({
    canonical: members[0].tag,
    canonical_count: members[0].count,
    total_count: members.reduce((s, m) => s + m.count, 0),
    members,
  });
}

clusters.sort((a, b) => b.total_count - a.total_count);

const multi = clusters.filter((c) => c.members.length > 1);
const singletons = clusters.filter((c) => c.members.length === 1);

console.log(`\nAfter clustering at threshold ${THRESHOLD}:`);
console.log(`  Clusters: ${clusters.length}`);
console.log(`  Multi-member: ${multi.length}`);
console.log(`  Singletons (still): ${singletons.length}`);
console.log(`  Total reduction: ${uniqueTags.length} -> ${clusters.length} (${((1 - clusters.length / uniqueTags.length) * 100).toFixed(1)}%)`);

console.log(`\nTop 30 multi-member clusters:`);
for (const c of multi.slice(0, 30)) {
  const memberStr = c.members.slice(0, 8).map((m) => `${m.tag}(${m.count})`).join(", ");
  console.log(`  [${c.total_count}]  ${c.canonical}  <-  ${memberStr}${c.members.length > 8 ? ", ..." : ""}`);
}

console.log(`\nLargest clusters (likely over-merges to review):`);
for (const c of [...multi].sort((a, b) => b.members.length - a.members.length).slice(0, 15)) {
  const memberStr = c.members.slice(0, 10).map((m) => m.tag).join(", ");
  console.log(`  (${c.members.length} members)  ${c.canonical}  <-  ${memberStr}${c.members.length > 10 ? ", ..." : ""}`);
}

writeFileSync(MAP_PATH, JSON.stringify({ threshold: THRESHOLD, clusters }, null, 2));
console.log(`\nWrote full merge map to ${MAP_PATH}`);
console.log(`(Review before applying. Use apply-tag-clusters.ts to rewrite.)`);
