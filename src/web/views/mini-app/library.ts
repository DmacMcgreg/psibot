import { miniAppLayout } from "./shell.ts";
import { escapeHtml } from "../../../shared/html.ts";
import type { AtlasItem, AtlasCounts, AtlasKind } from "../../../atlas/index.ts";
import type { HybridSearchResult } from "../../../atlas/search.ts";
import type {
  EntityRow,
  EntityItemRow,
  RelatedEntityRow,
  AliasProposalRow,
  ItemEntityRow,
} from "../../../atlas/entities.ts";

const KIND_LABEL: Record<string, string> = {
  inbox: "Inbox",
  youtube: "YouTube",
  signal: "Signal",
  research: "Research",
  scan: "Scan",
  daily_log: "Daily",
};

const KIND_COLOR: Record<string, string> = {
  inbox: "#3b82f6",
  youtube: "#ef4444",
  signal: "#10b981",
  research: "#a855f7",
  scan: "#f59e0b",
  daily_log: "#6b7280",
};

function kindBadge(kind: string): string {
  const label = KIND_LABEL[kind] ?? kind;
  const color = KIND_COLOR[kind] ?? "#6b7280";
  return `<span class="tma-badge" style="background:${color}20; color:${color}; font-size:11px; padding:2px 8px; border-radius:10px; font-weight:600;">${escapeHtml(label)}</span>`;
}

function snippet(body: string, max = 180): string {
  const trimmed = (body ?? "").replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).replace(/\s+\S*$/, "") + "\u2026";
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

/**
 * Compact "X ago" for health strip — sacrifices precision for glanceability.
 * Returns "never" if ms is null. Under 1h shows minutes, under 1d shows hours,
 * under 30d shows days, otherwise the calendar date.
 */
function formatAgo(ms: number | null): string {
  if (ms === null) return "never";
  const delta = Date.now() - ms;
  if (delta < 0) return "just now";
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return `${days}d ago`;
  }
}

export interface LibraryHealth {
  counts: AtlasCounts;
  pendingAliasCount: number;
  lastDailyMs: number | null;
  lastWeeklyMs: number | null;
  lastMonthlyMs: number | null;
}

function healthPill(
  label: string,
  value: string,
  opts: { warn?: boolean; href?: string } = {},
): string {
  const color = opts.warn
    ? "color:#b45309; background:rgba(245,158,11,0.12);"
    : "color:var(--tg-theme-hint-color,#6b7280); background:rgba(128,128,128,0.08);";
  const inner = `<span style="font-weight:600;">${escapeHtml(value)}</span> <span style="opacity:0.8;">${escapeHtml(label)}</span>`;
  const base = `display:inline-flex; gap:4px; align-items:center; padding:3px 8px; border-radius:10px; font-size:11px; white-space:nowrap; ${color}`;
  if (opts.href) {
    return `<a href="${opts.href}" style="${base} text-decoration:none;">${inner}</a>`;
  }
  return `<span style="${base}">${inner}</span>`;
}

function healthStrip(health: LibraryHealth | undefined): string {
  if (!health) return "";
  const { counts, pendingAliasCount, lastDailyMs, lastWeeklyMs, lastMonthlyMs } = health;
  const pills: string[] = [];
  pills.push(healthPill("items", counts.total.toLocaleString()));
  if (counts.awaitingEmbedding > 0) {
    pills.push(healthPill("awaiting embed", counts.awaitingEmbedding.toLocaleString(), { warn: true }));
  }
  if (counts.awaitingEntities > 0) {
    pills.push(healthPill("awaiting entities", counts.awaitingEntities.toLocaleString(), { warn: true }));
  }
  pills.push(healthPill("daily", formatAgo(lastDailyMs)));
  pills.push(healthPill("weekly", formatAgo(lastWeeklyMs)));
  pills.push(healthPill("monthly", formatAgo(lastMonthlyMs)));
  if (pendingAliasCount > 0) {
    pills.push(
      healthPill("aliases pending", pendingAliasCount.toLocaleString(), {
        warn: true,
        href: "/tma/library/aliases",
      }),
    );
  }
  return `<div style="padding:6px 16px; display:flex; gap:6px; flex-wrap:wrap; border-bottom:1px solid rgba(128,128,128,0.1);">${pills.join("")}</div>`;
}

export interface LibraryPageOpts {
  query?: string;
  kind?: AtlasKind | "";
  counts: AtlasCounts;
  items: AtlasItem[] | HybridSearchResult[];
  isSearch: boolean;
  pendingAliasCount?: number;
  health?: LibraryHealth;
}

export function tmaLibraryPage(opts: LibraryPageOpts): string {
  const { counts, items, query = "", kind = "", isSearch, pendingAliasCount = 0, health } = opts;

  const kindOptions = [
    `<option value="">All kinds (${counts.total})</option>`,
    ...Object.entries(counts.byKind).map(
      ([k, n]) =>
        `<option value="${escapeHtml(k)}"${k === kind ? " selected" : ""}>${escapeHtml(KIND_LABEL[k] ?? k)} (${n})</option>`,
    ),
  ].join("");

  const list = items.length > 0
    ? (items as Array<AtlasItem | HybridSearchResult>).map(renderItemCard).join("\n")
    : `<div class="tma-empty">No items${isSearch && query ? ` for "${escapeHtml(query)}"` : ""}.</div>`;

  const statsLine = counts.awaitingEmbedding > 0
    ? `<div class="tma-hint" style="font-size:11px; margin-top:4px;">${counts.awaitingEmbedding} awaiting embedding${counts.awaitingEntities > 0 ? `, ${counts.awaitingEntities} awaiting entities` : ""}</div>`
    : "";

  const body = `
    ${libSubNav("items", pendingAliasCount)}
    ${healthStrip(health)}
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:8px;">Library</h2>
        <div class="tma-hint" style="font-size:12px;">${counts.total.toLocaleString()} items indexed across ${Object.keys(counts.byKind).length} sources</div>
        ${statsLine}
        <form hx-get="/tma/api/library/search" hx-target="#library-list" hx-swap="innerHTML" hx-trigger="input changed delay:300ms from:input[name=q], change from:select[name=kind]"
              style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
          <input type="text" name="q" value="${escapeHtml(query)}" placeholder="Search everything..." class="tma-input" autocomplete="off" style="flex:1; min-width:200px;">
          <select name="kind" class="tma-input" style="min-width:140px;">
            ${kindOptions}
          </select>
        </form>
      </div>
      <div id="library-list">
        ${list}
      </div>
    </div>
  `;

  return miniAppLayout("library", body);
}

function renderItemCard(item: AtlasItem | HybridSearchResult): string {
  const title = item.title || "(untitled)";
  const kind = item.kind;
  const cardId = `atlas-${item.id}`;

  const scoreInfo =
    "score" in item
      ? `<span class="tma-hint" style="font-size:11px;">score ${item.score.toFixed(2)}</span>`
      : "";

  const externalPill = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="tma-hint" style="font-size:11px; text-decoration:none; color:var(--tg-theme-link-color,#2481cc);">source \u2197</a>`
    : "";

  return `<a href="/tma/library/items/${item.id}" style="text-decoration:none; color:inherit; display:block;">
    <div class="tma-card" id="${cardId}" style="padding:12px 16px; border-bottom:1px solid rgba(128,128,128,0.15); cursor:pointer;">
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:4px;">
        ${kindBadge(kind)}
        <span class="tma-hint" style="font-size:11px;">${escapeHtml(formatDate(item.captured_at))}</span>
        ${scoreInfo}
        <span style="margin-left:auto;">${externalPill}</span>
      </div>
      <div style="font-weight:600; font-size:14px; margin-bottom:4px; line-height:1.3;">${escapeHtml(title)}</div>
      <div style="font-size:13px; line-height:1.4; color:var(--tg-theme-hint-color, #6b7280);">${escapeHtml(snippet(item.body))}</div>
    </div>
  </a>`;
}

export function tmaLibraryListFragment(items: Array<AtlasItem | HybridSearchResult>, query: string, isSearch: boolean): string {
  if (items.length === 0) {
    return `<div class="tma-empty">No items${isSearch && query ? ` for "${escapeHtml(query)}"` : ""}.</div>`;
  }
  return items.map(renderItemCard).join("\n");
}

// --------------------------- Library sub-navigation ---------------------------

type LibrarySubPage = "items" | "entities" | "synthesis" | "aliases";

function libSubNav(active: LibrarySubPage, pendingAliasCount: number): string {
  const tabs: Array<{ id: LibrarySubPage; label: string; href: string; count?: number }> = [
    { id: "items", label: "Items", href: "/tma/library" },
    { id: "entities", label: "Entities", href: "/tma/library/entities" },
    { id: "synthesis", label: "Synthesis", href: "/tma/library/synthesis" },
    { id: "aliases", label: "Aliases", href: "/tma/library/aliases", count: pendingAliasCount },
  ];
  return `<div style="display:flex; gap:0; border-bottom:1px solid rgba(128,128,128,0.15); padding:0 16px;">
    ${tabs
      .map((t) => {
        const isActive = t.id === active;
        const badge = t.count && t.count > 0
          ? `<span style="display:inline-block; background:#ef4444; color:white; font-size:10px; font-weight:600; padding:1px 6px; border-radius:8px; margin-left:4px;">${t.count}</span>`
          : "";
        const style = isActive
          ? "padding:10px 12px; font-size:13px; font-weight:600; border-bottom:2px solid var(--tg-theme-button-color,#2481cc); color:inherit; text-decoration:none;"
          : "padding:10px 12px; font-size:13px; font-weight:500; color:var(--tg-theme-hint-color,#6b7280); text-decoration:none;";
        return `<a href="${t.href}" style="${style}">${t.label}${badge}</a>`;
      })
      .join("")}
  </div>`;
}

// --------------------------- Entity list ---------------------------

const ENTITY_KIND_COLOR: Record<string, string> = {
  ticker: "#10b981",
  name: "#f59e0b",
  topic: "#8b5cf6",
};

function entityKindBadge(kind: string): string {
  const color = ENTITY_KIND_COLOR[kind] ?? "#6b7280";
  return `<span style="background:${color}20; color:${color}; font-size:10px; padding:1px 6px; border-radius:8px; font-weight:600; text-transform:uppercase;">${escapeHtml(kind)}</span>`;
}

export interface EntitiesPageOpts {
  entities: EntityRow[];
  counts: AtlasCounts;
  kindFilter: "" | "ticker" | "name" | "topic";
  orderBy: "mentions" | "recent";
  pendingAliasCount: number;
  health?: LibraryHealth;
}

export function tmaEntitiesPage(opts: EntitiesPageOpts): string {
  const { entities, counts, kindFilter, orderBy, pendingAliasCount, health } = opts;
  const statsLine = `${counts.total.toLocaleString()} items, ${entities.length} entit${entities.length === 1 ? "y" : "ies"} shown`;

  const kindOptions = [
    `<option value=""${kindFilter === "" ? " selected" : ""}>All kinds</option>`,
    `<option value="ticker"${kindFilter === "ticker" ? " selected" : ""}>Tickers</option>`,
    `<option value="name"${kindFilter === "name" ? " selected" : ""}>Names</option>`,
    `<option value="topic"${kindFilter === "topic" ? " selected" : ""}>Topics</option>`,
  ].join("");

  const orderOptions = [
    `<option value="mentions"${orderBy === "mentions" ? " selected" : ""}>Most mentioned</option>`,
    `<option value="recent"${orderBy === "recent" ? " selected" : ""}>Recently active</option>`,
  ].join("");

  const rows = entities.length > 0
    ? entities.map(renderEntityRow).join("\n")
    : `<div class="tma-empty">No entities yet. Run entity extraction or wait for the heartbeat queue to catch up.</div>`;

  const body = `
    ${libSubNav("entities", pendingAliasCount)}
    ${healthStrip(health)}
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:8px;">Entities</h2>
        <div class="tma-hint" style="font-size:12px;">${statsLine}</div>
        <form hx-get="/tma/api/library/entities" hx-target="#entity-list" hx-swap="innerHTML" hx-trigger="change from:select"
              style="display:flex; gap:8px; margin-top:12px;">
          <select name="kind" class="tma-input" style="min-width:120px;">
            ${kindOptions}
          </select>
          <select name="order" class="tma-input" style="min-width:160px;">
            ${orderOptions}
          </select>
        </form>
      </div>
      <div id="entity-list">
        ${rows}
      </div>
    </div>
  `;
  return miniAppLayout("library", body);
}

export function tmaEntityListFragment(entities: EntityRow[]): string {
  if (entities.length === 0) {
    return `<div class="tma-empty">No entities.</div>`;
  }
  return entities.map(renderEntityRow).join("\n");
}

function renderEntityRow(e: EntityRow): string {
  return `<a href="/tma/library/entities/${e.id}" style="text-decoration:none; color:inherit;">
    <div class="tma-card" style="padding:10px 16px; border-bottom:1px solid rgba(128,128,128,0.15); display:flex; gap:8px; align-items:center; justify-content:space-between;">
      <div style="display:flex; gap:8px; align-items:center; min-width:0;">
        ${entityKindBadge(e.kind)}
        <span style="font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(e.display_name)}</span>
      </div>
      <div style="display:flex; gap:8px; font-size:11px; color:var(--tg-theme-hint-color,#6b7280);">
        <span>${e.mention_count}\u00d7</span>
        <span>${escapeHtml(formatDate(e.last_seen))}</span>
      </div>
    </div>
  </a>`;
}

// --------------------------- Entity detail ---------------------------

export interface EntityDetailPageOpts {
  entity: EntityRow;
  items: EntityItemRow[];
  related: RelatedEntityRow[];
  pendingAliasCount: number;
}

export function tmaEntityDetailPage(opts: EntityDetailPageOpts): string {
  const { entity, items, related, pendingAliasCount } = opts;

  const itemsByKind = new Map<string, EntityItemRow[]>();
  for (const item of items) {
    if (!itemsByKind.has(item.kind)) itemsByKind.set(item.kind, []);
    itemsByKind.get(item.kind)!.push(item);
  }
  const kindBreakdown = Array.from(itemsByKind.entries())
    .map(([k, list]) => `${KIND_LABEL[k] ?? k}: ${list.length}`)
    .join(" \u2022 ");

  const relatedList = related.length > 0
    ? related
        .map((r) => `<a href="/tma/library/entities/${r.id}" class="tma-card" style="display:inline-flex; gap:6px; align-items:center; padding:6px 10px; margin:2px; border-radius:14px; border:1px solid rgba(128,128,128,0.2); text-decoration:none; color:inherit;">
            ${entityKindBadge(r.kind)}
            <span style="font-size:13px;">${escapeHtml(r.display_name)}</span>
            <span class="tma-hint" style="font-size:11px;">w=${r.weight}</span>
          </a>`)
        .join("")
    : `<div class="tma-hint" style="font-size:12px;">No co-occurrences yet.</div>`;

  const itemsList = items.length > 0
    ? items.map(renderEntityItemCard).join("\n")
    : `<div class="tma-empty">No mentions recorded yet.</div>`;

  const body = `
    ${libSubNav("entities", pendingAliasCount)}
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <a href="/tma/library/entities" style="text-decoration:none; font-size:12px; color:var(--tg-theme-link-color,#2481cc);">\u2190 Entities</a>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; margin-bottom:4px;">
          ${entityKindBadge(entity.kind)}
          <h2 style="font-size:20px; font-weight:700; margin:0;">${escapeHtml(entity.display_name)}</h2>
        </div>
        <div class="tma-hint" style="font-size:12px;">
          ${entity.mention_count} mentions \u2022 first ${escapeHtml(formatDate(entity.first_seen))} \u2022 last ${escapeHtml(formatDate(entity.last_seen))}
        </div>
        ${kindBreakdown ? `<div class="tma-hint" style="font-size:11px; margin-top:2px;">${escapeHtml(kindBreakdown)}</div>` : ""}
      </div>
      <div style="padding:8px 16px;">
        <div style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--tg-theme-hint-color,#6b7280); text-transform:uppercase;">Related</div>
        <div>${relatedList}</div>
      </div>
      <div style="padding:8px 0;">
        <div style="padding:0 16px 6px; font-size:12px; font-weight:600; color:var(--tg-theme-hint-color,#6b7280); text-transform:uppercase;">Timeline (${items.length})</div>
        ${itemsList}
      </div>
    </div>
  `;
  return miniAppLayout("library", body);
}

function renderEntityItemCard(item: EntityItemRow): string {
  const title = item.title || "(untitled)";
  const context = item.context ? `<div class="tma-hint" style="font-size:11px; margin-top:2px; font-style:italic;">${escapeHtml(snippet(item.context, 160))}</div>` : "";
  const externalPill = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" class="tma-hint" style="font-size:11px; text-decoration:none; color:var(--tg-theme-link-color,#2481cc); margin-left:auto;">source \u2197</a>`
    : "";
  return `<a href="/tma/library/items/${item.id}" style="text-decoration:none; color:inherit; display:block;">
    <div class="tma-card" style="padding:10px 16px; border-bottom:1px solid rgba(128,128,128,0.15); cursor:pointer;">
      <div style="display:flex; gap:8px; align-items:center; margin-bottom:2px;">
        ${kindBadge(item.kind)}
        <span class="tma-hint" style="font-size:11px;">${escapeHtml(formatDate(item.captured_at))}</span>
        <span class="tma-hint" style="font-size:11px;">conf ${item.confidence.toFixed(2)}</span>
        ${externalPill}
      </div>
      <div style="font-weight:600; font-size:13px; line-height:1.3;">${escapeHtml(title)}</div>
      ${context}
    </div>
  </a>`;
}

// --------------------------- Synthesis browse ---------------------------

export interface SynthesisFile {
  path: string;
  label: string;
  kind: "daily" | "weekly" | "monthly";
  mtime: number;
}

export interface SynthesisPageOpts {
  files: SynthesisFile[];
  active: SynthesisFile | null;
  content: string | null;
  pendingAliasCount: number;
  health?: LibraryHealth;
}

export function tmaSynthesisPage(opts: SynthesisPageOpts): string {
  const { files, active, content, pendingAliasCount, health } = opts;
  const grouped: Record<"daily" | "weekly" | "monthly", SynthesisFile[]> = {
    daily: [],
    weekly: [],
    monthly: [],
  };
  for (const f of files) grouped[f.kind].push(f);

  const section = (kind: "daily" | "weekly" | "monthly", label: string): string => {
    const list = grouped[kind];
    if (list.length === 0) return "";
    const items = list
      .map((f) => {
        const isActive = active && active.path === f.path;
        const style = isActive
          ? "background:rgba(36,129,204,0.15); font-weight:600;"
          : "";
        return `<a href="/tma/library/synthesis?path=${encodeURIComponent(f.path)}" style="${style} display:block; padding:6px 12px; font-size:13px; text-decoration:none; color:inherit; border-bottom:1px solid rgba(128,128,128,0.1);">${escapeHtml(f.label)}</a>`;
      })
      .join("");
    return `<div style="margin-bottom:12px;">
      <div style="padding:6px 12px; font-size:11px; font-weight:600; text-transform:uppercase; color:var(--tg-theme-hint-color,#6b7280);">${label} (${list.length})</div>
      ${items}
    </div>`;
  };

  const sidebar = `<div style="border-right:1px solid rgba(128,128,128,0.15); min-width:180px; max-width:220px;">
    ${section("daily", "Daily")}
    ${section("weekly", "Weekly")}
    ${section("monthly", "Monthly")}
  </div>`;

  const contentArea = active && content !== null
    ? `<div style="flex:1; padding:12px 16px; overflow:auto;">
        <div class="tma-hint" style="font-size:11px; margin-bottom:4px;">${escapeHtml(active.path)}</div>
        <div data-md-toggle-root>
          <div class="md-rendered" data-md data-md-src="${escapeHtml(content)}"></div>
          <pre class="md-raw" style="display:none; white-space:pre-wrap; font-size:12px; background:rgba(128,128,128,0.08); padding:8px; border-radius:6px;">${escapeHtml(content)}</pre>
        </div>
        <button onclick="toggleMdView(this)" style="margin-top:8px; padding:4px 10px; font-size:11px; border:1px solid rgba(128,128,128,0.3); border-radius:4px; background:transparent; color:inherit; cursor:pointer;">Raw</button>
      </div>`
    : `<div style="flex:1; padding:16px;" class="tma-empty">
        ${files.length === 0 ? "No syntheses yet. Run atlas_synthesize to generate the first one." : "Pick a file from the sidebar."}
      </div>`;

  const body = `
    ${libSubNav("synthesis", pendingAliasCount)}
    ${healthStrip(health)}
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:4px;">Synthesis</h2>
        <div class="tma-hint" style="font-size:12px;">${files.length} narrative file${files.length === 1 ? "" : "s"} indexed</div>
      </div>
      <div style="display:flex; align-items:stretch; min-height:300px;">
        ${sidebar}
        ${contentArea}
      </div>
    </div>
  `;
  return miniAppLayout("library", body);
}

// --------------------------- Alias proposals ---------------------------

export interface AliasPageOpts {
  proposals: AliasProposalRow[];
  pendingAliasCount: number;
  health?: LibraryHealth;
}

export function tmaAliasPage(opts: AliasPageOpts): string {
  const { proposals, pendingAliasCount, health } = opts;
  const list = proposals.length > 0
    ? proposals.map(renderAliasRow).join("\n")
    : `<div class="tma-empty">No pending alias proposals.</div>`;
  const body = `
    ${libSubNav("aliases", pendingAliasCount)}
    ${healthStrip(health)}
    <div style="padding:8px 0;">
      <div style="padding:12px 16px;">
        <h2 style="font-size:18px; font-weight:600; margin-bottom:4px;">Alias proposals</h2>
        <div class="tma-hint" style="font-size:12px;">Weekly LLM-suggested entity merges awaiting your review.</div>
      </div>
      <div id="alias-list">
        ${list}
      </div>
    </div>
  `;
  return miniAppLayout("library", body);
}

export function tmaAliasListFragment(proposals: AliasProposalRow[]): string {
  if (proposals.length === 0) return `<div class="tma-empty">No pending alias proposals.</div>`;
  return proposals.map(renderAliasRow).join("\n");
}

// --------------------------- Item detail ---------------------------

export interface ItemDetailPageOpts {
  item: AtlasItem;
  entities: ItemEntityRow[];
  pendingAliasCount: number;
  backUrl: string;
  backLabel: string;
}

export function tmaItemDetailPage(opts: ItemDetailPageOpts): string {
  const { item, entities, pendingAliasCount, backUrl, backLabel } = opts;

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(item.metadata_json) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  const metadataEntries = Object.entries(metadata);

  const entityPills = entities.length > 0
    ? entities
        .map(
          (e) => `<a href="/tma/library/entities/${e.id}" style="display:inline-flex; gap:6px; align-items:center; padding:4px 10px; margin:2px; border-radius:12px; border:1px solid rgba(128,128,128,0.25); text-decoration:none; color:inherit; font-size:12px;">
            ${entityKindBadge(e.kind)}
            <span>${escapeHtml(e.display_name)}</span>
            <span class="tma-hint" style="font-size:10px;">conf ${e.confidence.toFixed(2)}</span>
          </a>`,
        )
        .join("")
    : `<div class="tma-hint" style="font-size:12px;">No entities extracted${item.entity_extracted_at ? " (entity pass found nothing)" : " yet (pending extraction)"}.</div>`;

  const bodyBlock = item.body && item.body.trim().length > 0
    ? `<div data-md-toggle-root>
        <div class="md-rendered" data-md data-md-src="${escapeHtml(item.body)}" style="font-size:13px; line-height:1.55;"></div>
        <pre class="md-raw" style="display:none; white-space:pre-wrap; font-size:12px; background:rgba(128,128,128,0.08); padding:8px; border-radius:6px;">${escapeHtml(item.body)}</pre>
        <button onclick="window.toggleMdView(this)" style="margin-top:8px; padding:4px 10px; font-size:11px; border:1px solid rgba(128,128,128,0.3); border-radius:4px; background:transparent; color:inherit; cursor:pointer;">Raw</button>
      </div>`
    : `<div class="tma-hint" style="font-size:12px; font-style:italic;">(empty body — this row is tracked as a pointer only)</div>`;

  const urlBlock = item.url
    ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" style="display:inline-block; margin-top:6px; padding:6px 12px; font-size:12px; background:var(--tg-theme-button-color,#2481cc); color:var(--tg-theme-button-text-color,white); border-radius:6px; text-decoration:none;">Open source \u2197</a>
       <div class="tma-hint" style="font-size:11px; margin-top:4px; word-break:break-all;">${escapeHtml(item.url)}</div>`
    : "";

  const pipelineStatus: string[] = [];
  pipelineStatus.push(item.embedded_at ? "embedded" : "awaiting embedding");
  pipelineStatus.push(item.entity_extracted_at ? "entities extracted" : "awaiting entities");

  const metadataBlock = metadataEntries.length > 0
    ? `<details style="margin-top:12px;">
        <summary style="font-size:12px; cursor:pointer; color:var(--tg-theme-hint-color,#6b7280);">Metadata (${metadataEntries.length})</summary>
        <pre style="margin-top:6px; white-space:pre-wrap; font-size:11px; background:rgba(128,128,128,0.08); padding:8px; border-radius:6px;">${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>
      </details>`
    : "";

  const title = item.title || "(untitled)";
  const body = `
    ${libSubNav("items", pendingAliasCount)}
    <div style="padding:8px 0 24px;">
      <div style="padding:12px 16px;">
        <a href="${escapeHtml(backUrl)}" style="text-decoration:none; font-size:12px; color:var(--tg-theme-link-color,#2481cc);">\u2190 ${escapeHtml(backLabel)}</a>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; margin-bottom:4px; flex-wrap:wrap;">
          ${kindBadge(item.kind)}
          <span class="tma-hint" style="font-size:12px;">${escapeHtml(formatDate(item.captured_at))}</span>
          <span class="tma-hint" style="font-size:11px;">\u00b7</span>
          <span class="tma-hint" style="font-size:11px;">${escapeHtml(item.source_table)}#${escapeHtml(item.source_id)}</span>
        </div>
        <h2 style="font-size:18px; font-weight:700; margin:0 0 6px; line-height:1.3;">${escapeHtml(title)}</h2>
        ${urlBlock}
      </div>
      <div style="padding:0 16px 12px;">
        <div style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--tg-theme-hint-color,#6b7280); margin:12px 0 6px;">Entities (${entities.length})</div>
        <div>${entityPills}</div>
      </div>
      <div style="padding:0 16px;">
        <div style="font-size:11px; font-weight:600; text-transform:uppercase; color:var(--tg-theme-hint-color,#6b7280); margin-bottom:6px;">Body</div>
        ${bodyBlock}
        ${metadataBlock}
        <div class="tma-hint" style="font-size:10px; margin-top:16px; opacity:0.6;">
          atlas#${item.id} \u00b7 ${escapeHtml(pipelineStatus.join(" \u00b7 "))} \u00b7 updated ${escapeHtml(formatDate(item.updated_at))}
        </div>
      </div>
    </div>
  `;
  return miniAppLayout("library", body);
}

// --------------------------- Alias row (existing) ---------------------------

function renderAliasRow(p: AliasProposalRow): string {
  const reason = p.reason ? `<div class="tma-hint" style="font-size:11px; font-style:italic;">${escapeHtml(p.reason)}</div>` : "";
  return `<div class="tma-card" id="alias-${p.id}" style="padding:12px 16px; border-bottom:1px solid rgba(128,128,128,0.15);">
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
      ${entityKindBadge(p.entity_kind)}
      <span style="font-weight:600; font-size:14px;">${escapeHtml(p.entity_name)}</span>
      <span class="tma-hint" style="font-size:11px;">\u2190 "${escapeHtml(p.alias_norm)}"</span>
    </div>
    ${reason}
    <div style="display:flex; gap:8px; margin-top:8px;">
      <button hx-post="/tma/api/library/aliases/${p.id}/approve" hx-target="#alias-list" hx-swap="innerHTML"
        style="padding:4px 12px; font-size:12px; background:#10b981; color:white; border:none; border-radius:4px; cursor:pointer;">Approve</button>
      <button hx-post="/tma/api/library/aliases/${p.id}/reject" hx-target="#alias-list" hx-swap="innerHTML"
        style="padding:4px 12px; font-size:12px; background:transparent; color:#ef4444; border:1px solid #ef4444; border-radius:4px; cursor:pointer;">Reject</button>
    </div>
  </div>`;
}
