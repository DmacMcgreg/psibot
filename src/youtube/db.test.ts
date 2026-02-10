import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";

// Standalone DB test - creates an in-memory database with the schema
// to verify youtube tables and vec operations work without starting the app.

Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");

let db: Database;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  sqliteVec.load(db);

  for (const sql of MIGRATIONS) {
    db.exec(sql);
  }
});

afterAll(() => {
  db.close();
});

describe("youtube schema", () => {
  it("creates youtube_videos table", () => {
    const tables = db
      .prepare<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='youtube_videos'`
      )
      .all();
    expect(tables.length).toBe(1);
  });

  it("creates youtube_chunks table", () => {
    const tables = db
      .prepare<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='youtube_chunks'`
      )
      .all();
    expect(tables.length).toBe(1);
  });

  it("creates youtube_vec virtual table", () => {
    // sqlite-vec tables appear as virtual tables in sqlite_master
    const tables = db
      .prepare<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE name='youtube_vec'`
      )
      .all();
    expect(tables.length).toBeGreaterThan(0);
  });
});

describe("youtube_videos CRUD", () => {
  it("inserts and retrieves a video", () => {
    const result = db
      .prepare<
        { id: number; video_id: string; title: string },
        [string, string, string, string, string, string, string, string]
      >(
        `INSERT INTO youtube_videos (video_id, title, channel_title, url, tags, markdown_summary, analysis_json, transcript_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, video_id, title`
      )
      .get(
        "test123456a",
        "Test Video",
        "Test Channel",
        "https://youtube.com/watch?v=test123456a",
        '["test", "demo"]',
        "## Test summary",
        '{"themes":[],"key_topics":[],"insights":[],"quotes":[],"markdown_summary":"test","tags":["test"]}',
        "This is the transcript text"
      );

    expect(result).not.toBeNull();
    expect(result!.video_id).toBe("test123456a");
    expect(result!.title).toBe("Test Video");

    const fetched = db
      .prepare<{ title: string; tags: string }, [string]>(
        `SELECT title, tags FROM youtube_videos WHERE video_id = ?`
      )
      .get("test123456a");

    expect(fetched!.title).toBe("Test Video");
    expect(JSON.parse(fetched!.tags)).toEqual(["test", "demo"]);
  });

  it("upserts on conflict", () => {
    db.prepare(
      `INSERT INTO youtube_videos (video_id, title, channel_title, url, tags, markdown_summary, analysis_json, transcript_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET title = excluded.title`
    ).run(
      "test123456a",
      "Updated Title",
      "Test Channel",
      "https://youtube.com/watch?v=test123456a",
      '["test"]',
      "## Updated",
      "{}",
      "updated transcript"
    );

    const row = db
      .prepare<{ title: string }, [string]>(
        `SELECT title FROM youtube_videos WHERE video_id = ?`
      )
      .get("test123456a");

    expect(row!.title).toBe("Updated Title");
  });
});

describe("youtube_chunks + youtube_vec", () => {
  it("inserts a chunk and its embedding", () => {
    // Insert a chunk
    const chunk = db
      .prepare<{ id: number }, [string, string, string]>(
        `INSERT INTO youtube_chunks (video_id, chunk_type, chunk_text) VALUES (?, ?, ?) RETURNING id`
      )
      .get("test123456a", "summary", "This is a test summary chunk");

    expect(chunk).not.toBeNull();

    // Insert a 768-dim embedding for this chunk
    const embedding = new Float32Array(768);
    for (let i = 0; i < 768; i++) {
      embedding[i] = Math.random() * 2 - 1; // random values between -1 and 1
    }

    db.prepare(`INSERT INTO youtube_vec (rowid, embedding) VALUES (?, ?)`).run(
      BigInt(chunk!.id),
      embedding
    );

    // Verify vec table has the row
    const vecRows = db
      .prepare<{ rowid: number; distance: number }, [Float32Array, number]>(
        `SELECT rowid, distance FROM youtube_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      )
      .all(embedding, 1);

    expect(vecRows.length).toBe(1);
    expect(vecRows[0].rowid).toBe(chunk!.id);
    expect(vecRows[0].distance).toBeCloseTo(0, 3); // distance to itself should be ~0
  });

  it("performs vector similarity search across multiple chunks", () => {
    // Insert more chunks with distinct embeddings
    const baseEmbedding = new Float32Array(768).fill(0);
    const chunks: number[] = [];

    for (let c = 0; c < 3; c++) {
      const chunkRow = db
        .prepare<{ id: number }, [string, string, string]>(
          `INSERT INTO youtube_chunks (video_id, chunk_type, chunk_text) VALUES (?, ?, ?) RETURNING id`
        )
        .get("test123456a", "topic", `Topic chunk ${c}`);

      const emb = new Float32Array(768);
      // Make each embedding point in a different direction
      emb[c] = 1.0;

      db.prepare(`INSERT INTO youtube_vec (rowid, embedding) VALUES (?, ?)`).run(
        BigInt(chunkRow!.id),
        emb
      );
      chunks.push(chunkRow!.id);
    }

    // Search with a query vector close to chunk 0 (dim 0 = 1.0)
    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;

    const results = db
      .prepare<{ rowid: number; distance: number }, [Float32Array, number]>(
        `SELECT rowid, distance FROM youtube_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
      )
      .all(queryVec, 3);

    expect(results.length).toBeGreaterThanOrEqual(3);
    // The closest result should be the chunk with dim[0]=1.0
    const closest = results[0];
    expect(closest.rowid).toBe(chunks[0]);
  });
});
