/**
 * Fill in publish dates for archived tabs and saved links that lack one.
 *
 * One sweep, two callers: `scripts/backfill-page-published-at.ts` (the
 * backfill) and `PublishedDateSweepRunner` (every 20 minutes in the daemon,
 * so newly archived tabs get their date shortly after capture).
 *
 * Results land in PsiBot's own `page_published_dates` table, keyed by URL, so
 * tab-archive's database is only ever read (it is attached read-only; its
 * daemon keeps writing). Saved links (`pending_items`) also get
 * `pending_items.published_at` set. vivaldi-home reads both.
 *
 * Safe to rerun: a URL with a row is not fetched again, except rows whose
 * status is listed in `retryStatuses` (e.g. "error" for timeouts and 5xx),
 * at most 3 tries per URL.
 * A found date is never replaced and the saved date is never substituted.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  HostThrottle,
  resolvePublishedAt,
  youtubeVideoId,
  type ResolveResult,
  type ResolverDeps,
} from "./published-date-resolver.ts";

export const PAGE_DATES_DDL = `CREATE TABLE IF NOT EXISTS page_published_dates (
  url TEXT PRIMARY KEY,
  published_at TEXT,
  status TEXT NOT NULL,
  method TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  checked_at TEXT NOT NULL
)`;

/** pending_items sources that have no publish-date capture of their own. */
const ITEM_SOURCES = ["chrome-extension", "telegram", "manual"];
const MAX_CONCURRENCY = 4;
const MAX_ATTEMPTS = 3;

export function defaultTabArchiveDbPath(): string {
  return process.env.TAB_ARCHIVE_DB_PATH || `${homedir()}/.local/share/tab-archive/data/app.db`;
}

export interface SweepOptions {
  /** PsiBot's app.db, writable. */
  db: Database;
  /** tab-archive's app.db (opened read-only); null skips tabs. */
  tabArchiveDbPath?: string | null;
  sources?: Array<"items" | "tabs">;
  /** Most URLs to resolve in this run (newest first). */
  limit?: number;
  concurrency?: number;
  /** Re-try rows with these statuses (at most 3 tries per URL), e.g. ["error"] or ["error", "blocked"]. */
  retryStatuses?: string[];
  /** Count candidates only: no network, no writes. */
  dryRun?: boolean;
  githubToken?: string;
  redditToken?: () => Promise<string | null>;
  /** Batch YouTube lookup (videos.list, ≤50 IDs, 1 quota unit per call). */
  youtubeStats?: (ids: string[]) => Promise<Array<{ videoId: string; publishedAt?: string | null }>>;
  /** Test seam. */
  resolve?: (url: string, deps: ResolverDeps) => Promise<ResolveResult>;
  now?: Date;
  onProgress?: (done: number, total: number) => void;
}

export interface SweepReport {
  candidates: { items: number; tabs: number; unique: number; selected: number };
  byStatus: Record<string, number>;
  byMethod: Record<string, number>;
  failuresByHost: Record<string, number>;
  itemsUpdated: number;
  youtube: { fromDb: number; apiCalls: number; fromApi: number };
  durationMs: number;
}

/** at: latest save (sort order); firstSeen: earliest save (a page cannot come out after David saved it). */
interface Candidate { url: string; at: string; firstSeen: string; isItem: boolean; isTab: boolean }

/** Clock and timezone slop allowed between a declared publish date and the first save. */
const AFTER_SAVE_SLACK_MS = 24 * 60 * 60 * 1000;

export function ensurePageDatesTable(db: Database): void {
  db.exec(PAGE_DATES_DDL);
}

const UPSERT_SQL = `INSERT INTO page_published_dates (url, published_at, status, method, error, attempts, checked_at)
  VALUES (?, ?, ?, ?, ?, 1, ?)
  ON CONFLICT(url) DO UPDATE SET
    published_at = COALESCE(page_published_dates.published_at, excluded.published_at),
    status = CASE WHEN page_published_dates.published_at IS NOT NULL THEN page_published_dates.status ELSE excluded.status END,
    method = CASE WHEN page_published_dates.published_at IS NOT NULL THEN page_published_dates.method ELSE excluded.method END,
    error = excluded.error,
    attempts = page_published_dates.attempts + 1,
    checked_at = excluded.checked_at`;

/** Record one URL's result (capture path). A stored date is never replaced. */
export function recordPageDate(db: Database, url: string, r: ResolveResult): void {
  db.prepare(UPSERT_SQL).run(url, r.publishedAt, r.status, r.method, r.error ?? null, new Date().toISOString());
}

export async function sweepPublishedDates(opts: SweepOptions): Promise<SweepReport> {
  const started = Date.now();
  const { db } = opts;
  const sources = new Set(opts.sources ?? ["items", "tabs"]);
  if (!opts.dryRun) ensurePageDatesTable(db);
  const hasTable = !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'page_published_dates'`).get();

  // Saved links whose URL another pass (e.g. a tab) already resolved.
  let itemsUpdated = opts.dryRun || !hasTable ? 0 : copyKnownDatesToItems(db);

  const byUrl = new Map<string, Candidate>();
  const add = (url: string, at: string, firstSeen: string, kind: "item" | "tab") => {
    const c = byUrl.get(url) ?? { url, at, firstSeen, isItem: false, isTab: false };
    if (at > c.at) c.at = at;
    if (firstSeen && (!c.firstSeen || firstSeen < c.firstSeen)) c.firstSeen = firstSeen;
    if (kind === "item") c.isItem = true; else c.isTab = true;
    byUrl.set(url, c);
  };

  let itemCount = 0;
  if (sources.has("items")) {
    const rows = db.query(
      `SELECT url, COALESCE(captured_at, created_at) AS at FROM pending_items
       WHERE published_at IS NULL AND source IN (${ITEM_SOURCES.map(() => "?").join(",")})`,
    ).all(...ITEM_SOURCES) as Array<{ url: string; at: string | null }>;
    itemCount = rows.length;
    for (const r of rows) add(r.url, r.at ?? "", r.at ?? "", "item");
  }

  let tabCount = 0;
  const tabPath = opts.tabArchiveDbPath === undefined ? defaultTabArchiveDbPath() : opts.tabArchiveDbPath;
  if (sources.has("tabs") && tabPath && existsSync(tabPath)) {
    const tabs = new Database(tabPath, { readonly: true });
    try {
      tabs.exec("PRAGMA busy_timeout = 5000");
      // Same rows the Library shows: not excluded, not dead.
      const rows = tabs.query(
        `SELECT url, max(archived_at) AS at, min(archived_at) AS first FROM tab_archive_tabs WHERE excluded = 0 AND status != 'dead' GROUP BY url`,
      ).all() as Array<{ url: string; at: string; first: string }>;
      tabCount = rows.length;
      for (const r of rows) add(r.url, r.at ?? "", r.first ?? "", "tab");
    } finally {
      tabs.close();
    }
  }

  // Drop URLs already checked (unless retrying transient errors).
  const done = new Map<string, { status: string; attempts: number }>();
  if (hasTable) {
    for (const r of db.query(`SELECT url, status, attempts FROM page_published_dates`).all() as Array<{ url: string; status: string; attempts: number }>) {
      done.set(r.url, r);
    }
  }
  const pending = [...byUrl.values()].filter((c) => {
    const prior = done.get(c.url);
    if (!prior) return true;
    return !!opts.retryStatuses?.includes(prior.status) && prior.attempts < MAX_ATTEMPTS;
  });
  pending.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const selected = opts.limit ? pending.slice(0, opts.limit) : pending;

  const report: SweepReport = {
    candidates: { items: itemCount, tabs: tabCount, unique: byUrl.size, selected: selected.length },
    byStatus: {},
    byMethod: {},
    failuresByHost: {},
    itemsUpdated,
    youtube: { fromDb: 0, apiCalls: 0, fromApi: 0 },
    durationMs: 0,
  };
  if (opts.dryRun || selected.length === 0) {
    report.durationMs = Date.now() - started;
    return report;
  }

  const videoDates = await prefetchYoutube(db, selected, opts, report);

  const deps: ResolverDeps = {
    githubToken: opts.githubToken,
    redditToken: opts.redditToken,
    youtubeVideoDate: (id) => videoDates.get(id),
    throttle: new HostThrottle(),
    now: opts.now,
  };
  const resolve = opts.resolve ?? ((url: string, d: ResolverDeps) => resolvePublishedAt(url, d));
  const upsert = db.prepare(UPSERT_SQL);
  const setItem = db.prepare(`UPDATE pending_items SET published_at = ? WHERE url = ? AND published_at IS NULL`);

  const queue = [...selected];
  let finished = 0;
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      let r: ResolveResult;
      try {
        r = await resolve(c.url, deps);
      } catch (err) {
        r = { publishedAt: null, status: "error", method: "exception", error: String(err).slice(0, 200) };
      }
      r = rejectAfterSave(r, c.firstSeen);
      upsert.run(c.url, r.publishedAt, r.status, r.method, r.error ?? null, new Date().toISOString());
      if (r.publishedAt && c.isItem) report.itemsUpdated += setItem.run(r.publishedAt, c.url).changes;
      report.byStatus[r.status] = (report.byStatus[r.status] ?? 0) + 1;
      const methodKey = r.method.startsWith("json-ld:") ? "json-ld" : r.method;
      report.byMethod[methodKey] = (report.byMethod[methodKey] ?? 0) + 1;
      if (r.status === "gone" || r.status === "blocked" || r.status === "error") {
        const host = hostOf(c.url);
        report.failuresByHost[host] = (report.failuresByHost[host] ?? 0) + 1;
      }
      opts.onProgress?.(++finished, selected.length);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? MAX_CONCURRENCY, MAX_CONCURRENCY));
  await Promise.all(Array.from({ length: n }, worker));

  report.durationMs = Date.now() - started;
  return report;
}

/**
 * A page cannot have come out after David first saved it. A later declared
 * date means the URL now serves different content (a home page, a live doc)
 * or stamps the render time, so it is recorded as "none", never stored.
 */
export function rejectAfterSave(r: ResolveResult, firstSeen: string): ResolveResult {
  if (!r.publishedAt || !firstSeen) return r;
  const seen = Date.parse(/[T ]\d/.test(firstSeen) ? firstSeen.replace(" ", "T") : firstSeen);
  if (!Number.isFinite(seen) || Date.parse(r.publishedAt) <= seen + AFTER_SAVE_SLACK_MS) return r;
  return { publishedAt: null, status: "none", method: `${r.method}:after-saved`, error: `declared ${r.publishedAt}, first saved ${firstSeen}` };
}

/** Copy dates this table already knows onto saved links that lack one. */
function copyKnownDatesToItems(db: Database): number {
  return db.prepare(
    `UPDATE pending_items SET published_at = (
       SELECT d.published_at FROM page_published_dates d WHERE d.url = pending_items.url)
     WHERE published_at IS NULL AND source IN (${ITEM_SOURCES.map(() => "?").join(",")})
       AND EXISTS (SELECT 1 FROM page_published_dates d WHERE d.url = pending_items.url AND d.published_at IS NOT NULL)`,
  ).run(...ITEM_SOURCES).changes;
}

/** YouTube dates from PsiBot's own tables first, then videos.list in batches of 50. */
async function prefetchYoutube(db: Database, selected: Candidate[], opts: SweepOptions, report: SweepReport): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const c of selected) {
    try {
      const id = youtubeVideoId(new URL(c.url));
      if (id) ids.add(id);
    } catch { /* invalid URL: the resolver reports it */ }
  }
  const dates = new Map<string, string>();
  if (ids.size === 0) return dates;

  const cols = (t: string) => (db.query(`SELECT name FROM pragma_table_info(?)`).all(t) as Array<{ name: string }>).map((r) => r.name);
  const lookups: string[] = [];
  if (cols("youtube_videos").includes("published_at")) lookups.push(`SELECT published_at FROM youtube_videos WHERE video_id = ?1 AND published_at IS NOT NULL`);
  if (cols("discovery_candidates").includes("published_at")) lookups.push(`SELECT published_at FROM discovery_candidates WHERE video_id = ?1 AND published_at IS NOT NULL AND published_at != ''`);
  const stmt = lookups.length ? db.prepare(`${lookups.join(" UNION ALL ")} LIMIT 1`) : null;
  for (const id of ids) {
    const row = stmt?.get(id) as { published_at: string } | null | undefined;
    if (row?.published_at) {
      dates.set(id, row.published_at);
      report.youtube.fromDb++;
    }
  }

  const missing = [...ids].filter((id) => !dates.has(id));
  if (opts.youtubeStats) {
    for (let i = 0; i < missing.length; i += 50) {
      try {
        const stats = await opts.youtubeStats(missing.slice(i, i + 50));
        report.youtube.apiCalls++;
        for (const s of stats) {
          if (s.publishedAt) {
            dates.set(s.videoId, s.publishedAt);
            report.youtube.fromApi++;
          }
        }
      } catch {
        // No quota or no auth: those videos fall back to the watch page's own markup.
        break;
      }
    }
  }
  return dates;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "(invalid)";
  }
}

/** Share of rows with a date, per source, for reports. */
export function coverage(db: Database, tabArchiveDbPath: string | null = defaultTabArchiveDbPath()): Record<string, { total: number; dated: number }> {
  const out: Record<string, { total: number; dated: number }> = {};
  const hasDates = !!db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'page_published_dates'`).get();
  for (const src of ITEM_SOURCES) {
    const r = db.query(`SELECT count(*) total, count(published_at) dated FROM pending_items WHERE source = ?`).get(src) as { total: number; dated: number };
    if (r.total) out[`items:${src}`] = r;
  }
  if (tabArchiveDbPath && existsSync(tabArchiveDbPath)) {
    const tabs = new Database(tabArchiveDbPath, { readonly: true });
    try {
      const urls = tabs.query(`SELECT DISTINCT url FROM tab_archive_tabs WHERE excluded = 0 AND status != 'dead'`).all() as Array<{ url: string }>;
      let dated = 0;
      if (hasDates) {
        const q = db.prepare(`SELECT 1 FROM page_published_dates WHERE url = ? AND published_at IS NOT NULL`);
        for (const { url } of urls) if (q.get(url)) dated++;
      }
      out["tabs:unique-urls"] = { total: urls.length, dated };
    } finally {
      tabs.close();
    }
  }
  return out;
}
