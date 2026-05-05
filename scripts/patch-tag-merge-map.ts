import { readFileSync, writeFileSync } from "node:fs";

const IN = "/tmp/yt_tag_llm_merge_map.json";
const OUT = "/tmp/yt_tag_llm_merge_map.patched.json";

interface Cluster {
  canonical: string;
  members: string[];
}
interface Map {
  clusters: Cluster[];
  stats?: Record<string, number>;
}

const map = JSON.parse(readFileSync(IN, "utf-8")) as Map;

// Fix 1: remove "suffering" from biochemistry cluster, add as its own singleton
const biochem = map.clusters.find((c) => c.canonical === "biochemistry");
if (!biochem) throw new Error("biochemistry cluster not found");
const sufferIdx = biochem.members.indexOf("suffering");
if (sufferIdx === -1) throw new Error("'suffering' not found in biochemistry");
biochem.members.splice(sufferIdx, 1);
map.clusters.push({ canonical: "suffering", members: ["suffering"] });

// Fix 2: rename supplement-safety -> nutritional-supplements
const supp = map.clusters.find((c) => c.canonical === "supplement-safety");
if (!supp) throw new Error("supplement-safety cluster not found");
supp.canonical = "nutritional-supplements";
// Members still include "supplement-safety" string (the original tag); leave it as-is
// so it maps to the new canonical.

// Validate
const allMembers = map.clusters.flatMap((c) => c.members);
const uniq = new Set(allMembers);
if (allMembers.length !== uniq.size) {
  throw new Error(`duplicate members after patch: ${allMembers.length} vs ${uniq.size}`);
}

const stats = {
  input_tags: allMembers.length,
  output_canonicals: map.clusters.length,
  multi_member_clusters: map.clusters.filter((c) => c.members.length > 1).length,
  singleton_clusters: map.clusters.filter((c) => c.members.length === 1).length,
};
map.stats = stats;

writeFileSync(OUT, JSON.stringify(map, null, 2));
console.log("Patched map written to " + OUT);
console.log("Stats:", stats);
