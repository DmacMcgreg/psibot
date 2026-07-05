import { Hono } from "hono";
import {
  tmaLibraryPage,
  tmaLibraryListFragment,
  tmaEntitiesPage,
  tmaEntityListFragment,
  tmaEntityDetailPage,
  tmaItemDetailPage,
  tmaSynthesisPage,
  tmaSynthesisFileViewPage,
  tmaAliasPage,
  tmaAliasListFragment,
  type SynthesisFile,
  type LibraryHealth,
} from "../../views/mini-app/library.ts";
import {
  counts as atlasCounts,
  listByKind as atlasListByKind,
  getItem as getAtlasItem,
  type AtlasKind,
} from "../../../atlas/index.ts";
import { hybridSearch } from "../../../atlas/search.ts";
import {
  listTopEntities,
  getEntity as getAtlasEntity,
  itemsForEntity,
  relatedEntities,
  entitiesForItem,
  pendingAliasProposals,
  approveAliasProposal,
  rejectAliasProposal,
  type EntityKind,
} from "../../../atlas/entities.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { type MiniAppEnv, requireIntParam } from "./shared.ts";

const KNOWN_KINDS = new Set<AtlasKind>([
  "inbox",
  "youtube",
  "signal",
  "research",
  "scan",
  "daily_log",
]);

function parseKind(raw: string | undefined): AtlasKind | "" {
  if (!raw) return "";
  if (KNOWN_KINDS.has(raw as AtlasKind)) return raw as AtlasKind;
  return "";
}

function parseEntityKind(raw: string | undefined): "" | EntityKind {
  if (raw === "ticker" || raw === "name" || raw === "topic") return raw;
  return "";
}

function parseEntityOrder(raw: string | undefined): "mentions" | "recent" {
  return raw === "recent" ? "recent" : "mentions";
}

function pendingAliasCount(): number {
  return pendingAliasProposals(500).length;
}

const KNOWLEDGE_DIR = pathResolve(process.cwd(), "knowledge");
const SYNTH_MEMORY_DIR = pathJoin(KNOWLEDGE_DIR, "memory");
const SYNTH_WEEKLY_DIR = pathJoin(KNOWLEDGE_DIR, "weekly");
const SYNTH_TRADING_DIR = pathJoin(KNOWLEDGE_DIR, "trading");
const MONTHLY_FILES = ["PLAYBOOK.md", "LESSONS.md", "MODELS.md", "RESEARCH.md"];

function listSynthesisFiles(): SynthesisFile[] {
  const files: SynthesisFile[] = [];
  if (existsSync(SYNTH_MEMORY_DIR)) {
    for (const entry of readdirSync(SYNTH_MEMORY_DIR)) {
      if (!entry.endsWith(".md")) continue;
      const full = pathJoin(SYNTH_MEMORY_DIR, entry);
      const rel = `knowledge/memory/${entry}`;
      files.push({
        path: rel,
        label: entry.replace(/\.md$/, ""),
        kind: "daily",
        mtime: statSync(full).mtimeMs,
      });
    }
  }
  if (existsSync(SYNTH_WEEKLY_DIR)) {
    for (const entry of readdirSync(SYNTH_WEEKLY_DIR)) {
      if (!entry.endsWith(".md")) continue;
      const full = pathJoin(SYNTH_WEEKLY_DIR, entry);
      const rel = `knowledge/weekly/${entry}`;
      files.push({
        path: rel,
        label: entry.replace(/\.md$/, ""),
        kind: "weekly",
        mtime: statSync(full).mtimeMs,
      });
    }
  }
  for (const f of MONTHLY_FILES) {
    const full = pathJoin(SYNTH_TRADING_DIR, f);
    if (existsSync(full)) {
      files.push({
        path: `knowledge/trading/${f}`,
        label: f.replace(/\.md$/, ""),
        kind: "monthly",
        mtime: statSync(full).mtimeMs,
      });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

function safeReadSynthesis(relPath: string): string | null {
  const full = pathResolve(process.cwd(), relPath);
  const base = pathResolve(process.cwd(), "knowledge");
  if (!full.startsWith(base + "/")) return null;
  if (!existsSync(full)) return null;
  return readFileSync(full, "utf-8");
}

/**
 * Collect the data shown in the health strip — atlas counts, pending alias count,
 * and the mtime of the most recent daily/weekly/monthly synthesis file. Called
 * from each of the four main library routes at request time so stats stay fresh.
 */
function libraryHealth(): LibraryHealth {
  const counts = atlasCounts();
  const aliasCount = pendingAliasProposals(500).length;
  const files = listSynthesisFiles();
  let lastDailyMs: number | null = null;
  let lastWeeklyMs: number | null = null;
  let lastMonthlyMs: number | null = null;
  for (const f of files) {
    if (f.kind === "daily" && (lastDailyMs === null || f.mtime > lastDailyMs)) {
      lastDailyMs = f.mtime;
    } else if (f.kind === "weekly" && (lastWeeklyMs === null || f.mtime > lastWeeklyMs)) {
      lastWeeklyMs = f.mtime;
    } else if (f.kind === "monthly" && (lastMonthlyMs === null || f.mtime > lastMonthlyMs)) {
      lastMonthlyMs = f.mtime;
    }
  }
  return {
    counts,
    pendingAliasCount: aliasCount,
    lastDailyMs,
    lastWeeklyMs,
    lastMonthlyMs,
  };
}

export function registerLibraryRoutes(app: Hono<MiniAppEnv>): void {
  app.get("/library", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const kind = parseKind(c.req.query("kind"));
    const health = libraryHealth();

    if (query) {
      const results = await hybridSearch(query, {
        kind: kind || undefined,
        limit: 30,
      });
      return c.html(
        tmaLibraryPage({
          query,
          kind,
          counts: health.counts,
          items: results,
          isSearch: true,
          pendingAliasCount: health.pendingAliasCount,
          health,
        }),
      );
    }

    const items = atlasListByKind(kind || null, 50, 0);
    return c.html(
      tmaLibraryPage({
        query: "",
        kind,
        counts: health.counts,
        items,
        isSearch: false,
        pendingAliasCount: health.pendingAliasCount,
        health,
      }),
    );
  });

  app.get("/api/library/search", async (c) => {
    const query = (c.req.query("q") ?? "").trim();
    const kind = parseKind(c.req.query("kind"));

    if (query) {
      const results = await hybridSearch(query, {
        kind: kind || undefined,
        limit: 30,
      });
      return c.html(tmaLibraryListFragment(results, query, true));
    }
    const items = atlasListByKind(kind || null, 50, 0);
    return c.html(tmaLibraryListFragment(items, "", false));
  });

  // --- Entities sub-page ---
  app.get("/library/entities", (c) => {
    const kindFilter = parseEntityKind(c.req.query("kind"));
    const orderBy = parseEntityOrder(c.req.query("order"));
    const entities = listTopEntities({
      kind: kindFilter || null,
      orderBy,
      limit: 80,
    });
    const health = libraryHealth();
    return c.html(
      tmaEntitiesPage({
        entities,
        counts: health.counts,
        kindFilter,
        orderBy,
        pendingAliasCount: health.pendingAliasCount,
        health,
      }),
    );
  });

  app.get("/api/library/entities", (c) => {
    const kindFilter = parseEntityKind(c.req.query("kind"));
    const orderBy = parseEntityOrder(c.req.query("order"));
    const entities = listTopEntities({
      kind: kindFilter || null,
      orderBy,
      limit: 80,
    });
    return c.html(tmaEntityListFragment(entities));
  });

  app.get("/library/items/:id", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Bad id", 400);
    const item = getAtlasItem(id);
    if (!item) return c.text("Item not found", 404);
    const entities = entitiesForItem(id, 30);
    const backParam = c.req.query("back");
    let backUrl = "/tma/library";
    let backLabel = "Library";
    if (backParam && backParam.startsWith("/tma/library/entities/")) {
      backUrl = backParam;
      backLabel = "Entity";
    }
    return c.html(
      tmaItemDetailPage({
        item,
        entities,
        pendingAliasCount: pendingAliasCount(),
        backUrl,
        backLabel,
      }),
    );
  });

  app.get("/library/entities/:id", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Bad id", 400);
    const entity = getAtlasEntity(id);
    if (!entity) return c.text("Entity not found", 404);
    const items = itemsForEntity(id, 100);
    const related = relatedEntities(id, 20);
    return c.html(
      tmaEntityDetailPage({
        entity,
        items,
        related,
        pendingAliasCount: pendingAliasCount(),
      }),
    );
  });

  // --- Synthesis sub-page ---
  app.get("/library/synthesis", (c) => {
    const files = listSynthesisFiles();
    const health = libraryHealth();
    return c.html(
      tmaSynthesisPage({
        files,
        pendingAliasCount: health.pendingAliasCount,
        health,
      }),
    );
  });

  // Standalone synthesis file view — its own page with BackButton.
  app.get("/library/synthesis/view", (c) => {
    const files = listSynthesisFiles();
    const reqPath = (c.req.query("path") ?? "").trim();
    const file = files.find((f) => f.path === reqPath) ?? null;
    if (!file) return c.text("File not found", 404);
    const content = safeReadSynthesis(file.path);
    const health = libraryHealth();
    return c.html(
      tmaSynthesisFileViewPage({
        file,
        content,
        pendingAliasCount: health.pendingAliasCount,
      }),
    );
  });

  // --- Alias proposals sub-page ---
  app.get("/library/aliases", (c) => {
    const proposals = pendingAliasProposals(100);
    const health = libraryHealth();
    return c.html(
      tmaAliasPage({
        proposals,
        pendingAliasCount: proposals.length,
        health,
      }),
    );
  });

  app.post("/api/library/aliases/:id/approve", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Bad id", 400);
    approveAliasProposal(id);
    return c.html(tmaAliasListFragment(pendingAliasProposals(100)));
  });

  app.post("/api/library/aliases/:id/reject", (c) => {
    const id = requireIntParam(c, "id");
    if (id === null) return c.text("Bad id", 400);
    rejectAliasProposal(id);
    return c.html(tmaAliasListFragment(pendingAliasProposals(100)));
  });
}
