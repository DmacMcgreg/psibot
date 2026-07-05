/**
 * Session search — cross-session recall over chat_messages via FTS5.
 *
 * Mirrors Hermes' `tools/session_search_tool.py` minus the per-session LLM
 * summarization step. Returns windowed excerpts the model can read directly.
 *
 * Pipeline (per query):
 *   1. FTS5 query → group hits by session_id, count.
 *   2. Top N sessions by hit count (default 3).
 *   3. For each session: load every message, format as `USER:` / `ASSISTANT:`,
 *      truncate to a 100K-char window centered on the match with 25/75
 *      before/after bias.
 *   4. Three-tier match strategy:
 *        a. Full-phrase match (case-insensitive substring of the joined
 *           transcript)
 *        b. Proximity co-occurrence — all query terms within 200 chars
 *        c. Individual term position fallback
 *
 * Backfill: if chat_messages_fts is empty but chat_messages has rows, we
 * lazily backfill the FTS index on first search. Cheaper than blocking
 * startup; still bounded.
 */

import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("sessions.search");

const WINDOW_SIZE = 100_000;
const PROXIMITY_WINDOW = 200;
const BEFORE_RATIO = 0.25;

export interface SessionHit {
  sessionId: string;
  source: string;
  startedAt: string;
  hitCount: number;
  totalMessages: number;
  excerpt: string;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  source: string;
  created_at: string;
}

/**
 * Run a session search. Returns top-N sessions with windowed excerpts.
 * `query` should be a plain-language phrase; we tokenize and FTS-quote it.
 */
export function searchSessions(
  query: string,
  opts: { maxSessions?: number } = {},
): SessionHit[] {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];
  const maxSessions = opts.maxSessions ?? 3;

  const db = getDb();
  ensureFtsBackfilled();

  // FTS5 quote: wrap the query in double quotes so phrases don't break the
  // parser. Strip stray quotes from input first.
  const ftsQuery = `"${cleanQuery.replace(/"/g, '')}"`;

  let hitRows: Array<{ session_id: string; hit_count: number; total_messages: number }>;
  try {
    hitRows = db
      .prepare<{ session_id: string; hit_count: number; total_messages: number }, [string, number]>(
        `SELECT cm.session_id AS session_id,
                COUNT(*) AS hit_count,
                (SELECT COUNT(*) FROM chat_messages WHERE session_id = cm.session_id AND source != 'review') AS total_messages
         FROM chat_messages_fts f
         JOIN chat_messages cm ON cm.id = f.rowid
         WHERE chat_messages_fts MATCH ? AND cm.source != 'review'
         GROUP BY cm.session_id
         ORDER BY hit_count DESC
         LIMIT ?`,
      )
      .all(ftsQuery, maxSessions);
  } catch (e) {
    // Malformed FTS query — fall back to LIKE so the agent gets something.
    log.warn("FTS query failed, falling back to LIKE", { query: cleanQuery, error: String(e) });
    return searchSessionsViaLike(cleanQuery, maxSessions);
  }

  const out: SessionHit[] = [];
  for (const hit of hitRows) {
    const messages = db
      .prepare<MessageRow, [string]>(
        `SELECT id, session_id, role, content, source, created_at
         FROM chat_messages WHERE session_id = ? AND source != 'review'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(hit.session_id);
    if (messages.length === 0) continue;

    const transcript = formatConversation(messages);
    const excerpt = truncateAroundMatches(transcript, cleanQuery);

    out.push({
      sessionId: hit.session_id,
      source: messages[0].source,
      startedAt: messages[0].created_at,
      hitCount: hit.hit_count,
      totalMessages: hit.total_messages,
      excerpt,
    });
  }
  return out;
}

function formatConversation(messages: MessageRow[]): string {
  return messages
    .map((m) => {
      const tag = m.role.toUpperCase();
      const body = m.content.length > 8000 ? `${m.content.slice(0, 8000)}…[truncated]` : m.content;
      return `[${tag} @ ${m.created_at}]\n${body}`;
    })
    .join("\n\n");
}

/**
 * Locate the best match window in the transcript and return a window of up
 * to WINDOW_SIZE chars centered on it (25% before, 75% after).
 *
 * Hermes' three-tier strategy:
 *   1. Full-phrase substring match (highest precision).
 *   2. Proximity — all terms within PROXIMITY_WINDOW chars (rarest term first).
 *   3. Individual term positions — pick the earliest one.
 */
export function truncateAroundMatches(transcript: string, query: string): string {
  if (transcript.length <= WINDOW_SIZE) return transcript;

  const lower = transcript.toLowerCase();
  const queryLower = query.toLowerCase();
  const terms = queryLower.split(/\s+/).filter((t) => t.length > 0);

  let matchPos = -1;

  // Tier 1: full phrase
  if (queryLower) {
    const idx = lower.indexOf(queryLower);
    if (idx !== -1) matchPos = idx;
  }

  // Tier 2: proximity co-occurrence (find all terms within PROXIMITY_WINDOW chars)
  if (matchPos === -1 && terms.length > 1) {
    matchPos = findProximityMatch(lower, terms);
  }

  // Tier 3: any term hit
  if (matchPos === -1) {
    for (const t of terms) {
      const idx = lower.indexOf(t);
      if (idx !== -1) {
        matchPos = idx;
        break;
      }
    }
  }

  // No match (shouldn't happen if FTS already returned a hit, but guard
  // anyway). Return a head excerpt.
  if (matchPos === -1) {
    return transcript.slice(0, WINDOW_SIZE) + "\n…[truncated]";
  }

  const beforeBudget = Math.floor(WINDOW_SIZE * BEFORE_RATIO);
  const afterBudget = WINDOW_SIZE - beforeBudget;
  const start = Math.max(0, matchPos - beforeBudget);
  const end = Math.min(transcript.length, matchPos + afterBudget);
  const head = start > 0 ? "…[earlier conversation truncated]\n\n" : "";
  const tail = end < transcript.length ? "\n\n…[later conversation truncated]" : "";
  return head + transcript.slice(start, end) + tail;
}

function findProximityMatch(haystack: string, terms: string[]): number {
  // Index all term hit positions. Then scan: for each hit of the rarest
  // term, check whether all other terms appear within PROXIMITY_WINDOW chars.
  const positions = terms.map((t) => {
    const out: number[] = [];
    let from = 0;
    while (from <= haystack.length) {
      const idx = haystack.indexOf(t, from);
      if (idx === -1) break;
      out.push(idx);
      from = idx + 1;
    }
    return out;
  });
  // Empty term means we can't match — bail.
  if (positions.some((p) => p.length === 0)) return -1;

  // Iterate over the rarest term's hits.
  let rarestIdx = 0;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].length < positions[rarestIdx].length) rarestIdx = i;
  }
  const anchorPositions = positions[rarestIdx];

  for (const anchor of anchorPositions) {
    let allWithinWindow = true;
    for (let i = 0; i < positions.length; i++) {
      if (i === rarestIdx) continue;
      const found = positions[i].some((p) => Math.abs(p - anchor) <= PROXIMITY_WINDOW);
      if (!found) {
        allWithinWindow = false;
        break;
      }
    }
    if (allWithinWindow) return anchor;
  }
  return -1;
}

function searchSessionsViaLike(query: string, maxSessions: number): SessionHit[] {
  const db = getDb();
  const pattern = `%${query.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const hitRows = db
    .prepare<{ session_id: string; hit_count: number; total_messages: number }, [string, number]>(
      `SELECT session_id,
              COUNT(*) AS hit_count,
              (SELECT COUNT(*) FROM chat_messages cm2 WHERE cm2.session_id = chat_messages.session_id AND cm2.source != 'review') AS total_messages
       FROM chat_messages
       WHERE content LIKE ? ESCAPE '\\' AND source != 'review'
       GROUP BY session_id
       ORDER BY hit_count DESC
       LIMIT ?`,
    )
    .all(pattern, maxSessions);

  const out: SessionHit[] = [];
  for (const hit of hitRows) {
    const messages = db
      .prepare<MessageRow, [string]>(
        `SELECT id, session_id, role, content, source, created_at FROM chat_messages WHERE session_id = ? AND source != 'review' ORDER BY created_at ASC, id ASC`,
      )
      .all(hit.session_id);
    if (messages.length === 0) continue;
    const transcript = formatConversation(messages);
    out.push({
      sessionId: hit.session_id,
      source: messages[0].source,
      startedAt: messages[0].created_at,
      hitCount: hit.hit_count,
      totalMessages: hit.total_messages,
      excerpt: truncateAroundMatches(transcript, query),
    });
  }
  return out;
}

let _backfillChecked = false;

function ensureFtsBackfilled(): void {
  if (_backfillChecked) return;
  _backfillChecked = true;
  const db = getDb();
  try {
    const ftsCount = db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM chat_messages_fts`).get();
    const cmCount = db.prepare<{ n: number }, []>(`SELECT COUNT(*) AS n FROM chat_messages`).get();
    if (!ftsCount || !cmCount) return;
    if (ftsCount.n >= cmCount.n) return;
    log.info("Backfilling chat_messages_fts", { from: ftsCount.n, to: cmCount.n });
    const batchSize = 1000;
    let offset = ftsCount.n;
    const insert = db.prepare(`INSERT INTO chat_messages_fts(rowid, content) VALUES (?, ?)`);
    while (true) {
      const rows = db
        .prepare<{ id: number; content: string }, [number, number]>(
          `SELECT id, content FROM chat_messages
           WHERE id NOT IN (SELECT rowid FROM chat_messages_fts)
           ORDER BY id ASC
           LIMIT ? OFFSET ?`,
        )
        .all(batchSize, 0); // OFFSET 0 because the NOT IN already filters
      if (rows.length === 0) break;
      const tx = db.transaction((rs: typeof rows) => {
        for (const r of rs) insert.run(r.id, r.content);
      });
      tx(rows);
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
    log.info("FTS backfill complete", { rows: offset });
  } catch (e) {
    log.warn("FTS backfill failed", { error: String(e) });
  }
}
