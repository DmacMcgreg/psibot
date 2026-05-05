import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { initDb, getDb } from "../src/db/index.ts";

type Cluster = {
  canonical_name: string;
  canonical_description: string;
  member_ids: number[];
  member_names: string[];
};

type MergeMap = {
  clusters: Cluster[];
  stats: Record<string, number>;
};

const MAP_PATH = "/tmp/yt_merge_map.json";

loadConfig();
initDb();
const db = getDb();

const map: MergeMap = JSON.parse(readFileSync(MAP_PATH, "utf-8"));

console.log(`Loaded merge map: ${map.clusters.length} clusters`);

const totalMemberIds = map.clusters.reduce((s, c) => s + c.member_ids.length, 0);
const uniqueMemberIds = new Set(map.clusters.flatMap((c) => c.member_ids)).size;
if (totalMemberIds !== uniqueMemberIds) {
  throw new Error(`Duplicate member ids in merge map: ${totalMemberIds} total vs ${uniqueMemberIds} unique`);
}

const preTopicCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topics`).get()!.c;
const preLinkCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topic_links`).get()!.c;

if (uniqueMemberIds !== preTopicCount) {
  throw new Error(`Merge map covers ${uniqueMemberIds} ids but DB has ${preTopicCount} topics`);
}

const existingIds = new Set(
  db.prepare<{ id: number }, []>(`SELECT id FROM youtube_topics`).all().map((r) => r.id)
);
for (const id of new Set(map.clusters.flatMap((c) => c.member_ids))) {
  if (!existingIds.has(id)) {
    throw new Error(`Merge map references topic id ${id} that does not exist in DB`);
  }
}

console.log(`Pre-migration: ${preTopicCount} topics, ${preLinkCount} links`);

type LinkRow = { topic_id: number; video_id: string; theme_summary: string };
const oldLinks = db
  .prepare<LinkRow, []>(`SELECT topic_id, video_id, theme_summary FROM youtube_topic_links`)
  .all();

console.log(`Captured ${oldLinks.length} old links before migration`);

const tx = db.transaction(() => {
  db.exec(`DELETE FROM youtube_topic_relations`);
  db.exec(`DELETE FROM youtube_topic_links`);
  db.exec(`DELETE FROM youtube_topics`);
  db.exec(`DELETE FROM sqlite_sequence WHERE name = 'youtube_topics'`);

  const insertTopic = db.prepare<{ id: number }, [string, string, string]>(
    `INSERT INTO youtube_topics (name, display_name, description) VALUES (?, ?, ?) RETURNING id`
  );

  const oldIdToNewId = new Map<number, number>();
  const newIdToName = new Map<number, string>();

  for (const cluster of map.clusters) {
    const normalized = cluster.canonical_name.toLowerCase().trim().replace(/\s+/g, " ");
    const row = insertTopic.get(normalized, cluster.canonical_name, cluster.canonical_description)!;
    newIdToName.set(row.id, cluster.canonical_name);
    for (const oldId of cluster.member_ids) {
      oldIdToNewId.set(oldId, row.id);
    }
  }

  const newTopicCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topics`).get()!.c;
  if (newTopicCount !== map.clusters.length) {
    throw new Error(`Topic insert count mismatch: expected ${map.clusters.length}, got ${newTopicCount}`);
  }

  const insertLink = db.prepare(
    `INSERT OR IGNORE INTO youtube_topic_links (topic_id, video_id, theme_summary) VALUES (?, ?, ?)`
  );

  const seen = new Set<string>();
  let linksInserted = 0;
  let linksDeduped = 0;
  for (const link of oldLinks) {
    const newTopicId = oldIdToNewId.get(link.topic_id);
    if (newTopicId === undefined) {
      throw new Error(`Orphan link: topic_id ${link.topic_id} not in merge map`);
    }
    const key = `${newTopicId}:${link.video_id}`;
    if (seen.has(key)) {
      linksDeduped++;
      continue;
    }
    seen.add(key);
    insertLink.run(newTopicId, link.video_id, link.theme_summary);
    linksInserted++;
  }

  db.exec(`
    UPDATE youtube_topics SET video_count = (
      SELECT COUNT(*) FROM youtube_topic_links WHERE topic_id = youtube_topics.id
    )
  `);

  type Pair = { topic_a: number; topic_b: number };
  const pairs = db
    .prepare<Pair, []>(
      `SELECT a.topic_id AS topic_a, b.topic_id AS topic_b
       FROM youtube_topic_links a
       JOIN youtube_topic_links b ON a.video_id = b.video_id AND a.topic_id < b.topic_id`
    )
    .all();

  const insertRelation = db.prepare(
    `INSERT INTO youtube_topic_relations (topic_a_id, topic_b_id, co_occurrence_count)
     VALUES (?, ?, 1)
     ON CONFLICT(topic_a_id, topic_b_id)
     DO UPDATE SET co_occurrence_count = co_occurrence_count + 1`
  );
  for (const p of pairs) {
    insertRelation.run(p.topic_a, p.topic_b);
  }

  console.log(`Inserted ${linksInserted} links, deduped ${linksDeduped}, ${pairs.length} co-occurrence pairs`);
});

tx();

const postTopicCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topics`).get()!.c;
const postLinkCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topic_links`).get()!.c;
const postRelCount = db.prepare<{ c: number }, []>(`SELECT COUNT(*) as c FROM youtube_topic_relations`).get()!.c;
const orphanLinks = db
  .prepare<{ c: number }, []>(
    `SELECT COUNT(*) as c FROM youtube_topic_links l LEFT JOIN youtube_topics t ON l.topic_id = t.id WHERE t.id IS NULL`
  )
  .get()!.c;

console.log(`\nPost-migration:`);
console.log(`  Topics: ${preTopicCount} -> ${postTopicCount}`);
console.log(`  Links: ${preLinkCount} -> ${postLinkCount}`);
console.log(`  Relations: ${postRelCount}`);
console.log(`  Orphan links: ${orphanLinks}`);

if (orphanLinks !== 0) {
  throw new Error(`Migration left ${orphanLinks} orphan links`);
}

console.log(`\nDone.`);
