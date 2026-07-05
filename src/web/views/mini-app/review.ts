/**
 * Review queue — full-screen triage queue for `pending_items` in `triaged`
 * status. Replaces the Chat tab as the Mini App's primary "work the backlog"
 * surface. Each item is a prominent card with the four terminal actions
 * (Research / Watch / Archive / Drop); acting on a card removes it and
 * decrements the remaining-count header.
 *
 * Server-rendered template literals only; all dynamic text escaped via
 * escapeHtml / escapeAttr. Page-local styles are scoped here (tma.css is owned
 * by another agent) and use only design tokens — no hardcoded colours.
 */

import { miniAppLayout } from "./shell.ts";
import {
  pageHeader,
  emptyState,
  errorState,
  badge,
  markdownSnippet,
  formatAgo,
  escapeHtml,
  escapeAttr,
} from "./components.ts";
import type { PendingItem } from "../../../shared/types.ts";

/** How many cards render per page / "Load more" batch. */
export const REVIEW_PAGE_SIZE = 20;

const ACTIONS: { action: string; label: string; kind: "primary" | "secondary" | "danger" }[] = [
  { action: "research", label: "Research", kind: "primary" },
  { action: "watch", label: "Watch", kind: "secondary" },
  { action: "archive", label: "Archive", kind: "secondary" },
  { action: "drop", label: "Drop", kind: "danger" },
];

/** Priority → badge. P1–P2 accent (hot), P3 warn, P4+ / null muted. */
function priorityBadge(priority: number | null): string {
  if (priority == null) return "";
  if (priority <= 2) return `<span class="tma-badge tma-badge-accent">P${escapeHtml(priority)}</span>`;
  if (priority === 3) return `<span class="tma-badge tma-badge-warn">P${escapeHtml(priority)}</span>`;
  return `<span class="tma-badge tma-badge-muted">P${escapeHtml(priority)}</span>`;
}

/** The count pill shown in the header — carries hx-swap-oob so action POSTs can update it. */
export function reviewCount(remaining: number): string {
  const label = remaining === 1 ? "1 item" : `${remaining} items`;
  return `<span id="review-count" hx-swap-oob="true">${badge(label, remaining > 0 ? "accent" : "muted")}</span>`;
}

/**
 * A single triage card. The four action buttons hx-post to the review API;
 * on success the whole card is swapped out (outerHTML, 200ms) so it animates
 * away, and a toast + haptic fire via tma.js.
 */
export function reviewCard(item: PendingItem): string {
  const title = item.title?.trim() || item.url || "(untitled)";
  const body = markdownSnippet(item.extracted_value ?? item.triage_summary ?? "", 200, title);

  const metaParts: string[] = [];
  if (item.platform) metaParts.push(escapeHtml(item.platform));
  metaParts.push(escapeHtml(formatAgo(item.captured_at ?? item.created_at)));
  const meta = metaParts.join(" · ");

  const titleHtml = item.url
    ? `<a href="${escapeAttr(item.url)}" target="_blank" rel="noopener" class="review-card-title">${escapeHtml(title)}</a>`
    : `<span class="review-card-title">${escapeHtml(title)}</span>`;

  const bodyHtml = body
    ? `<div class="review-card-body">${escapeHtml(body)}</div>`
    : "";

  const buttons = ACTIONS.map((a) => {
    const toast = a.label; // shown in the success toast
    return `<button type="button" class="tma-btn tma-btn-${a.kind} review-action"
      hx-post="/tma/api/review/${escapeAttr(item.id)}/${escapeAttr(a.action)}"
      hx-target="#review-card-${escapeAttr(item.id)}"
      hx-swap="outerHTML swap:200ms"
      hx-on::after-request="if(event.detail.successful){showToast('${escapeAttr(toast)}');}"
    >${escapeHtml(a.label)}</button>`;
  }).join("");

  return `<article id="review-card-${escapeAttr(item.id)}" class="review-card">
    <div class="review-card-head">
      ${titleHtml}
      ${priorityBadge(item.priority)}
    </div>
    <div class="review-card-meta">${meta}</div>
    ${bodyHtml}
    <div class="review-card-actions">${buttons}</div>
  </article>`;
}

/**
 * The list body: N cards + an optional "Load more" button. The button hx-gets
 * the next page and appends it (beforeend) into #review-list, replacing itself.
 * Returned both by the full page and the /review/list fragment.
 */
export function reviewListItems(items: PendingItem[], offset: number, total: number): string {
  const cards = items.map(reviewCard).join("\n");
  const nextOffset = offset + items.length;
  const more =
    nextOffset < total
      ? `<div id="review-more" class="review-more">
      <button type="button" class="tma-btn tma-btn-secondary"
        hx-get="/tma/review/list?offset=${escapeAttr(nextOffset)}"
        hx-target="#review-more"
        hx-swap="outerHTML">Load more (${escapeHtml(total - nextOffset)})</button>
    </div>`
      : "";
  return cards + more;
}

/** Scoped page styles — tokens only, no hardcoded colours. */
const REVIEW_STYLE = `<style>
  #review-list { padding: 0 var(--sp-4) var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-3); }
  .review-card {
    background: var(--tma-bg-secondary);
    border-radius: var(--rad-md);
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  /* Card leaving the queue: collapse + fade during the 200ms swap. */
  .review-card.htmx-swapping {
    opacity: 0;
    transform: translateX(16px);
    transition: opacity 200ms ease, transform 200ms ease;
  }
  .review-card-head { display: flex; align-items: flex-start; gap: var(--sp-2); justify-content: space-between; }
  .review-card-title {
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--tma-text);
    text-decoration: none;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  a.review-card-title { color: var(--tma-accent); }
  .review-card-meta { font-size: var(--fs-xs); color: var(--tma-hint); }
  .review-card-body { font-size: var(--fs-sm); color: var(--tma-text); opacity: 0.85; }
  .review-card-actions {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-2);
    margin-top: var(--sp-1);
  }
  .review-card-actions .review-action { min-height: var(--touch); width: 100%; }
  .review-more { display: flex; justify-content: center; padding: var(--sp-3) 0; }
  .review-more .tma-btn { min-height: var(--touch); }
</style>`;

/** The empty "inbox zero" state, wrapped in the list container. */
function reviewEmpty(): string {
  return `<div id="review-list">${emptyState("🎉", "Inbox zero 🎉", "No items waiting for review.")}</div>`;
}

/** Full Review page. */
export function tmaReviewPage(items: PendingItem[], total: number): string {
  const header = pageHeader("Review", {
    actions: `<span id="review-count">${badge(
      total === 1 ? "1 item" : `${total} items`,
      total > 0 ? "accent" : "muted",
    )}</span>`,
  });

  const list =
    total === 0
      ? reviewEmpty()
      : `<div id="review-list">${reviewListItems(items, 0, total)}</div>`;

  return miniAppLayout("review", `${REVIEW_STYLE}${header}${list}`);
}

/** Error page (full shell) when the queue can't be loaded. */
export function tmaReviewError(message: string): string {
  return miniAppLayout("review", `${pageHeader("Review")}${errorState(message, "/tma/review")}`);
}

/** Error fragment for the list endpoint. */
export function tmaReviewListError(message: string): string {
  return errorState(message);
}
