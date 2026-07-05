import { miniAppLayout } from "./shell.ts";
import {
  escapeHtml,
  escapeAttr,
  truncate,
  markdownSnippet,
  formatDate,
  formatAgo,
  pageHeader,
  badge,
  filterChips,
  searchBar,
  emptyState,
  errorState,
  listRow,
  section,
  detailsPanel,
  button,
  type BadgeKind,
} from "./components.ts";
import type { AtlasItem, AtlasCounts, AtlasKind } from "../../../atlas/index.ts";
import type { HybridSearchResult } from "../../../atlas/search.ts";
import type {
  EntityRow,
  EntityItemRow,
  RelatedEntityRow,
  AliasProposalRow,
  ItemEntityRow,
  EntityKind,
} from "../../../atlas/entities.ts";

// ---------------------------------------------------------------------------
// Kind labels + badge mapping (atlas item kinds and entity kinds each get a
// stable, semantic badge color via the shared BadgeKind palette — no hex).
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  inbox: "Inbox",
  youtube: "YouTube",
  signal: "Signal",
  research: "Research",
  scan: "Scan",
  daily_log: "Daily",
};

const KIND_BADGE: Record<string, BadgeKind> = {
  inbox: "accent",
  youtube: "err",
  signal: "ok",
  research: "muted",
  scan: "warn",
  daily_log: "muted",
};

function kindBadge(kind: string): string {
  return badge(KIND_LABEL[kind] ?? kind, KIND_BADGE[kind] ?? "muted");
}

const ENTITY_KIND_BADGE: Record<string, BadgeKind> = {
  ticker: "ok",
  name: "warn",
  topic: "accent",
};

function entityKindBadge(kind: string): string {
  return badge(kind.toUpperCase(), ENTITY_KIND_BADGE[kind] ?? "muted");
}

// ---------------------------------------------------------------------------
// Library health strip — horizontally scrollable chip row (plan requirement).
// Reuses .tma-chip-row / .tma-chip for layout; not interactive (informational
// pills), so chips render as plain spans/links rather than data-tma-filter.
// ---------------------------------------------------------------------------

export interface LibraryHealth {
  counts: AtlasCounts;
  pendingAliasCount: number;
  lastDailyMs: number | null;
  lastWeeklyMs: number | null;
  lastMonthlyMs: number | null;
}

function healthChip(label: string, value: string, opts: { warn?: boolean; href?: string } = {}): string {
  // NOTE: .tma-chip is inline-flex, which collapses whitespace between text
  // nodes — use &nbsp; so "3,430 items" doesn't render as "3,430items".
  // Warn chips get their own style; tma-chip-active reads as a selected filter.
  const cls = `tma-chip${opts.warn ? " tma-chip-warn" : ""}`;
  const inner = `<strong>${escapeHtml(value)}</strong>&nbsp;${escapeHtml(label)}`;
  if (opts.href) {
    return `<a href="${escapeAttr(opts.href)}" class="${cls}">${inner}</a>`;
  }
  return `<span class="${cls}">${inner}</span>`;
}

function healthStrip(health: LibraryHealth | undefined): string {
  if (!health) return "";
  const { counts, pendingAliasCount, lastDailyMs, lastWeeklyMs, lastMonthlyMs } = health;
  const chips: string[] = [];
  chips.push(healthChip("items", counts.total.toLocaleString()));
  if (counts.awaitingEmbedding > 0) {
    chips.push(healthChip("awaiting embed", counts.awaitingEmbedding.toLocaleString(), { warn: true }));
  }
  if (counts.awaitingEntities > 0) {
    chips.push(healthChip("awaiting entities", counts.awaitingEntities.toLocaleString(), { warn: true }));
  }
  chips.push(healthChip("daily", formatAgo(lastDailyMs)));
  chips.push(healthChip("weekly", formatAgo(lastWeeklyMs)));
  chips.push(healthChip("monthly", formatAgo(lastMonthlyMs)));
  if (pendingAliasCount > 0) {
    chips.push(
      healthChip("aliases pending", pendingAliasCount.toLocaleString(), {
        warn: true,
        href: "/tma/library/aliases",
      }),
    );
  }
  return `<div class="tma-chip-row" role="group" aria-label="Library health">${chips.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Library sub-navigation (Items / Entities / Synthesis / Aliases)
// ---------------------------------------------------------------------------

type LibrarySubPage = "items" | "entities" | "synthesis" | "aliases";

function libSubNav(active: LibrarySubPage, pendingAliasCount: number): string {
  const options = [
    { value: "items", label: "Items", href: "/tma/library" },
    { value: "entities", label: "Entities", href: "/tma/library/entities" },
    { value: "synthesis", label: "Synthesis", href: "/tma/library/synthesis" },
    {
      value: "aliases",
      label: pendingAliasCount > 0 ? `Aliases (${pendingAliasCount})` : "Aliases",
      href: "/tma/library/aliases",
    },
  ];
  return filterChips("lib-subnav", options, active);
}

// ---------------------------------------------------------------------------
// Items list (P4 main page)
// ---------------------------------------------------------------------------

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

  const kindChips = filterChips(
    "kind",
    [
      { value: "", label: `All (${counts.total})`, href: buildLibraryUrl("", query) },
      ...Object.entries(counts.byKind).map(([k, n]) => ({
        value: k,
        label: `${KIND_LABEL[k] ?? k} (${n})`,
        href: buildLibraryUrl(k, query),
      })),
    ],
    kind,
  );

  const statsSubtitle = `${counts.total.toLocaleString()} items indexed across ${Object.keys(counts.byKind).length} sources`;

  const body = `
    ${libSubNav("items", pendingAliasCount)}
    ${healthStrip(health)}
    ${pageHeader("Library", { subtitle: statsSubtitle })}
    <div class="tma-search-scope">
      ${searchBar("/tma/api/library/search" + (kind ? `?kind=${encodeURIComponent(kind)}` : ""), "Search everything…", query)}
      ${kindChips}
      <div id="library-list">
        ${renderItemList(items, query, isSearch)}
      </div>
    </div>
  `;

  return miniAppLayout("library", body);
}

function buildLibraryUrl(kind: string, query: string): string {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (query) params.set("q", query);
  const qs = params.toString();
  return qs ? `/tma/library?${qs}` : "/tma/library";
}

// ---------------------------------------------------------------------------
// Duplicate collapse (browse mode only — see grouping helper below)
// ---------------------------------------------------------------------------

/** Lowercase, strip query/hash + trailing slash, drop protocol for loose matching. */
function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  if (!u) return null;
  u = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  u = u.split(/[?#]/)[0];
  u = u.replace(/\/+$/, "");
  return u || null;
}

/** Lowercase + collapse whitespace/punctuation for a loose title fallback key. */
function normalizeTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

export interface ItemGroup<T> {
  primary: T;
  others: T[];
}

/**
 * Group consecutive-in-result items that share a normalized URL (fallback:
 * normalized title) so the same story indexed under multiple atlas kinds
 * (e.g. inbox + research) collapses to one row with a "+1 research" hint.
 * Pure + unit-testable: no I/O, operates only on the ordering it's given.
 * Only consecutive runs are grouped — items are not re-sorted — so this must
 * only be applied to the default (recency-ordered) browse list, never to
 * search results where order reflects relevance rank.
 */
export function groupDuplicateItems<T extends { title: string; url: string | null }>(
  items: T[],
): ItemGroup<T>[] {
  const groups: ItemGroup<T>[] = [];
  for (const item of items) {
    const key = normalizeUrl(item.url) ?? normalizeTitle(item.title);
    const last = groups[groups.length - 1];
    const lastKey = last ? (normalizeUrl(last.primary.url) ?? normalizeTitle(last.primary.title)) : null;
    if (key && last && key === lastKey) {
      last.others.push(item);
    } else {
      groups.push({ primary: item, others: [] });
    }
  }
  return groups;
}

function renderItemList(items: Array<AtlasItem | HybridSearchResult>, query: string, isSearch: boolean): string {
  if (items.length === 0) {
    return isSearch && query
      ? emptyState("🔍", "No results", `Nothing matched "${query}".`)
      : emptyState("📚", "No items yet", "Captured content will appear here once the pipeline indexes it.");
  }
  // Search results are relevance-ordered — grouping would silently hide a
  // matched row under an unrelated primary, so only browse mode collapses
  // duplicates.
  if (isSearch) {
    return items.map((item) => renderItemRow(item)).join("\n");
  }
  const groups = groupDuplicateItems(items);
  return groups.map(({ primary, others }) => renderItemRow(primary, others)).join("\n");
}

/**
 * Small pill linking to a grouped duplicate's own detail page, e.g.
 * "+1 research". Rendered alongside the primary row's kind badge so the
 * group reads as intentional rather than a missing row.
 */
function dupHintChip(other: AtlasItem | HybridSearchResult): string {
  const label = KIND_LABEL[other.kind] ?? other.kind;
  return `<a href="/tma/library/items/${other.id}" class="tma-chip tma-chip-sm">+1 ${escapeHtml(label)}</a>`;
}

function renderItemRow(item: AtlasItem | HybridSearchResult, others: Array<AtlasItem | HybridSearchResult> = []): string {
  const title = item.title || "(untitled)";
  const scoreMeta = "score" in item ? ` · score ${item.score.toFixed(2)}` : "";
  const meta = `${formatDate(item.captured_at)}${scoreMeta}`;
  // The kind badge + any duplicate hints stack in the row's aside column
  // (listRow's `badge` slot accepts raw HTML, so multiple pills are fine).
  const aside = kindBadge(item.kind) + others.map(dupHintChip).join("");
  return listRow({
    title,
    // Bodies are markdown (often starting with "## Overview **<title>**…") —
    // flatten to plain text and skip the title echo for a readable preview.
    subtitle: markdownSnippet(item.body, 140, title),
    meta,
    badge: aside,
    href: `/tma/library/items/${item.id}`,
    chevron: true,
  });
}

export function tmaLibraryListFragment(
  items: Array<AtlasItem | HybridSearchResult>,
  query: string,
  isSearch: boolean,
): string {
  return renderItemList(items, query, isSearch);
}

// ---------------------------------------------------------------------------
// Entities list
// ---------------------------------------------------------------------------

export interface EntitiesPageOpts {
  entities: EntityRow[];
  counts: AtlasCounts;
  kindFilter: "" | EntityKind;
  orderBy: "mentions" | "recent";
  pendingAliasCount: number;
  health?: LibraryHealth;
}

function buildEntitiesUrl(kind: string, order: string): string {
  const params = new URLSearchParams();
  if (kind) params.set("kind", kind);
  if (order && order !== "mentions") params.set("order", order);
  const qs = params.toString();
  return qs ? `/tma/library/entities?${qs}` : "/tma/library/entities";
}

export function tmaEntitiesPage(opts: EntitiesPageOpts): string {
  const { entities, counts, kindFilter, orderBy, pendingAliasCount, health } = opts;
  const statsLine = `${counts.total.toLocaleString()} items · ${entities.length} entit${entities.length === 1 ? "y" : "ies"} shown`;

  const kindChips = filterChips(
    "entity-kind",
    [
      { value: "", label: "All kinds", href: buildEntitiesUrl("", orderBy) },
      { value: "ticker", label: "Tickers", href: buildEntitiesUrl("ticker", orderBy) },
      { value: "name", label: "Names", href: buildEntitiesUrl("name", orderBy) },
      { value: "topic", label: "Topics", href: buildEntitiesUrl("topic", orderBy) },
    ],
    kindFilter,
  );

  const orderChips = filterChips(
    "entity-order",
    [
      { value: "mentions", label: "Most mentioned", href: buildEntitiesUrl(kindFilter, "mentions") },
      { value: "recent", label: "Recently active", href: buildEntitiesUrl(kindFilter, "recent") },
    ],
    orderBy,
  );

  const rows = entities.length > 0
    ? renderEntityRows(entities)
    : emptyState("🏷️", "No entities yet", "Run entity extraction or wait for the heartbeat queue to catch up.");

  const body = `
    ${libSubNav("entities", pendingAliasCount)}
    ${healthStrip(health)}
    ${pageHeader("Entities", { subtitle: statsLine })}
    ${kindChips}
    ${orderChips}
    <div id="entity-list">
      ${rows}
    </div>
  `;
  return miniAppLayout("library", body);
}

export function tmaEntityListFragment(entities: EntityRow[]): string {
  if (entities.length === 0) {
    return emptyState("🏷️", "No entities", "Try a different filter.");
  }
  return renderEntityRows(entities);
}

/**
 * Cross-kind name collisions (e.g. "Claude Code" as both TOPIC and NAME)
 * aren't merged by the alias pipeline — it only covers same-kind merges.
 * Rather than hide the "duplicate", tag every row after the first occurrence
 * of a display name with "also <KIND>" pointing at the earlier kind(s), so
 * it reads as intentional rather than a data-quality bug.
 */
function renderEntityRows(entities: EntityRow[]): string {
  const seenKindsByName = new Map<string, EntityKind[]>();
  return entities
    .map((e) => {
      const key = e.display_name.trim().toLowerCase();
      const seenKinds = seenKindsByName.get(key);
      const alsoHint = seenKinds && !seenKinds.includes(e.kind)
        ? `also ${seenKinds.map((k) => k.toUpperCase()).join("/")}`
        : undefined;
      seenKindsByName.set(key, [...(seenKinds ?? []), e.kind]);
      return renderEntityRow(e, alsoHint);
    })
    .join("\n");
}

function renderEntityRow(e: EntityRow, alsoHint?: string): string {
  const meta = `${e.mention_count}× mentions · last seen ${formatAgo(e.last_seen)}`;
  return listRow({
    title: e.display_name,
    meta: alsoHint ? `${meta} · ${alsoHint}` : meta,
    badge: entityKindBadge(e.kind),
    href: `/tma/library/entities/${e.id}`,
    chevron: true,
  });
}

// ---------------------------------------------------------------------------
// Entity detail
// ---------------------------------------------------------------------------

export interface EntityDetailPageOpts {
  entity: EntityRow;
  items: EntityItemRow[];
  related: RelatedEntityRow[];
  pendingAliasCount: number;
}

const RELATED_CAP = 20;

export function tmaEntityDetailPage(opts: EntityDetailPageOpts): string {
  const { entity, items, related, pendingAliasCount } = opts;

  const itemsByKind = new Map<string, EntityItemRow[]>();
  for (const item of items) {
    if (!itemsByKind.has(item.kind)) itemsByKind.set(item.kind, []);
    itemsByKind.get(item.kind)!.push(item);
  }
  const kindBreakdown = Array.from(itemsByKind.entries())
    .map(([k, list]) => `${KIND_LABEL[k] ?? k}: ${list.length}`)
    .join(" · ");

  const shownRelated = related.slice(0, RELATED_CAP);
  const relatedChips = shownRelated.length > 0
    ? shownRelated
        .map(
          (r) =>
            `<a href="/tma/library/entities/${r.id}" class="tma-chip">${entityKindBadge(r.kind)} ${escapeHtml(r.display_name)} <span class="tma-hint">×${r.weight}</span></a>`,
        )
        .join("")
    : "";
  const relatedExpander = related.length > RELATED_CAP
    ? detailsPanel(
        `Show all ${related.length} related entities`,
        `<div class="tma-chip-row tma-chip-row-wrap">${related
          .map(
            (r) =>
              `<a href="/tma/library/entities/${r.id}" class="tma-chip">${entityKindBadge(r.kind)} ${escapeHtml(r.display_name)} <span class="tma-hint">×${r.weight}</span></a>`,
          )
          .join("")}</div>`,
      )
    : "";
  const relatedBlock = related.length > 0
    ? `<div class="tma-chip-row" role="group" aria-label="Related entities">${relatedChips}</div>${relatedExpander}`
    : `<div class="tma-empty-hint tma-px-4" style="padding-bottom:var(--sp-3);">No co-occurrences yet.</div>`;

  const itemsList = items.length > 0
    ? items.map(renderEntityItemRow).join("\n")
    : emptyState("📄", "No mentions recorded", "This entity hasn't appeared in any items yet.");

  const subtitle = `${entity.mention_count} mentions · first ${formatDate(entity.first_seen)} · last ${formatDate(entity.last_seen)}${
    kindBreakdown ? " · " + kindBreakdown : ""
  }`;

  const body = `
    ${libSubNav("entities", pendingAliasCount)}
    ${pageHeader(entity.display_name, {
      subtitle,
      actions: `<a href="/tma/library/entities" class="tma-link tma-link-sm">← Entities</a>`,
    })}
    ${section("Related", relatedBlock)}
    ${section(`Timeline (${items.length})`, itemsList)}
  `;
  return miniAppLayout("library", body, false);
}

function renderEntityItemRow(item: EntityItemRow): string {
  const context = item.context ? truncate(item.context, 120) : "";
  return listRow({
    title: item.title || "(untitled)",
    subtitle: context,
    meta: `${formatDate(item.captured_at)} · conf ${item.confidence.toFixed(2)}`,
    badge: kindBadge(item.kind),
    href: `/tma/library/items/${item.id}`,
    chevron: true,
  });
}

// ---------------------------------------------------------------------------
// Synthesis browse
// ---------------------------------------------------------------------------

export interface SynthesisFile {
  path: string;
  label: string;
  kind: "daily" | "weekly" | "monthly";
  mtime: number;
}

export interface SynthesisPageOpts {
  files: SynthesisFile[];
  pendingAliasCount: number;
  health?: LibraryHealth;
}

/** List-only page — tapping a file navigates to its own BackButton page. */
export function tmaSynthesisPage(opts: SynthesisPageOpts): string {
  const { files, pendingAliasCount, health } = opts;

  const groupSection = (kind: "daily" | "weekly" | "monthly", label: string): string => {
    const list = files.filter((f) => f.kind === kind);
    if (list.length === 0) return "";
    const rows = list
      .map((f) =>
        listRow({
          title: f.label,
          meta: formatAgo(f.mtime),
          href: `/tma/library/synthesis/view?path=${encodeURIComponent(f.path)}`,
          chevron: true,
        }),
      )
      .join("\n");
    return section(`${label} (${list.length})`, rows);
  };

  const body = `
    ${libSubNav("synthesis", pendingAliasCount)}
    ${healthStrip(health)}
    ${pageHeader("Synthesis", { subtitle: `${files.length} narrative file${files.length === 1 ? "" : "s"} indexed` })}
    ${
      files.length === 0
        ? emptyState("🧵", "No syntheses yet", "Run atlas_synthesize to generate the first one.")
        : `${groupSection("daily", "Daily")}${groupSection("weekly", "Weekly")}${groupSection("monthly", "Monthly")}`
    }
  `;
  return miniAppLayout("library", body);
}

export interface SynthesisFileViewOpts {
  file: SynthesisFile;
  content: string | null;
  pendingAliasCount: number;
}

/** Standalone file view — its own page with BackButton (plan requirement). */
export function tmaSynthesisFileViewPage(opts: SynthesisFileViewOpts): string {
  const { file, content, pendingAliasCount } = opts;
  const body = `
    ${pageHeader(file.label, {
      subtitle: file.path,
      actions: `<a href="/tma/library/synthesis" class="tma-link tma-link-sm">← Synthesis</a>`,
    })}
    ${
      content !== null
        ? `<div class="tma-section">
            <div data-md-toggle-root>
              <div class="md-rendered tma-md tma-px-4" data-md data-md-src="${escapeAttr(content)}"></div>
              <pre class="md-raw tma-mono tma-md-raw-box" style="display:none;">${escapeHtml(content)}</pre>
            </div>
            <div style="padding:var(--sp-2) var(--sp-4);">
              ${button("Raw", { small: true, kind: "secondary", onclick: "toggleMdView(this)" })}
            </div>
          </div>`
        : errorState("Could not load this file.", `/tma/library/synthesis/view?path=${encodeURIComponent(file.path)}`)
    }
  `;
  return miniAppLayout("library", body, false);
}

// ---------------------------------------------------------------------------
// Alias proposals
// ---------------------------------------------------------------------------

export interface AliasPageOpts {
  proposals: AliasProposalRow[];
  pendingAliasCount: number;
  health?: LibraryHealth;
}

export function tmaAliasPage(opts: AliasPageOpts): string {
  const { proposals, pendingAliasCount, health } = opts;
  const body = `
    ${libSubNav("aliases", pendingAliasCount)}
    ${healthStrip(health)}
    ${pageHeader("Alias proposals", { subtitle: "Weekly LLM-suggested entity merges awaiting your review." })}
    <div id="alias-list">
      ${renderAliasList(proposals)}
    </div>
  `;
  return miniAppLayout("library", body);
}

function renderAliasList(proposals: AliasProposalRow[]): string {
  if (proposals.length === 0) {
    return emptyState("✅", "All caught up", "No pending alias proposals.");
  }
  return proposals.map(renderAliasRow).join("\n");
}

export function tmaAliasListFragment(proposals: AliasProposalRow[]): string {
  return renderAliasList(proposals);
}

function renderAliasRow(p: AliasProposalRow): string {
  const reasonHtml = p.reason
    ? `<div class="tma-list-row-subtitle" style="font-style:italic;">${escapeHtml(p.reason)}</div>`
    : "";
  const confirmMsg = `Merge alias "${p.alias_norm}" into ${p.entity_name}?`;
  const inner = `<div class="tma-list-row-body">
      <div class="tma-list-row-title">${escapeHtml(p.entity_name)} ${entityKindBadge(p.entity_kind)}</div>
      <div class="tma-list-row-subtitle">alias: "${escapeHtml(p.alias_norm)}"</div>
      ${reasonHtml}
      <div class="tma-form-actions" style="padding:var(--sp-2) 0 0;">
        ${button("Approve", {
          kind: "primary",
          small: true,
          attrs: `hx-post="/tma/api/library/aliases/${p.id}/approve" hx-target="#alias-list" hx-swap="innerHTML" hx-trigger="confirmed" onclick="return tmaConfirmAlias(event, ${escapeAttr(JSON.stringify(confirmMsg))})"`,
        })}
        ${button("Reject", {
          kind: "danger",
          small: true,
          attrs: `hx-post="/tma/api/library/aliases/${p.id}/reject" hx-target="#alias-list" hx-swap="innerHTML" hx-trigger="confirmed" onclick="return tmaConfirmAlias(event, ${escapeAttr(JSON.stringify(`Reject alias "${p.alias_norm}"?`))})"`,
        })}
      </div>
    </div>`;
  return `<div class="tma-card" id="alias-${p.id}">${inner}</div>
  <script>
  if (!window.tmaConfirmAlias) {
    window.tmaConfirmAlias = function (evt, message) {
      var proceed = function (ok) {
        if (!ok) return;
        htmx.trigger(evt.target, 'confirmed');
      };
      evt.preventDefault();
      if (window.tg && window.tg.showConfirm) {
        window.tg.showConfirm(message, proceed);
      } else {
        proceed(window.confirm(message));
      }
      return false;
    };
  }
  </script>`;
}

// ---------------------------------------------------------------------------
// Item detail
// ---------------------------------------------------------------------------

export interface ItemDetailPageOpts {
  item: AtlasItem;
  entities: ItemEntityRow[];
  pendingAliasCount: number;
  backUrl: string;
  backLabel: string;
}

const ITEM_ENTITY_CAP = 20;

export function tmaItemDetailPage(opts: ItemDetailPageOpts): string {
  const { item, entities, backUrl, backLabel } = opts;

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(item.metadata_json) as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  const metadataEntries = Object.entries(metadata);

  const shownEntities = entities.slice(0, ITEM_ENTITY_CAP);
  const entityChips = shownEntities.length > 0
    ? shownEntities
        .map(
          (e) =>
            `<a href="/tma/library/entities/${e.id}" class="tma-chip">${entityKindBadge(e.kind)} ${escapeHtml(e.display_name)} <span class="tma-hint">conf ${e.confidence.toFixed(2)}</span></a>`,
        )
        .join("")
    : "";
  const entityExpander = entities.length > ITEM_ENTITY_CAP
    ? detailsPanel(
        `Show all ${entities.length} entities`,
        `<div class="tma-chip-row tma-chip-row-wrap">${entities
          .map(
            (e) =>
              `<a href="/tma/library/entities/${e.id}" class="tma-chip">${entityKindBadge(e.kind)} ${escapeHtml(e.display_name)} <span class="tma-hint">conf ${e.confidence.toFixed(2)}</span></a>`,
          )
          .join("")}</div>`,
      )
    : "";
  const entitiesBlock = shownEntities.length > 0
    ? `<div class="tma-chip-row" role="group" aria-label="Entities">${entityChips}</div>${entityExpander}`
    : `<div class="tma-empty-hint" style="padding:0 var(--sp-4) var(--sp-3);">No entities extracted${
        item.entity_extracted_at ? " (entity pass found nothing)" : " yet (pending extraction)"
      }.</div>`;

  const bodyBlock = item.body && item.body.trim().length > 0
    ? `<div data-md-toggle-root>
        <div class="md-rendered tma-md" data-md data-md-src="${escapeAttr(item.body)}"></div>
        <pre class="md-raw tma-mono tma-md-raw-box tma-md-raw-box-inset" style="display:none;">${escapeHtml(item.body)}</pre>
        ${button("Raw", { small: true, kind: "secondary", onclick: "window.toggleMdView(this)", attrs: 'style="margin-top:var(--sp-2);"' })}
      </div>`
    : `<div class="tma-empty-hint">(empty body — this row is tracked as a pointer only)</div>`;

  const urlBlock = item.url
    ? `<div style="margin-top:var(--sp-2);">
        ${button("Open source ↗", { href: item.url, kind: "secondary", small: true, attrs: 'target="_blank" rel="noopener"' })}
        <div class="tma-meta" style="word-break:break-all;">${escapeHtml(item.url)}</div>
      </div>`
    : "";

  const pipelineStatus: string[] = [];
  pipelineStatus.push(item.embedded_at ? "embedded" : "awaiting embedding");
  pipelineStatus.push(item.entity_extracted_at ? "entities extracted" : "awaiting entities");

  const metadataBlock = metadataEntries.length > 0
    ? detailsPanel(
        `Metadata (${metadataEntries.length})`,
        `<pre class="tma-mono" style="white-space:pre-wrap; margin:0;">${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>`,
      )
    : "";

  const title = item.title || "(untitled)";
  const subtitle = `${formatDate(item.captured_at)} · ${item.source_table}#${item.source_id}`;

  const body = `
    ${pageHeader(title, {
      subtitle,
      actions: `<a href="${escapeAttr(backUrl)}" class="tma-link tma-link-sm">← ${escapeHtml(backLabel)}</a>`,
    })}
    <div style="padding:0 var(--sp-4) var(--sp-2);">
      ${kindBadge(item.kind)}
      ${urlBlock}
    </div>
    ${section(`Entities (${entities.length})`, entitiesBlock)}
    ${section("Body", `<div class="tma-px-4">${bodyBlock}${metadataBlock ? `<div style="margin-top:var(--sp-3);">${metadataBlock}</div>` : ""}</div>`)}
    <div class="tma-meta" style="padding:0 var(--sp-4) var(--sp-5);">
      atlas#${item.id} · ${escapeHtml(pipelineStatus.join(" · "))} · updated ${formatAgo(item.updated_at)}
    </div>
  `;
  return miniAppLayout("library", body, false);
}
