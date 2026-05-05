import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { getCandidateTopicsForText, TOPIC_MATCH_THRESHOLD } from "../src/youtube/graph.ts";

loadConfig();
initDb();

const probes = [
  "Catholic Church history",
  "Trump 2024 presidency",
  "Bitcoin and cryptocurrency investing",
  "AI safety and alignment",
  "Conspiracies and UFOs",
  "Stoic philosophy",
  "Nutrition and metabolic health",
];

for (const probe of probes) {
  console.log(`\n=== "${probe}" ===`);
  const hits = await getCandidateTopicsForText(probe, 5);
  for (const h of hits) {
    const verdict = h.distance <= TOPIC_MATCH_THRESHOLD ? " [REUSE]" : "";
    console.log(`  ${h.distance.toFixed(4)} ${verdict} — ${h.display_name} (${h.video_count} videos)`);
  }
}
