/**
 * Asset registry store. One row per real-world thing, deduped on `key`, with
 * every sighting kept in asset_sources. Re-seeing an asset never lowers its
 * score or resets what David did with it; the one exception is a feed
 * re-scoring an opportunity (an amendment can add a disqualifier).
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDb } from "../db/index.ts";
import { canonicalUrl } from "../relevance/canon.ts";
import { trackWeight } from "./goals.ts";
import { HOMES } from "./homes.ts";
import {
  ASSET_KINDS, ASSET_STATUSES,
  type AssetInput, type AssetSourceInput, type AssetRow, type AssetSourceRow,
  type AssetKind, type AssetStatus, type ExtractionStatus, type AssetDetails,
} from "./types.ts";

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export function slug(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 80);
}

/**
 * Dedupe key. Hugging Face and GitHub repos key on their repo id so every link
 * form of one repo merges; other URLs use the canonical URL; techniques and
 * URL-less items key on kind + title slug.
 *
 * - `hf:<dataset|model|space>:owner/name`: the repo type comes from the URL
 *   path (/datasets/, /spaces/, else a model).
 * - `gh:owner/name`, or `gh:owner/name#<skill>` when the asset is one skill
 *   inside a multi-skill repo (details.skill_name, a …/skills/<name> or
 *   …/plugins/<name> path, or a skills.sh/<owner>/<repo>/<skill> page).
 * - A repo URL wins over details.repo / details.repo_id, which are the model's
 *   free text and count only when they are a bare "owner/name".
 * - `design_ref:<page>`: one per page. On a component-library site
 *   (designLibraryIds) the site's root is the library itself; deeper pages
 *   name blocks and keep their own key.
 */
export function assetKey(a: Pick<AssetInput, "kind" | "title" | "url" | "details">): string {
  const d = a.details ?? {};
  if (a.kind === "tool" || a.kind === "skill" || a.kind === "dataset") {
    const hf = hfRepo(a.url);
    if (hf) return `hf:${hf.type}:${hf.id}`;
    const skillName = typeof d.skill_name === "string" ? d.skill_name : null;
    const gh = ghRepo(a.url);
    if (gh) return ghKey(gh.repo, gh.skill ?? skillName);
    const repoId = a.kind === "dataset" ? bareRepo(d.repo_id) : null;
    if (repoId) return `hf:dataset:${repoId}`;
    const repo = bareRepo(d.repo);
    if (repo) return ghKey(repo, skillName);
  }
  if (a.kind === "technique" || a.kind === "prompt" || !a.url) return `${a.kind}:${slug(a.title)}`;
  if (a.kind === "design_ref") {
    const page = designRefPage(a.url);
    if (page) return `design_ref:${page}`;
  }
  return canonicalUrl(a.url) ?? `${a.kind}:${slug(a.title)}`;
}

/** "owner/name" as GitHub and Hugging Face spell repo ids. */
const REPO_ID = /^[\w.-]+\/[\w.-]+$/;
const bareRepo = (v: unknown): string | null =>
  typeof v === "string" && REPO_ID.test(v.trim()) ? v.trim().toLowerCase().replace(/\.git$/, "") : null;

// First path segments that are site pages, not repo owners.
const GH_PAGES = new Set(["about", "apps", "collections", "customer-stories", "enterprise", "events", "explore", "features", "login", "marketplace", "new", "notifications", "orgs", "pricing", "readme", "search", "settings", "site", "sponsors", "topics", "trending"]);
const HF_PAGES = new Set(["api", "blog", "chat", "collections", "docs", "enterprise", "join", "learn", "login", "models", "organizations", "papers", "posts", "pricing", "settings", "tasks"]);
const SKILLS_SH_PAGES = new Set(["api", "docs", "search"]);

function urlParts(url: string | null | undefined): { host: string; segs: string[] } | null {
  const s = (url ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][\w+.-]*:/i.test(s) ? s : "https://" + s);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), segs: u.pathname.split("/").filter(Boolean) };
  } catch {
    return null;
  }
}

function hfRepo(url: string | null | undefined): { type: "dataset" | "model" | "space"; id: string } | null {
  const p = urlParts(url);
  if (!p || (p.host !== "huggingface.co" && p.host !== "hf.co")) return null;
  const type = p.segs[0] === "datasets" ? "dataset" : p.segs[0] === "spaces" ? "space" : "model";
  const [owner, name] = type === "model" ? p.segs : p.segs.slice(1);
  if (!owner || !name || (type === "model" && HF_PAGES.has(owner.toLowerCase()))) return null;
  const id = `${owner}/${name}`.toLowerCase();
  return REPO_ID.test(id) ? { type, id } : null;
}

/** GitHub repo behind a github.com or skills.sh URL, and the one skill the URL points at, if any. */
function ghRepo(url: string | null | undefined): { repo: string; skill: string | null } | null {
  const p = urlParts(url);
  if (!p) return null;
  const [owner, name, ...rest] = p.segs;
  if (!owner || !name) return null;
  let skill: string | null = null;
  if (p.host === "skills.sh") {
    if (SKILLS_SH_PAGES.has(owner.toLowerCase())) return null;
    skill = rest[0] ?? null;
  } else if (p.host === "github.com") {
    if (GH_PAGES.has(owner.toLowerCase())) return null;
    // …/tree/<branch>/…/skills/<name>; a blob right under skills/ is a file, not a skill folder.
    if (rest[0] === "tree" || rest[0] === "blob") {
      const i = Math.max(rest.lastIndexOf("skills"), rest.lastIndexOf("plugins"));
      if (i >= 2 && rest[i + 1] && !(rest[0] === "blob" && i + 2 === rest.length)) skill = rest[i + 1];
    }
  } else {
    return null;
  }
  const repo = bareRepo(`${owner}/${name}`);
  return repo ? { repo, skill } : null;
}

/**
 * `gh:owner/name#skill` for one skill in a grab-bag repo. A single-skill repo's
 * skill usually carries the repo's name ("golive-skill" → "golive"), so it
 * keeps the whole-repo key and merges with plain repo sightings.
 */
function ghKey(repo: string, skill: string | null): string {
  const bare = (s: string) => slug(s).replace(/^(claude|agent)-/, "").replace(/-?(skills?|plugin)$/, "");
  const s = skill ? slug(skill) : "";
  return s && bare(s) !== bare(repo.split("/")[1]) ? `gh:${repo}#${s}` : `gh:${repo}`;
}

/**
 * The page a design ref points at: canonical URL without its query (YouTube
 * keeps its video id), or the library it belongs to on a component-library site.
 */
function designRefPage(url: string): string | null {
  const c = canonicalUrl(url);
  if (!c) return null;
  const page = c.startsWith("youtube.com/watch?") ? c : c.replace(/\?.*$/, "");
  const [host, first, ...rest] = page.split("/");
  const libs = designLibraryIds();
  // A library's own root is the library; a deeper page names a block, which
  // GOALS.md counts as new work ("a design ref from a library it already has
  // is not new unless it names a specific block worth reproducing").
  if (first && libs.has(`${host}/${first.toLowerCase()}`)) return rest.length ? page : `${host}/${first.toLowerCase()}`;
  if (libs.has(host)) return first ? page : host;
  return page;
}

const LIBRARY_HOSTS = ["reui.io", "shadcnblocks.com", "ui.shadcn.com", "magicui.design"];
/** Hosts that carry many unrelated things; a library there never claims the whole host. */
const SHARED_HOSTS = new Set(["behance.net", "codepen.io", "dribbble.com", "figma.com", "framer.com", "github.com", "gitlab.com", "medium.com", "npmjs.com", "tailkits.com", "vercel.com", "x.com", "youtube.com"]);
let libraryCache: { path: string; ids: Set<string> } | null = null;

/**
 * Component-library identities: a host ("reui.io"), or host + first path
 * segment when the library lives under a path ("tailwindcss.com/plus").
 * LIBRARY_HOSTS plus every library in design-kit's catalog, read once per
 * process; without design-kit the fixed list still applies.
 */
export function designLibraryIds(path = join(dirname(HOMES.designKitIntakeDir), "libraries.json")): Set<string> {
  if (libraryCache?.path === path) return libraryCache.ids;
  const ids = new Set(LIBRARY_HOSTS);
  try {
    for (const lib of JSON.parse(readFileSync(path, "utf-8")) as { url?: unknown }[]) {
      const c = typeof lib?.url === "string" ? canonicalUrl(lib.url)?.replace(/\?.*$/, "") : null;
      const [host, first] = (c ?? "").split("/");
      if (host && !SHARED_HOSTS.has(host)) ids.add(first ? `${host}/${first.toLowerCase()}` : host);
    }
  } catch { /* no design-kit catalog */ }
  libraryCache = { path, ids };
  return ids;
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(n) ? n : 0)));
}

/** Insert or merge an asset and record the sighting. */
export function upsertAsset(input: AssetInput, source: AssetSourceInput): { id: number; created: boolean } {
  if (!ASSET_KINDS.includes(input.kind)) throw new Error(`unknown asset kind: ${input.kind}`);
  const db = getDb();
  const key = assetKey(input);
  const score = clampScore(input.value_score);
  const tracks = [...new Set([input.track, ...(input.tracks ?? [])].filter(Boolean))];
  const existing = db.prepare<AssetRow, [string]>(`SELECT * FROM assets WHERE key = ?`).get(key);

  let id: number;
  let created = false;
  db.exec("BEGIN");
  try {
    if (!existing) {
      const r = db.prepare(
        `INSERT INTO assets (key, kind, title, url, summary, track, tracks_json, value_score, value_reason,
           next_action, effort, details_json, deadline, amount, published_at, extractor)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        key, input.kind, input.title.trim(), input.url ?? null, input.summary.trim(), input.track,
        JSON.stringify(tracks), score, input.value_reason.trim(), input.next_action.trim(), input.effort ?? null,
        JSON.stringify(input.details ?? {}), input.deadline ?? null, input.amount ?? null,
        input.published_at ?? null, input.extractor ?? null,
      );
      id = Number(r.lastInsertRowid);
      created = true;
    } else {
      id = existing.id;
      // A feed's re-score of an opportunity replaces the old judgment, even when
      // lower (an amendment can add a clearance requirement). Everything else
      // keeps its best score.
      const rescore = input.kind === "opportunity" && existing.kind === "opportunity" && !!input.extractor?.startsWith("feed:");
      const better = score > existing.value_score || rescore;
      const mergedTracks = [...new Set([...JSON.parse(existing.tracks_json || "[]"), ...tracks])];
      const oldDetails = JSON.parse(existing.details_json || "{}") as AssetDetails;
      const mergedDetails: AssetDetails = { ...(input.details ?? {}), ...stripEmpty(oldDetails) };
      if (better) Object.assign(mergedDetails, stripEmpty(input.details ?? {}));
      db.prepare(
        `UPDATE assets SET
           title = CASE WHEN ? THEN ? ELSE title END,
           url = COALESCE(url, ?),
           summary = CASE WHEN ? OR summary = '' THEN ? ELSE summary END,
           track = CASE WHEN ? THEN ? ELSE track END,
           tracks_json = ?,
           value_score = CASE WHEN ? THEN ? ELSE MAX(value_score, ?) END,
           value_reason = CASE WHEN ? THEN ? ELSE value_reason END,
           next_action = CASE WHEN ? OR next_action = '' THEN ? ELSE next_action END,
           effort = COALESCE(effort, ?),
           details_json = ?,
           deadline = COALESCE(?, deadline),
           amount = COALESCE(amount, ?),
           published_at = COALESCE(published_at, ?),
           updated_at = ?
         WHERE id = ?`,
      ).run(
        better ? 1 : 0, input.title.trim(), input.url ?? null,
        better ? 1 : 0, input.summary.trim(),
        better ? 1 : 0, input.track,
        JSON.stringify(mergedTracks), rescore ? 1 : 0, score, score,
        better ? 1 : 0, input.value_reason.trim(),
        better ? 1 : 0, input.next_action.trim(),
        input.effort ?? null, JSON.stringify(mergedDetails),
        input.deadline ?? null, input.amount ?? null, input.published_at ?? null, now(), id,
      );
    }
    db.prepare(
      `INSERT INTO asset_sources (asset_id, source_kind, source_ref, source_url, source_title, evidence)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(asset_id, source_kind, source_ref) DO UPDATE SET
         evidence = COALESCE(excluded.evidence, evidence), seen_at = excluded.seen_at`,
    ).run(id, source.source_kind, source.source_ref, source.source_url ?? null, source.source_title ?? null, source.evidence ?? null);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { id, created };
}

function stripEmpty(d: AssetDetails): AssetDetails {
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && v.length === 0)));
}

// --- extraction bookkeeping ---

export function getExtraction(sourceKind: string, sourceRef: string, version: string) {
  return getDb()
    .prepare<{ status: ExtractionStatus; attempts: number; n_assets: number }, [string, string, string]>(
      `SELECT status, attempts, n_assets FROM asset_extractions WHERE source_kind = ? AND source_ref = ? AND version = ?`,
    )
    .get(sourceKind, sourceRef, version) ?? null;
}

export function recordExtraction(r: {
  source_kind: string; source_ref: string; version: string; status: ExtractionStatus;
  gate_score?: number | null; n_assets?: number; model?: string | null; error?: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO asset_extractions (source_kind, source_ref, version, status, gate_score, n_assets, model, error)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(source_kind, source_ref, version) DO UPDATE SET
       status = excluded.status, gate_score = COALESCE(excluded.gate_score, gate_score),
       n_assets = excluded.n_assets, model = excluded.model, error = excluded.error,
       attempts = attempts + 1, created_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
  ).run(r.source_kind, r.source_ref, r.version, r.status, r.gate_score ?? null, r.n_assets ?? 0, r.model ?? null, r.error ?? null);
}

// --- reads ---

/** Deadlines are dates in David's time zone; a deadline stays open to the end of its day. */
export const DEADLINE_TZ = "America/Toronto";
/** A deadline in this year or later is a placeholder ("2099-11-22"): an open, rolling intake. */
export const ROLLING_DEADLINE_YEAR = 2090;
/** Deadlines this close add urgency to the rank. */
export const URGENT_WITHIN_DAYS = 21;
/** Revenue first: generic skill and tool packs count for less than paid work at the same score. */
const KIND_FACTOR: Partial<Record<AssetKind, number>> = { skill: 0.9, tool: 0.9 };

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** YYYY-MM-DD for `now` in `tz`. */
export function localDate(now: Date, tz = DEADLINE_TZ): string {
  let f = dayFormats.get(tz);
  if (!f) dayFormats.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(now);
}

/**
 * Whole days from today (in `tz`) to the deadline's date: 0 all through the
 * deadline day, negative once it has ended. Null without a usable deadline.
 */
export function daysUntil(deadline: string | null, now: Date, tz = DEADLINE_TZ): number | null {
  if (!deadline) return null;
  const d = Date.parse(deadline.slice(0, 10));
  if (!Number.isFinite(d)) return null;
  return Math.round((d - Date.parse(localDate(now, tz))) / 86_400_000);
}

/**
 * Rank, 0–100: value score × track weight (0–3 → ×0.75–1.0) × kind (skill and
 * tool ×0.9), plus urgency. A real deadline inside 21 days adds up to 15.75,
 * and an opportunity in that window gets 10 more; an opportunity with a
 * rolling or later deadline gets 3. A deadline that has ended ranks 0. Used
 * by every surface so they agree on "top".
 *
 * vivaldi-home/lib/assets.ts keeps a copy of rankOf, localDate and daysUntil
 * for its offline fallback: change both together.
 */
export function rankOf(a: Pick<AssetRow, "kind" | "value_score" | "track" | "deadline">, today = new Date()): number {
  const weight = Math.max(0, Math.min(3, trackWeight(a.track)));
  let r = a.value_score * (0.75 + weight / 12) * (KIND_FACTOR[a.kind] ?? 1);
  const days = daysUntil(a.deadline, today);
  if (days !== null) {
    if (days < 0) return 0;
    const rolling = Number(a.deadline!.slice(0, 4)) >= ROLLING_DEADLINE_YEAR;
    if (!rolling && days <= URGENT_WITHIN_DAYS) r += (URGENT_WITHIN_DAYS - days) * 0.75 + (a.kind === "opportunity" ? 10 : 0);
    else if (a.kind === "opportunity") r += 3;
  }
  return Math.max(0, Math.min(100, Math.round(r)));
}

export interface AssetFilter {
  status?: AssetStatus | AssetStatus[] | "open"; // open = new|queued|in_use
  kind?: AssetKind;
  track?: string;
  minScore?: number;
  q?: string;
  limit?: number;
  offset?: number;
  /** Clock for ranks and expired deadlines (tests, simulations). */
  now?: Date;
}

export type RankedAsset = AssetRow & { rank: number; sources: number };

export function listAssets(f: AssetFilter = {}): RankedAsset[] {
  const now = f.now ?? new Date();
  const where: string[] = [];
  const args: (string | number)[] = [];
  const statuses = f.status === "open" ? ["new", "queued", "in_use"] : f.status ? [f.status].flat() : null;
  if (statuses) {
    where.push(`a.status IN (${statuses.map(() => "?").join(",")})`);
    args.push(...statuses);
  }
  if (f.kind) { where.push("a.kind = ?"); args.push(f.kind); }
  if (f.track) { where.push("(a.track = ? OR a.tracks_json LIKE ?)"); args.push(f.track, `%"${f.track}"%`); }
  if (f.minScore != null) { where.push("a.value_score >= ?"); args.push(f.minScore); }
  if (f.q) { where.push("(a.title LIKE ? OR a.summary LIKE ? OR a.details_json LIKE ?)"); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  where.push("(a.deadline IS NULL OR a.deadline >= ?)");
  args.push(localDate(now));
  const rows = getDb().prepare<AssetRow & { sources: number }, (string | number)[]>(
    `SELECT a.*, (SELECT COUNT(*) FROM asset_sources s WHERE s.asset_id = a.id) AS sources
     FROM assets a ${where.length ? "WHERE " + where.join(" AND ") : ""}`,
  ).all(...args);
  const ranked = rows
    .map((r) => ({ ...r, rank: rankOf(r, now) }))
    .sort((a, b) => b.rank - a.rank || b.value_score - a.value_score || b.id - a.id);
  const off = f.offset ?? 0;
  return ranked.slice(off, off + (f.limit ?? 50));
}

export function getAsset(id: number): (AssetRow & { sources: AssetSourceRow[]; events: { action: string; note: string | null; created_at: string }[] }) | null {
  const db = getDb();
  const a = db.prepare<AssetRow, [number]>(`SELECT * FROM assets WHERE id = ?`).get(id);
  if (!a) return null;
  const sources = db.prepare<AssetSourceRow, [number]>(`SELECT * FROM asset_sources WHERE asset_id = ? ORDER BY seen_at DESC`).all(id);
  const events = db.prepare<{ action: string; note: string | null; created_at: string }, [number]>(
    `SELECT action, note, created_at FROM asset_events WHERE asset_id = ? ORDER BY id DESC`,
  ).all(id);
  return { ...a, sources, events };
}

/**
 * The asset a deleted duplicate was merged into, or null. Reads the "merged"
 * events that merges leave on the survivor ("rekey merged 236,240", "merged
 * duplicate asset #35"), so a Telegram button for a merged-away id still works.
 */
export function mergedInto(id: number, db: Database = getDb()): number | null {
  const rows = db.prepare<{ asset_id: number; note: string | null }, [string]>(
    `SELECT asset_id, note FROM asset_events WHERE action = 'merged' AND note LIKE ? ORDER BY id DESC`,
  ).all(`%${id}%`);
  for (const r of rows) {
    const ids = (r.note?.match(/\bmerged\b([^(]*)/)?.[1].match(/\d+/g) ?? []).map(Number);
    if (ids.includes(id) && r.asset_id !== id) return r.asset_id;
  }
  return null;
}

// --- writes from David's actions ---

export function addAssetEvent(assetId: number, action: string, note?: string | null): void {
  getDb().prepare(`INSERT INTO asset_events (asset_id, action, note) VALUES (?,?,?)`).run(assetId, action, note ?? null);
}

/** Change status and log the action as an outcome label. */
export function setAssetStatus(id: number, status: AssetStatus, action: string, note?: string | null, outcome?: string | null): void {
  if (!ASSET_STATUSES.includes(status)) throw new Error(`unknown status: ${status}`);
  const db = getDb();
  db.prepare(
    `UPDATE assets SET status = ?, outcome = COALESCE(?, outcome), acted_at = ?, updated_at = ? WHERE id = ?`,
  ).run(status, outcome ?? null, now(), now(), id);
  addAssetEvent(id, action, note);
}

export function setAssetHome(id: number, homePath: string): void {
  getDb().prepare(`UPDATE assets SET home_path = ?, updated_at = ? WHERE id = ?`).run(homePath, now(), id);
}

export function markSurfaced(ids: number[]): void {
  if (!ids.length) return;
  getDb().prepare(`UPDATE assets SET surfaced_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(now(), ...ids);
}

/**
 * Fold duplicates into one survivor (scripts/assets-rekey.ts and
 * assets-merge.ts). The survivor keeps its own text, URL, key and status, and
 * gains the union of tracks, the highest score, the latest surfaced_at, every
 * sighting and event, and any digest alert/reminder marks. The duplicates are
 * deleted, their sightings explicitly (no orphans even with foreign_keys off),
 * and one "<label> merged <ids>" event is logged for mergedInto().
 */
export function mergeAssets(keepId: number, dropIds: number[], label: string): void {
  const db = getDb();
  db.transaction(() => {
    const get = db.prepare<AssetRow, [number]>(`SELECT * FROM assets WHERE id = ?`);
    const keep = get.get(keepId);
    if (!keep) throw new Error(`merge survivor #${keepId} not found`);
    const drops = [...new Set(dropIds)].filter((id) => id !== keepId).map((id) => {
      const row = get.get(id);
      if (!row) throw new Error(`asset #${id} not found`);
      return row;
    });
    if (!drops.length) return;
    const all = [keep, ...drops];
    const tracks = [...new Set(all.flatMap((r) => [r.track, ...(JSON.parse(r.tracks_json || "[]") as string[])]))];
    const surfaced = all.map((r) => r.surfaced_at).filter((s): s is string => !!s).sort().pop() ?? null;
    db.prepare(`UPDATE assets SET tracks_json = ?, value_score = ?, surfaced_at = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(tracks), Math.max(...all.map((r) => r.value_score)), surfaced, now(), keepId);
    for (const d of drops) {
      db.prepare(
        `INSERT OR IGNORE INTO asset_sources (asset_id, source_kind, source_ref, source_url, source_title, evidence, seen_at)
         SELECT ?, source_kind, source_ref, source_url, source_title, evidence, seen_at FROM asset_sources WHERE asset_id = ?`,
      ).run(keepId, d.id);
      db.prepare(`DELETE FROM asset_sources WHERE asset_id = ?`).run(d.id);
      db.prepare(`UPDATE asset_events SET asset_id = ? WHERE asset_id = ?`).run(keepId, d.id);
      // Digest dedupe marks (src/assets/digest.ts): asset_digest:alert:<id>, asset_digest:remind:<id>:<7|2>.
      for (const suffix of ["", ":7", ":2"]) {
        const kind = suffix ? "remind" : "alert";
        db.prepare(`INSERT OR IGNORE INTO ops_state (key, value) SELECT ?, value FROM ops_state WHERE key = ?`)
          .run(`asset_digest:${kind}:${keepId}${suffix}`, `asset_digest:${kind}:${d.id}${suffix}`);
      }
      db.prepare(`DELETE FROM assets WHERE id = ?`).run(d.id);
    }
    addAssetEvent(keepId, "merged", `${label} merged ${drops.map((d) => d.id).join(",")}`);
  })();
}

export function assetCounts(): { track: string; kind: string; status: string; n: number }[] {
  return getDb().prepare<{ track: string; kind: string; status: string; n: number }, []>(
    `SELECT track, kind, status, COUNT(*) AS n FROM assets GROUP BY 1,2,3`,
  ).all();
}
