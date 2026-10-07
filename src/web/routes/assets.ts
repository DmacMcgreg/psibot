import { Hono, type Context } from "hono";
import { createLogger } from "../../shared/logger.ts";
import { listAssets, getAsset, assetCounts, rankOf, type AssetFilter } from "../../assets/store.ts";
import { loadGoals, saveGoals, parseGoals, type Track } from "../../assets/goals.ts";
import { runAssetAction, ActionError } from "../../assets/actions.ts";
import { ASSET_KINDS, ASSET_STATUSES, type AssetKind, type AssetRow, type AssetStatus } from "../../assets/types.ts";

/**
 * Asset registry API (contract: vivaldi-home/research/revamp-design.md,
 * "API contract"). Auth is the web app's global IP allowlist, the same as
 * /api/inbox: callers on 127.0.0.1 or the tailnet need no token.
 */

const log = createLogger("web:assets");

export interface GoalsStore {
  load(): { raw: string; tracks: Track[] };
  save(raw: string): { raw: string; tracks: Track[] };
}

const fileGoals: GoalsStore = { load: loadGoals, save: saveGoals };

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Row + parsed details/tracks + rank; `sources` stays whatever the caller passes. */
export function toApiAsset<R extends AssetRow>(row: R & { rank?: number }) {
  return {
    ...row,
    details: parseJson<Record<string, unknown>>(row.details_json, {}),
    tracks: parseJson<string[]>(row.tracks_json, []),
    rank: row.rank ?? rankOf(row),
  };
}

function fullAsset(id: number) {
  const a = getAsset(id);
  return a ? toApiAsset(a) : null;
}

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = await c.req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/** Problems that make a GOALS.md unusable by the extractors, or [] when it's fine. */
export function goalsProblems(raw: string): string[] {
  const problems: string[] = [];
  if (raw.length > 200_000) problems.push("GOALS.md is over 200 KB");
  const tracks = parseGoals(raw);
  if (tracks.length === 0) problems.push("keep at least one '## track: <id>' section");
  const seen = new Set<string>();
  for (const t of tracks) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) problems.push(`track id "${t.id}" must be lowercase letters, digits and dashes`);
    if (seen.has(t.id)) problems.push(`track "${t.id}" appears twice`);
    seen.add(t.id);
    if (!(t.weight >= 0 && t.weight <= 3)) problems.push(`track "${t.id}" weight must be 0–3`);
  }
  for (const m of raw.matchAll(/^weight:\s*(.*)$/gm)) {
    if (!/^\d+(\.\d+)?\s*$/.test(m[1])) problems.push(`"weight: ${m[1].trim()}" is not a number`);
  }
  return problems;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function createAssetRoutes(opts: { goals?: GoalsStore } = {}) {
  const goals = opts.goals ?? fileGoals;
  const app = new Hono();

  app.get("/api/assets", (c) => {
    const q = c.req.query();
    const f: AssetFilter = {};
    if (q.status) {
      if (q.status !== "open" && !ASSET_STATUSES.includes(q.status as AssetStatus)) {
        return c.json({ error: `status must be open or one of ${ASSET_STATUSES.join(", ")}` }, 400);
      }
      f.status = q.status as AssetFilter["status"];
    }
    if (q.kind) {
      if (!ASSET_KINDS.includes(q.kind as AssetKind)) return c.json({ error: `kind must be one of ${ASSET_KINDS.join(", ")}` }, 400);
      f.kind = q.kind as AssetKind;
    }
    if (q.track) f.track = q.track;
    if (q.q) f.q = q.q;
    const limit = Math.max(1, Math.min(500, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    const all = listAssets({ ...f, limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return c.json({ items: all.slice(offset, offset + limit).map(toApiAsset), total: all.length });
  });

  app.get("/api/assets/summary", (c) => {
    const open = listAssets({ status: "open", limit: Number.MAX_SAFE_INTEGER });
    const horizon = Date.now() + 21 * 86_400_000;
    const deadlines = open
      .filter((a) => a.deadline && Date.parse(a.deadline) <= horizon)
      .sort((a, b) => Date.parse(a.deadline!) - Date.parse(b.deadline!))
      .map(toApiAsset);
    return c.json({
      counts: assetCounts(),
      top: open.slice(0, 5).map(toApiAsset),
      deadlines,
      tracks: goals.load().tracks,
    });
  });

  app.get("/api/assets/:id{[0-9]+}", (c) => {
    const a = fullAsset(Number(c.req.param("id")));
    return a ? c.json(a) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/assets/:id{[0-9]+}/action", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await readBody(c);
    const action = str(body.action);
    if (!action) return c.json({ ok: false, error: "action is required", message: "action is required" }, 400);
    try {
      const r = await runAssetAction(id, action, { note: str(body.note) ?? null, outcome: str(body.outcome) ?? null });
      return c.json({ ...r, asset: toApiAsset(r.asset) });
    } catch (e) {
      if (e instanceof ActionError) return c.json({ ok: false, error: e.message, message: e.message }, e.status);
      log.error("Asset action failed", { id, action, error: String(e) });
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ ok: false, error: msg, message: `Action failed: ${msg}` }, 500);
    }
  });

  app.get("/api/goals", (c) => {
    const g = goals.load();
    return c.json({ raw: g.raw, tracks: g.tracks });
  });

  app.put("/api/goals", async (c) => {
    const body = await readBody(c);
    if (typeof body.raw !== "string" || !body.raw.trim()) return c.json({ error: "raw (the full GOALS.md text) is required" }, 400);
    const problems = goalsProblems(body.raw);
    if (problems.length) return c.json({ error: `Invalid GOALS.md: ${problems.join("; ")}`, problems }, 400);
    try {
      const g = goals.save(body.raw);
      log.info("Goals saved", { tracks: g.tracks.map((t) => t.id) });
      return c.json({ raw: g.raw, tracks: g.tracks });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  return app;
}
