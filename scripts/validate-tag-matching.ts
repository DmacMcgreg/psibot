import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import {
  getCandidateTagsForText,
  TAG_MATCH_THRESHOLD,
} from "../src/youtube/tags-canonical.ts";

loadConfig();
initDb();

/**
 * Probe the tag vocabulary with synthetic queries to confirm the match
 * threshold behaves reasonably. Reports distances + whether each would reuse
 * an existing canonical ([REUSE]) vs. create a new one.
 *
 * Goal: threshold should keep clear synonyms ("llm-safety" -> "ai-safety")
 * while rejecting semantic adjacents ("neuroscience" vs "meditation").
 */

const PROBES: Array<{ query: string; intent: string }> = [
  { query: "llm safety", intent: "should match ai-safety" },
  { query: "large language models", intent: "should match ai or llm if present" },
  { query: "meditation practice", intent: "should match meditation / contemplative-practice" },
  { query: "catholic theology", intent: "should match theology or catholicism" },
  { query: "federal reserve policy", intent: "should match monetary-policy / macroeconomics" },
  { query: "exercise routine", intent: "should match fitness or exercise" },
  { query: "quantum physics", intent: "should match physics" },
  { query: "jungian psychology", intent: "should match psychology" },
  { query: "covid vaccine safety", intent: "should match vaccination / pharma" },
  { query: "random gibberish xyzzy", intent: "should NOT match anything (negative probe)" },
];

for (const { query, intent } of PROBES) {
  const candidates = await getCandidateTagsForText(query, 5);
  console.log(`\n"${query}"  (${intent})`);
  for (const c of candidates) {
    const verdict = c.distance <= TAG_MATCH_THRESHOLD ? "  [REUSE]" : "";
    console.log(`  ${c.distance.toFixed(4)}  ${c.name}${verdict}  (${c.usage_count}×)`);
  }
}

console.log(`\nThreshold: ${TAG_MATCH_THRESHOLD}`);
