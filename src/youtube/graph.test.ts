import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
// Importing index.ts calls Database.setCustomSQLite once (module load).
import { setDbForTesting } from "../db/index.ts";
import { buildVideoSimilarityGraph } from "./graph.ts";
import { EMBEDDING_DIMENSIONS } from "./embeddings.ts";

/** Alternating ±0.5 pattern, optionally flipped and nudged. */
function patternVec(flip: boolean, nudge = 0): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let i = 0; i < v.length; i++) v[i] = (i % 2 === 0 ? 0.5 : -0.5) * (flip ? -1 : 1);
  v[0] += nudge;
  return v;
}

describe("buildVideoSimilarityGraph (in-memory DB)", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    sqliteVec.load(db);
    for (const sql of MIGRATIONS) db.exec(sql);
    setDbForTesting(db);

    // a and b point the same way; c points the opposite way (cosine −1).
    // Read as raw bytes, a and c still look similar (cosine ≈ 0.6): the
    // float bits differ only in the sign byte. That is the bug this guards.
    const videos: Array<[string, Float32Array]> = [
      ["vid_a", patternVec(false)],
      ["vid_b", patternVec(false, 0.05)],
      ["vid_c", patternVec(true)],
    ];
    for (const [videoId, vec] of videos) {
      db.prepare(
        `INSERT INTO youtube_videos (video_id, title, channel_title, url, markdown_summary, analysis_json, transcript_text)
         VALUES (?, ?, 'ch', 'u', '', '{}', '')`,
      ).run(videoId, videoId);
      const chunk = db
        .prepare(`INSERT INTO youtube_chunks (video_id, chunk_type, chunk_text) VALUES (?, 'summary', 's') RETURNING id`)
        .get(videoId) as { id: number };
      db.prepare(`INSERT INTO youtube_vec (rowid, embedding) VALUES (?, ?)`).run(BigInt(chunk.id), vec);
    }
  });

  afterAll(() => db.close());

  it("links only videos whose decoded embeddings are similar", () => {
    const graph = buildVideoSimilarityGraph(0.5, 5);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["v-vid_a", "v-vid_b", "v-vid_c"]);
    expect(graph.edges).toHaveLength(1);
    const [edge] = graph.edges;
    expect([edge.source, edge.target].sort()).toEqual(["v-vid_a", "v-vid_b"]);
    expect(edge.weight).toBeGreaterThan(0.99);
  });
});
