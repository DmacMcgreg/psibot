import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import type { AtlasItem } from "./index.ts";

const log = createLogger("atlas:entities");

import { getConfig, getBackendEnv } from "../config.ts";
function getModel(): string {
  const cfg = getConfig();
  return cfg.DEFAULT_BACKEND === "glm" ? cfg.GLM_HAIKU_MODEL : "claude-haiku-4-5-20251001";
}
const MAX_ENTITIES_DEFAULT = 12;
const MAX_ENTITIES_LONGFORM = 25;
const MIN_BODY_CHARS = 50;
const BODY_SNIPPET_DEFAULT = 1500;
const BODY_SNIPPET_LONGFORM = 8000;
const LONGFORM_KINDS: ReadonlySet<string> = new Set([
  "youtube",
  "research",
  "scan",
  "daily_log",
]);

const EXTRACTION_SYSTEM_PROMPT =
  `You extract entities from knowledge items. Respond with a single JSON object and nothing else — no prose, no code fences, no commentary. Shape: {"entities":[{"kind":"ticker|name|topic","raw":"<surface form>","context":"<<=120 chars copied from source>"}]}. Empty list is valid.`;

const EntitySchema = z.object({
  kind: z.enum(["ticker", "name", "topic"]),
  raw: z.string().min(1),
  context: z.string().default(""),
});
const ResponseSchema = z.object({
  entities: z.array(EntitySchema),
});

export type EntityKind = "ticker" | "name" | "topic";

export interface ExtractedEntity {
  kind: EntityKind;
  raw: string;
  context: string;
}

/**
 * Deterministic normalization — not LLM-driven.
 * - ticker: uppercase, strip leading $, strip whitespace
 * - name / topic: lowercase, collapse internal whitespace, strip edges
 * Returns null for obviously invalid inputs (empty or unreasonable length).
 */
export function normalizeEntity(kind: EntityKind, raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  if (kind === "ticker") {
    const norm = trimmed.replace(/^\$/, "").toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(norm)) return null;
    return norm;
  }
  const norm = trimmed.toLowerCase().replace(/\s+/g, " ");
  if (norm.length < 2 || norm.length > 80) return null;
  return norm;
}

/** Best-effort display name: preserve user casing for names/topics; uppercase tickers. */
function displayName(kind: EntityKind, raw: string, norm: string): string {
  if (kind === "ticker") return norm;
  const trimmed = (raw ?? "").trim().replace(/\s+/g, " ");
  return trimmed || norm;
}

/**
 * Extract text content blocks from a SDKAssistantMessage into a single string.
 */
function assistantText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  let out = "";
  for (const block of blocks) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      out += (block as { text: string }).text;
    }
  }
  return out;
}

/**
 * Pull the first balanced JSON object out of a string. Model sometimes emits
 * leading "here is the JSON:" prose or ```json fences — strip and recover.
 */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Fast path: raw is already valid JSON
  try {
    return JSON.parse(trimmed);
  } catch {}
  // Strip ```json fences if present
  const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }
  // Locate first {...} balanced object
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Extract up to 12–25 entities from a single atlas item using Claude Haiku.
 * Direct JSON response — no MCP, no tools, minimal system prompt. Keeps the
 * per-item round-trip as fast as possible (1 turn, no tool-use overhead).
 * Returns [] on any failure — callers still mark entity_extracted_at so we
 * don't retry forever on unparseable items.
 */
export async function extractEntitiesForItem(item: AtlasItem): Promise<ExtractedEntity[]> {
  const body = (item.body ?? "").trim();
  const title = (item.title ?? "").trim();
  if ((title.length + body.length) < MIN_BODY_CHARS) {
    return [];
  }

  const isLongform = LONGFORM_KINDS.has(item.kind);
  const maxEntities = isLongform ? MAX_ENTITIES_LONGFORM : MAX_ENTITIES_DEFAULT;
  const snippetLen = isLongform ? BODY_SNIPPET_LONGFORM : BODY_SNIPPET_DEFAULT;
  const bodySnippet = body.slice(0, snippetLen);

  const userPrompt = `Extract up to ${maxEntities} entities from this knowledge item.

Rules:
- kind = "ticker" for publicly-traded equities (e.g. AAPL, NVDA, $TSLA). Strip any leading $.
- kind = "name" for specific people or organizations mentioned as proper nouns (e.g. "Andrej Karpathy", "Anthropic", "Vercel").
- kind = "topic" for concrete technologies, techniques, frameworks, concepts (e.g. "claude agent sdk", "sqlite-vec", "mcp", "retrieval augmented generation"). Avoid vague themes ("AI", "code", "news").
- Prefer specificity over volume. Skip obvious boilerplate (site names, button labels, "Reddit", "GitHub").
- If the item is too thin or generic to have entities, return an empty list.
- "context" is a short phrase (<=120 chars) copied from the source text showing how the entity was used — do not paraphrase.

## Item
kind: ${item.kind}
title: ${title}
url: ${item.url ?? ""}
body:
${bodySnippet}

Respond now with JSON only: {"entities":[...]}`;

  let textOut = "";
  let captured = 0;
  let cost: number | undefined;
  let durationMs: number | undefined;

  try {
    for await (const msg of query({
      prompt: userPrompt,
      options: {
        model: getModel(),
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        ...(getBackendEnv() ? { env: getBackendEnv() } : {}),
      },
    })) {
      if (msg.type === "assistant") {
        textOut += assistantText((msg.message as { content?: unknown }).content);
      } else if (msg.type === "result") {
        cost = msg.total_cost_usd;
        durationMs = msg.duration_ms;
      }
    }
  } catch (err) {
    log.error("Entity extraction failed", { itemId: item.id, error: String(err) });
    return [];
  }

  const parsed = parseJsonObject(textOut);
  if (!parsed) {
    log.warn("Entity extraction produced no parseable JSON", {
      itemId: item.id,
      snippet: textOut.slice(0, 120),
    });
    return [];
  }

  const result = ResponseSchema.safeParse(parsed);
  if (!result.success) {
    log.warn("Entity extraction JSON failed validation", {
      itemId: item.id,
      issue: result.error.issues[0]?.message,
    });
    return [];
  }

  const entities = result.data.entities.slice(0, maxEntities).map((e) => ({
    kind: e.kind,
    raw: e.raw,
    context: (e.context ?? "").slice(0, 200),
  }));
  captured = entities.length;

  log.info("Entity extraction complete", {
    itemId: item.id,
    durationMs,
    cost: cost?.toFixed(6),
    captured,
  });

  return entities;
}

/** Upsert a canonical entity, returning its id. Touches last_seen + mention_count. */
export function upsertEntity(kind: EntityKind, raw: string): number | null {
  const norm = normalizeEntity(kind, raw);
  if (!norm) return null;
  const db = getDb();

  // Alias routing: if the normalized form matches an alias, map to that entity.
  const alias = db
    .prepare<{ entity_id: number }, [string, string]>(
      `SELECT m.id AS entity_id
       FROM atlas_entity_aliases a
       JOIN atlas_entities m ON m.id = a.entity_id
       WHERE a.alias_norm = ? AND m.kind = ?`,
    )
    .get(norm, kind);
  if (alias) {
    db.prepare(
      `UPDATE atlas_entities
       SET mention_count = mention_count + 1,
           last_seen = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    ).run(alias.entity_id);
    return alias.entity_id;
  }

  const existing = db
    .prepare<{ id: number }, [string, string]>(
      "SELECT id FROM atlas_entities WHERE kind = ? AND name_norm = ?",
    )
    .get(kind, norm);
  if (existing) {
    db.prepare(
      `UPDATE atlas_entities
       SET mention_count = mention_count + 1,
           last_seen = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    ).run(existing.id);
    return existing.id;
  }

  const res = db
    .prepare(
      `INSERT INTO atlas_entities (kind, name_norm, display_name, mention_count)
       VALUES (?, ?, ?, 1)`,
    )
    .run(kind, norm, displayName(kind, raw, norm));
  return Number(res.lastInsertRowid);
}

/** Insert or ignore a mention, scoped by (item_id, entity_id). */
export function recordMention(itemId: number, entityId: number, confidence: number, context: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO atlas_entity_mentions (item_id, entity_id, confidence, context)
     VALUES (?, ?, ?, ?)`,
  ).run(itemId, entityId, confidence, context.slice(0, 200));
}

/** Increment cooccurrence for each unordered pair of entity ids. Sorted-pair invariant. */
export function recordCooccurrence(entityIds: number[]): void {
  if (entityIds.length < 2) return;
  const db = getDb();
  const unique = Array.from(new Set(entityIds));
  const stmt = db.prepare(
    `INSERT INTO atlas_entity_cooccur (entity_a, entity_b, weight, last_seen)
     VALUES (?, ?, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(entity_a, entity_b) DO UPDATE SET
       weight = weight + 1,
       last_seen = excluded.last_seen`,
  );
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = Math.min(unique[i], unique[j]);
      const b = Math.max(unique[i], unique[j]);
      stmt.run(a, b);
    }
  }
}

/**
 * Deterministic fast-path for trading signals: the metadata already carries a ticker.
 * No LLM call needed — zero cost. Returns the entity-id count extracted.
 */
export function fastPathSignal(item: AtlasItem): number | null {
  if (item.kind !== "signal") return null;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(item.metadata_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ticker = typeof meta.ticker === "string" ? meta.ticker : null;
  if (!ticker) return null;
  const id = upsertEntity("ticker", ticker);
  if (id === null) return 0;
  recordMention(item.id, id, 0.99, `signal ${meta.direction ?? ""} ${meta.source ?? ""}`.trim());
  return 1;
}

/** Process one item end-to-end: extract, upsert, mentions, cooccur, mark extracted. */
export async function indexItemEntities(item: AtlasItem): Promise<number> {
  const db = getDb();
  const entityIds: number[] = [];

  const fast = fastPathSignal(item);
  if (fast !== null) {
    db.prepare(
      "UPDATE atlas_items SET entity_extracted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    ).run(item.id);
    return fast;
  }

  const extracted = await extractEntitiesForItem(item);
  for (const ent of extracted) {
    const id = upsertEntity(ent.kind, ent.raw);
    if (id !== null) {
      recordMention(item.id, id, 0.85, ent.context);
      entityIds.push(id);
    }
  }

  recordCooccurrence(entityIds);

  db.prepare(
    "UPDATE atlas_items SET entity_extracted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
  ).run(item.id);

  return entityIds.length;
}

/** Rebuild cooccur edges from the current mentions table. Cheap enough to run weekly. */
export function rebuildCooccurrence(): number {
  const db = getDb();
  db.exec("DELETE FROM atlas_entity_cooccur");

  const pairs = db
    .prepare<
      { a: number; b: number; weight: number; last_seen: string },
      []
    >(
      `SELECT MIN(m1.entity_id, m2.entity_id) AS a,
              MAX(m1.entity_id, m2.entity_id) AS b,
              COUNT(*) AS weight,
              MAX(m1.created_at) AS last_seen
       FROM atlas_entity_mentions m1
       JOIN atlas_entity_mentions m2 ON m2.item_id = m1.item_id AND m2.entity_id > m1.entity_id
       GROUP BY a, b`,
    )
    .all();

  const insert = db.prepare(
    "INSERT INTO atlas_entity_cooccur (entity_a, entity_b, weight, last_seen) VALUES (?, ?, ?, ?)",
  );
  for (const p of pairs) insert.run(p.a, p.b, p.weight, p.last_seen);
  log.info("Rebuilt atlas_entity_cooccur", { pairs: pairs.length });
  return pairs.length;
}

// ---------------- Query helpers for the Library UI (Phase 5) ----------------

export interface EntityRow {
  id: number;
  kind: EntityKind;
  name_norm: string;
  display_name: string;
  mention_count: number;
  first_seen: string;
  last_seen: string;
}

export interface EntityListOpts {
  kind?: EntityKind | null;
  limit?: number;
  orderBy?: "mentions" | "recent";
  minMentions?: number;
}

/** List entities for the library sidebar / entity-browser. */
export function listTopEntities(opts: EntityListOpts = {}): EntityRow[] {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const minMentions = opts.minMentions ?? 1;
  const order = opts.orderBy === "recent" ? "last_seen DESC, mention_count DESC" : "mention_count DESC, last_seen DESC";

  if (opts.kind) {
    return db
      .prepare<EntityRow, [string, number, number]>(
        `SELECT id, kind, name_norm, display_name, mention_count, first_seen, last_seen
         FROM atlas_entities
         WHERE kind = ? AND mention_count >= ?
         ORDER BY ${order}
         LIMIT ?`,
      )
      .all(opts.kind, minMentions, limit);
  }
  return db
    .prepare<EntityRow, [number, number]>(
      `SELECT id, kind, name_norm, display_name, mention_count, first_seen, last_seen
       FROM atlas_entities
       WHERE mention_count >= ?
       ORDER BY ${order}
       LIMIT ?`,
    )
    .all(minMentions, limit);
}

export function getEntity(id: number): EntityRow | null {
  const db = getDb();
  return (
    db
      .prepare<EntityRow, [number]>(
        `SELECT id, kind, name_norm, display_name, mention_count, first_seen, last_seen
         FROM atlas_entities WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export interface EntityItemRow {
  id: number;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  captured_at: string;
  confidence: number;
  context: string | null;
}

/** Items that mention this entity, newest first. Includes the mention confidence + context snippet. */
export function itemsForEntity(entityId: number, limit = 50): EntityItemRow[] {
  const db = getDb();
  return db
    .prepare<EntityItemRow, [number, number]>(
      `SELECT a.id, a.kind, a.title, a.body, a.url, a.captured_at,
              m.confidence, m.context
       FROM atlas_entity_mentions m
       JOIN atlas_items a ON a.id = m.item_id
       WHERE m.entity_id = ?
       ORDER BY a.captured_at DESC
       LIMIT ?`,
    )
    .all(entityId, limit);
}

export interface RelatedEntityRow {
  id: number;
  kind: EntityKind;
  display_name: string;
  weight: number;
  last_seen: string;
}

/** Strongest co-occurring entities for a given entity. */
export function relatedEntities(entityId: number, limit = 15): RelatedEntityRow[] {
  const db = getDb();
  return db
    .prepare<RelatedEntityRow, [number, number, number, number]>(
      `SELECT e.id, e.kind, e.display_name, c.weight, c.last_seen
       FROM atlas_entity_cooccur c
       JOIN atlas_entities e
         ON e.id = CASE WHEN c.entity_a = ? THEN c.entity_b ELSE c.entity_a END
       WHERE c.entity_a = ? OR c.entity_b = ?
       ORDER BY c.weight DESC, c.last_seen DESC
       LIMIT ?`,
    )
    .all(entityId, entityId, entityId, limit);
}

export interface ItemEntityRow {
  id: number;
  kind: EntityKind;
  display_name: string;
  confidence: number;
  context: string | null;
  mention_count: number;
}

/** Entities mentioned in a given atlas item, highest-confidence first. */
export function entitiesForItem(itemId: number, limit = 30): ItemEntityRow[] {
  const db = getDb();
  return db
    .prepare<ItemEntityRow, [number, number]>(
      `SELECT e.id, e.kind, e.display_name, m.confidence, m.context, e.mention_count
       FROM atlas_entity_mentions m
       JOIN atlas_entities e ON e.id = m.entity_id
       WHERE m.item_id = ?
       ORDER BY m.confidence DESC, e.mention_count DESC
       LIMIT ?`,
    )
    .all(itemId, limit);
}

export interface AliasProposalRow {
  id: number;
  entity_id: number;
  entity_name: string;
  entity_kind: EntityKind;
  alias_norm: string;
  reason: string | null;
  created_at: string;
}

export function pendingAliasProposals(limit = 50): AliasProposalRow[] {
  const db = getDb();
  return db
    .prepare<AliasProposalRow, [number]>(
      `SELECT p.id, p.entity_id, e.display_name AS entity_name, e.kind AS entity_kind,
              p.alias_norm, p.reason, p.created_at
       FROM atlas_alias_proposals p
       JOIN atlas_entities e ON e.id = p.entity_id
       WHERE p.status = 'pending'
       ORDER BY p.created_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

export function approveAliasProposal(id: number): boolean {
  const db = getDb();
  const row = db
    .prepare<{ entity_id: number; alias_norm: string }, [number]>(
      "SELECT entity_id, alias_norm FROM atlas_alias_proposals WHERE id = ? AND status = 'pending'",
    )
    .get(id);
  if (!row) return false;
  db.prepare(
    "INSERT OR IGNORE INTO atlas_entity_aliases (entity_id, alias_norm, source) VALUES (?, ?, 'approved')",
  ).run(row.entity_id, row.alias_norm);
  db.prepare(
    "UPDATE atlas_alias_proposals SET status = 'approved', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
  ).run(id);
  return true;
}

export function rejectAliasProposal(id: number): boolean {
  const db = getDb();
  const res = db
    .prepare(
      "UPDATE atlas_alias_proposals SET status = 'rejected', decided_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND status = 'pending'",
    )
    .run(id);
  return res.changes > 0;
}

/** Seed a small alias table — top tickers with common aliases. Idempotent. */
export function seedTickerAliases(): void {
  const SEED: Record<string, string[]> = {
    AAPL: ["apple", "apple inc"],
    MSFT: ["microsoft"],
    GOOGL: ["alphabet", "google"],
    GOOG: ["alphabet", "google"],
    NVDA: ["nvidia"],
    AMZN: ["amazon"],
    META: ["facebook", "meta platforms"],
    TSLA: ["tesla"],
    AMD: ["advanced micro devices"],
    INTC: ["intel"],
    NFLX: ["netflix"],
    BRK: ["berkshire hathaway"],
  };
  const db = getDb();
  const getEntity = db.prepare<{ id: number }, [string, string]>(
    "SELECT id FROM atlas_entities WHERE kind = ? AND name_norm = ?",
  );
  const insertEntity = db.prepare<{ id: number }, [string, string, string]>(
    `INSERT INTO atlas_entities (kind, name_norm, display_name, mention_count) VALUES (?, ?, ?, 0)
     RETURNING id`,
  );
  const insertAlias = db.prepare(
    `INSERT OR IGNORE INTO atlas_entity_aliases (entity_id, alias_norm, source) VALUES (?, ?, 'seed')`,
  );

  for (const [ticker, aliases] of Object.entries(SEED)) {
    const norm = normalizeEntity("ticker", ticker);
    if (!norm) continue;
    let row = getEntity.get("ticker", norm);
    if (!row) {
      row = insertEntity.get("ticker", norm, norm) ?? null;
    }
    if (!row) continue;
    for (const alias of aliases) {
      const aliasNorm = normalizeEntity("topic", alias);
      if (!aliasNorm) continue;
      insertAlias.run(row.id, aliasNorm);
    }
  }
}
