import { loadConfig } from "../src/config.ts";
import { initDb } from "../src/db/index.ts";
import { rebuildTopicGraph } from "../src/youtube/graph.ts";

loadConfig();
initDb();

console.log("Rebuilding YouTube topic graph from all existing videos...\n");

const result = rebuildTopicGraph();

console.log("Done!");
console.log("  Topics: " + result.topicCount);
console.log("  Video-topic links: " + result.linkCount);
console.log("  Topic co-occurrences: " + result.relationCount);
