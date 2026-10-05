/**
 * Ground-truth label extraction for the relevance engine.
 *
 * Only human decisions count as labels. The rules, and why:
 *
 * VIDEOS (youtube_videos)
 *   - positive "chosen": the user sent the video themselves or saved it to
 *     Watch Later — playlist_item_id set, or never seen by discovery, or stored
 *     before discovery first found it.
 *   - explicit: discover_feedback interested / not_interested on the video's
 *     atlas item; feedback_log research|watch / archive|drop on a
 *     discovery-found video. Explicit beats implicit.
 *   - unlabeled: discovery-found videos with no feedback. NOT negatives — the
 *     benchmark reports "chosen vs unlabeled" as a positive-unlabeled (PU)
 *     proxy, clearly named as such.
 *   - pending_items status 'deleted' on YouTube URLs is the automatic triage
 *     (value_type no_value), never a human drop, so it is ignored.
 *
 * ARTICLES (non-YouTube pending_items)
 *   - feedback_log rows with item_id are written only by applyItemAction
 *     (Telegram buttons / Mini App review) — human. research|watch = relevant,
 *     drop[:reason] and archive:irrelevant|low_quality = not relevant; any
 *     other archive (no reason, known, outdated) is neutral. Latest row wins.
 *   - discover_feedback on inbox items: interested / not_interested.
 *   - status/auto_decision alone are NOT labels (auto-triage drops,
 *     heartbeat auto-research, NotePlan-note deletion all write them).
 *
 * ENTITIES (atlas_alias_proposals)
 *   - approved = merge, rejected = don't merge, pending = unlabeled. Proposals
 *     repeat per (entity, alias); the latest decision wins and conflicting
 *     histories are counted.
 */

import { Database } from "bun:sqlite";

export type ItemType = "video" | "article" | "entity";
export const ITEM_TYPES: ItemType[] = ["video", "article", "entity"];

export type LabelKind = "chosen" | "explicit_pos" | "explicit_neg" | "unlabeled";

export interface RelItem {
  key: string;
  type: ItemType;
  /** 1 relevant/merge, 0 not, null unlabeled. */
  label: 0 | 1 | null;
  labelKind: LabelKind;
  /** Stated reason for a negative (or positive) decision, when known. */
  reason: string | null;
  title: string;
  /** Profile-free item description sent to Jev as state. */
  content: Record<string, unknown>;
  /** Existing PsiBot signals, oriented so higher = more relevant. */
  baselines: Record<string, number | null>;
  /** Existing automatic category (discover group slug / value_type), for agreement only. */
  existingCategory: string | null;
  decidedAt: string | null;
}

// ─── pure helpers ───────────────────────────────────────────────────────────

/** Normalise SQLite timestamps ("2026-07-02 01:04:26Z" / "2026-07-02T01:04:26Z") to ISO. */
export function normTs(s: string | null | undefined): string | null {
  if (!s) return null;
  let t = s.trim().replace(" ", "T");
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t += "Z";
  return t.toUpperCase();
}

export interface ActionLabel {
  label: 0 | 1;
  action: string;
  reason: string | null;
}

/** Map a feedback_log.user_action to a relevance label. Unknown actions → null. */
export function feedbackActionLabel(userAction: string | null | undefined): ActionLabel | null {
  if (!userAction) return null;
  const [action, ...rest] = userAction.trim().toLowerCase().split(":");
  const reason = rest.length ? rest.join(":") : null;
  if (action === "research" || action === "watch" || action === "interested") {
    return { label: 1, action, reason };
  }
  if (action === "drop" || action === "not_interested") {
    return { label: 0, action, reason };
  }
  // Archive usually means "fine, but done with it" (David, 2026-09-25): only an
  // archive whose reason says the item itself was bad counts as not relevant.
  if (action === "archive" && (reason === "irrelevant" || reason === "low_quality")) {
    return { label: 0, action, reason };
  }
  return null;
}

/** discover_feedback sentiment → label; 'skipped' is neutral (null). */
export function sentimentLabel(sentiment: string): 0 | 1 | null {
  if (sentiment === "interested") return 1;
  if (sentiment === "not_interested") return 0;
  return null;
}

export interface VideoOrigin {
  created_at: string;
  playlist_item_id: string | null;
  first_discovered_at: string | null;
}

/** True when the user picked the video themselves (see module doc). */
export function isChosenVideo(v: VideoOrigin): boolean {
  if (v.playlist_item_id) return true;
  if (!v.first_discovered_at) return true;
  const created = normTs(v.created_at);
  const disc = normTs(v.first_discovered_at);
  return !!created && !!disc && created < disc;
}

export interface AliasDecisionRow {
  entity_id: number;
  alias_norm: string;
  status: string;
  decided_at: string | null;
  created_at: string;
}

export interface AliasDecision {
  entity_id: number;
  alias_norm: string;
  status: "approved" | "rejected" | "pending";
  decided_at: string | null;
  conflicting: boolean;
  duplicates: number;
}

/** Collapse repeated proposals per (entity, alias): latest decision wins. */
export function dedupeAliasDecisions(rows: AliasDecisionRow[]): AliasDecision[] {
  const groups = new Map<string, AliasDecisionRow[]>();
  for (const r of rows) {
    const k = `${r.entity_id}\u0000${r.alias_norm}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: AliasDecision[] = [];
  for (const g of groups.values()) {
    const decided = g.filter((r) => r.status === "approved" || r.status === "rejected");
    const statuses = new Set(decided.map((r) => r.status));
    let status: AliasDecision["status"] = "pending";
    let decidedAt: string | null = null;
    if (decided.length) {
      decided.sort((a, b) => (normTs(a.decided_at) ?? "").localeCompare(normTs(b.decided_at) ?? ""));
      const last = decided[decided.length - 1];
      status = last.status as "approved" | "rejected";
      decidedAt = last.decided_at;
    }
    out.push({
      entity_id: g[0].entity_id,
      alias_norm: g[0].alias_norm,
      status,
      decided_at: decidedAt,
      conflicting: statuses.size > 1,
      duplicates: g.length,
    });
  }
  return out;
}

/** First markdown section body ("## Overview" paragraph) trimmed to maxChars. */
export function summaryLead(markdown: string, maxChars = 700): string {
  const text = markdown.replace(/\r/g, "");
  const m = text.match(/##\s*Overview\s*\n+([\s\S]*?)(\n##\s|$)/i);
  const lead = (m ? m[1] : text).replace(/\s+/g, " ").trim();
  return lead.length > maxChars ? `${lead.slice(0, maxChars - 1)}…` : lead;
}

export function parseTags(json: string | null, max = 10): string[] {
  try {
    const t = JSON.parse(json ?? "[]");
    return Array.isArray(t) ? t.filter((x) => typeof x === "string").slice(0, max) : [];
  } catch {
    return [];
  }
}

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Alias-reason heuristic class: "plural" | "punctuation" | "tail" | "other". */
export function aliasReasonClass(reason: string | null): "plural" | "punctuation" | "tail" | "other" {
  const r = (reason ?? "").toLowerCase();
  if (r.startsWith("plural")) return "plural";
  if (r.startsWith("punctuation")) return "punctuation";
  if (r.startsWith("tail token")) return "tail";
  return "other";
}

// ─── DB loaders ─────────────────────────────────────────────────────────────

export function openReadonly(dbPath = "data/app.db"): Database {
  return new Database(dbPath, { readonly: true });
}

interface VideoRow {
  video_id: string;
  title: string;
  channel_title: string;
  tags: string;
  markdown_summary: string;
  created_at: string;
  playlist_item_id: string | null;
  first_discovered_at: string | null;
  dc_score: number | null;
  pending_id: number | null;
  priority: number | null;
  signal_score: number | null;
  group_slug: string | null;
}

export function loadVideos(db: Database): RelItem[] {
  const rows = db
    .query<VideoRow, []>(
      `SELECT yv.video_id, yv.title, yv.channel_title, yv.tags, yv.markdown_summary,
              yv.created_at, yv.playlist_item_id,
              (SELECT MIN(discovered_at) FROM discovery_candidates dc WHERE dc.video_id = yv.video_id) AS first_discovered_at,
              (SELECT MAX(score) FROM discovery_candidates dc WHERE dc.video_id = yv.video_id) AS dc_score,
              p.id AS pending_id, p.priority, p.signal_score,
              (SELECT g.slug FROM atlas_items ai
                 JOIN discover_item_groups dig ON dig.atlas_item_id = ai.id
                 JOIN discover_topic_groups g ON g.id = dig.group_id
                WHERE ai.source_table = 'youtube_videos' AND ai.source_id = yv.video_id LIMIT 1) AS group_slug
         FROM youtube_videos yv
         LEFT JOIN pending_items p ON p.url = 'https://www.youtube.com/watch?v=' || yv.video_id`,
    )
    .all();

  // Explicit Discover feedback on videos (latest per video).
  const df = db
    .query<{ video_id: string; sentiment: string; reasons_json: string; note: string | null; created_at: string }, []>(
      `SELECT ai.source_id AS video_id, df.sentiment, df.reasons_json, df.note, df.created_at
         FROM discover_feedback df JOIN atlas_items ai ON ai.id = df.atlas_item_id
        WHERE ai.source_table = 'youtube_videos'
        ORDER BY df.created_at`,
    )
    .all();
  const dfByVideo = new Map<string, (typeof df)[number]>();
  for (const r of df) dfByVideo.set(r.video_id, r);

  // Triage feedback on the video's pending item (latest per item).
  const fl = db
    .query<{ item_id: number; user_action: string; created_at: string }, []>(
      `SELECT item_id, user_action, created_at FROM feedback_log WHERE item_id IS NOT NULL ORDER BY created_at, id`,
    )
    .all();
  const flByItem = new Map<number, (typeof fl)[number]>();
  for (const r of fl) flByItem.set(r.item_id, r);

  const out: RelItem[] = [];
  for (const r of rows) {
    const chosen = isChosenVideo(r);
    let label: 0 | 1 | null = chosen ? 1 : null;
    let kind: LabelKind = chosen ? "chosen" : "unlabeled";
    let reason: string | null = null;
    let decidedAt: string | null = chosen ? r.created_at : null;

    const d = dfByVideo.get(r.video_id);
    const dl = d ? sentimentLabel(d.sentiment) : null;
    if (d && dl !== null) {
      label = dl;
      kind = dl === 1 ? "explicit_pos" : "explicit_neg";
      const reasons = parseTags(d.reasons_json, 5).filter((x) => x !== "skipped");
      reason = [...reasons, d.note ?? ""].filter(Boolean).join("; ") || null;
      decidedAt = d.created_at;
    } else if (!chosen && r.pending_id !== null) {
      const f = flByItem.get(r.pending_id);
      const fa = f ? feedbackActionLabel(f.user_action) : null;
      if (f && fa) {
        label = fa.label;
        kind = fa.label === 1 ? "explicit_pos" : "explicit_neg";
        reason = fa.reason;
        decidedAt = f.created_at;
      }
    }

    out.push({
      key: `video:${r.video_id}`,
      type: "video",
      label,
      labelKind: kind,
      reason,
      title: r.title,
      content: {
        title: r.title,
        channel: r.channel_title,
        tags: parseTags(r.tags),
        summary: summaryLead(r.markdown_summary),
      },
      baselines: {
        triage_priority: r.priority === null ? null : -r.priority,
        signal_score: r.signal_score,
        discovery_score: r.dc_score,
      },
      existingCategory: r.group_slug,
      decidedAt,
    });
  }
  return out;
}

interface ArticleRow {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  platform: string | null;
  source: string;
  profile: string | null;
  priority: number | null;
  signal_score: number | null;
  triage_summary: string | null;
  extracted_value: string | null;
  value_type: string | null;
  category: string | null;
}

export function loadArticles(db: Database, includeUnlabeled = false): RelItem[] {
  const rows = db
    .query<ArticleRow, []>(
      `SELECT id, url, title, description, platform, source, profile, priority, signal_score,
              triage_summary, extracted_value, value_type, category
         FROM pending_items
        WHERE COALESCE(platform, '') <> 'youtube' AND source <> 'youtube'`,
    )
    .all();
  const fl = db
    .query<{ item_id: number; user_action: string; created_at: string }, []>(
      `SELECT item_id, user_action, created_at FROM feedback_log WHERE item_id IS NOT NULL ORDER BY created_at, id`,
    )
    .all();
  const flByItem = new Map<number, (typeof fl)[number]>();
  for (const r of fl) flByItem.set(r.item_id, r);
  const df = db
    .query<{ item_id: number; sentiment: string; reasons_json: string; note: string | null; created_at: string }, []>(
      `SELECT CAST(ai.source_id AS INTEGER) AS item_id, df.sentiment, df.reasons_json, df.note, df.created_at
         FROM discover_feedback df JOIN atlas_items ai ON ai.id = df.atlas_item_id
        WHERE ai.source_table = 'pending_items' ORDER BY df.created_at`,
    )
    .all();
  const dfByItem = new Map<number, (typeof df)[number]>();
  for (const r of df) dfByItem.set(r.item_id, r);

  const out: RelItem[] = [];
  for (const r of rows) {
    let label: 0 | 1 | null = null;
    let reason: string | null = null;
    let decidedAt: string | null = null;
    const f = flByItem.get(r.id);
    const fa = f ? feedbackActionLabel(f.user_action) : null;
    if (f && fa) {
      label = fa.label;
      reason = fa.reason;
      decidedAt = f.created_at;
    }
    const d = dfByItem.get(r.id);
    const dl = d ? sentimentLabel(d.sentiment) : null;
    if (d && dl !== null && (!decidedAt || (normTs(d.created_at) ?? "") > (normTs(decidedAt) ?? ""))) {
      label = dl;
      reason = [...parseTags(d.reasons_json, 5), d.note ?? ""].filter(Boolean).join("; ") || null;
      decidedAt = d.created_at;
    }
    if (label === null && !includeUnlabeled) continue;
    const title = r.title ?? hostOf(r.url);
    out.push({
      key: `article:${r.id}`,
      type: "article",
      label,
      labelKind: label === null ? "unlabeled" : label === 1 ? "explicit_pos" : "explicit_neg",
      reason,
      title,
      content: {
        platform: r.platform ?? hostOf(r.url),
        source: r.profile ? `${r.source}/${r.profile}` : r.source,
        url: r.url,
        title,
        description: clip(r.description, 800),
        summary: clip(r.triage_summary, 500),
        extracted_value: clip(r.extracted_value, 400),
      },
      baselines: {
        triage_priority: r.priority === null ? null : -r.priority,
        signal_score: r.signal_score,
      },
      existingCategory: r.value_type ?? r.category,
      decidedAt,
    });
  }
  return out;
}

export function loadEntities(db: Database): { items: RelItem[]; conflicts: number; duplicateRows: number } {
  const rows = db
    .query<AliasDecisionRow & { reason: string | null }, []>(
      `SELECT entity_id, alias_norm, status, decided_at, created_at, reason FROM atlas_alias_proposals`,
    )
    .all();
  const reasonByKey = new Map<string, string | null>();
  for (const r of rows) reasonByKey.set(`${r.entity_id}\u0000${r.alias_norm}`, r.reason);
  const decisions = dedupeAliasDecisions(rows);

  const entStmt = db.query<{ id: number; kind: string; display_name: string; name_norm: string; mention_count: number }, [number]>(
    `SELECT id, kind, display_name, name_norm, mention_count FROM atlas_entities WHERE id = ?`,
  );
  const sameNameStmt = db.query<{ id: number; kind: string; display_name: string; mention_count: number }, [string, number]>(
    `SELECT id, kind, display_name, mention_count FROM atlas_entities WHERE name_norm = ? AND id <> ?
      ORDER BY mention_count DESC LIMIT 1`,
  );
  const containsStmt = db.query<{ n: number }, [string, string, string, number]>(
    `SELECT COUNT(*) AS n FROM atlas_entities
      WHERE (name_norm LIKE ? OR name_norm LIKE ? OR name_norm = ?) AND id <> ?`,
  );

  const items: RelItem[] = [];
  for (const d of decisions) {
    const e = entStmt.get(d.entity_id);
    if (!e) continue;
    const other = sameNameStmt.get(d.alias_norm, e.id);
    const containing = containsStmt.get(`% ${d.alias_norm}`, `${d.alias_norm} %`, d.alias_norm, e.id)?.n ?? 0;
    const reason = reasonByKey.get(`${d.entity_id}\u0000${d.alias_norm}`) ?? null;
    const rc = aliasReasonClass(reason);
    const label: 0 | 1 | null = d.status === "approved" ? 1 : d.status === "rejected" ? 0 : null;
    items.push({
      key: `entity:${e.id}:${d.alias_norm}`,
      type: "entity",
      label,
      labelKind: label === null ? "unlabeled" : label === 1 ? "explicit_pos" : "explicit_neg",
      reason: null,
      title: `${e.display_name} ← "${d.alias_norm}"`,
      content: {
        entity: { name: e.display_name, kind: e.kind, mentions: e.mention_count },
        proposed_alias: d.alias_norm,
        proposal_heuristic: reason ?? "",
        alias_is_separate_entity: other
          ? { name: other.display_name, kind: other.kind, mentions: other.mention_count }
          : null,
        other_entities_containing_alias: containing,
      },
      baselines: {
        // Naive rule a reviewer might apply: formatting variants yes, tail tokens no.
        heuristic_rule: rc === "plural" || rc === "punctuation" ? 1 : rc === "tail" ? 0 : 0.5,
      },
      existingCategory: rc,
      decidedAt: d.decided_at,
    });
  }
  return {
    items,
    conflicts: decisions.filter((d) => d.conflicting).length,
    duplicateRows: rows.length - decisions.length,
  };
}

/** Discover topic groups (slug → label), the category set reused for videos. */
export function loadTopicGroups(db: Database): Record<string, string> {
  const rows = db
    .query<{ slug: string; label: string }, []>(
      `SELECT slug, label FROM discover_topic_groups ORDER BY sort_order, item_count DESC`,
    )
    .all();
  return Object.fromEntries(rows.map((r) => [r.slug, r.label]));
}

export interface LabelStats {
  type: ItemType;
  total: number;
  positives: number;
  negatives: number;
  unlabeled: number;
  byKind: Record<string, number>;
}

export function labelStats(type: ItemType, items: RelItem[]): LabelStats {
  const byKind: Record<string, number> = {};
  for (const i of items) byKind[i.labelKind] = (byKind[i.labelKind] ?? 0) + 1;
  return {
    type,
    total: items.length,
    positives: items.filter((i) => i.label === 1).length,
    negatives: items.filter((i) => i.label === 0).length,
    unlabeled: items.filter((i) => i.label === null).length,
    byKind,
  };
}
