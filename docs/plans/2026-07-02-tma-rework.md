# Telegram Mini App Rework — Plan

**Date:** 2026-07-02
**Scope:** `src/web/views/mini-app/*`, `src/web/routes/mini-app.ts`, `public/tma.css`, new `public/tma.js`
**Approach:** Keep the server-rendered HTML + HTMX architecture (right fit for this stack). Rebuild on a real design system, shared components, split routes, harden the backend, and go Telegram-native.

This document is the single source of truth for all implementation agents. Read it fully before touching code.

---

## Audit summary (why this rework)

**Frontend (views + CSS):**
- No design system: ad-hoc spacing (3–40px), 8 font sizes, 7 border radii, hardcoded hex colors bypassing Telegram theme vars.
- Massive duplication: every page rebuilds cards, filter bars, badges, truncation, date formatting; 3+ implementations of `escapeHtml`/truncate/relative-time.
- Inline style soup and giant template literals (jobs.ts 571 lines, library.ts 640 lines, youtube-graph.ts 569 lines with ~400 lines embedded JS).
- No loading/empty/error states; HTMX failures are silent; chat SSE errors close silently.
- Shallow Telegram integration: no haptics, no MainButton, single global BackButton handler, dark-mode media query covers only badges.
- 9 equal-width tabs in the bottom bar — unusable on a phone.
- Touch targets below 44px; no focus states; fixed grids break on narrow screens.

**Backend (routes/mini-app.ts, 1017 lines):**
- Monolith: 60 routes in one file, shared closures (`activeSessionId`, `streams` map).
- `activeSessionId` is a single global — cross-user session bleed.
- 9 instances of unvalidated `parseInt` (NaN reaches DB queries); missing 404 checks with `!` assertions (lines ~750, 862, 900).
- Unescaped error messages interpolated into HTML (lines ~968, 988, 1009) — XSS vector.
- N+1 queries: job actions re-fetch full job list; `/agents` runs `countJobsUsingAgent` per agent.
- SSE: silent catch blocks, no idle timeout, orphaned stream controllers accumulate in a global Map.
- Job-update logic duplicated and divergent between mini-app and dashboard routes.

---

## Design direction

### Navigation
Replace the 9-tab bar with **4 primary tabs + More**:

| Tab | Route |
|---|---|
| Chat | /tma/chat |
| Jobs | /tma/jobs |
| Library | /tma/library |
| Agents | /tma/agents |
| More | /tma/more (grid page: YouTube, Memory, Logs, Sessions, Skills) |

- Tab bar: icon (inline SVG, `currentColor`) + 11px label, 49px min height + safe-area inset, active tint `var(--tma-accent)`.
- Secondary pages (from More) show a page header with title; Telegram BackButton is shown on detail/secondary pages and hidden on the 4 primary tabs (`tg.BackButton.show()/hide()` per page).

### Design tokens (top of `public/tma.css`)
```css
:root {
  /* spacing — 4/8 ladder */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px;
  /* type scale */
  --fs-xs: 11px; --fs-sm: 13px; --fs-md: 15px; --fs-lg: 17px; --fs-xl: 20px;
  /* radius */
  --rad-sm: 8px; --rad-md: 12px; --rad-lg: 16px; --rad-full: 999px;
  /* semantic colors derived from Telegram theme */
  --tma-bg: var(--tg-theme-bg-color, #fff);
  --tma-bg-secondary: var(--tg-theme-secondary-bg-color, #f0f2f5);
  --tma-text: var(--tg-theme-text-color, #000);
  --tma-hint: var(--tg-theme-hint-color, #8e8e93);
  --tma-accent: var(--tg-theme-button-color, #3390ec);
  --tma-accent-text: var(--tg-theme-button-text-color, #fff);
  --tma-link: var(--tg-theme-link-color, #3390ec);
  --tma-destructive: var(--tg-theme-destructive-text-color, #e53935);
  --tma-surface: color-mix(in srgb, var(--tma-bg) 92%, var(--tma-text) 8%);
  --tma-border: color-mix(in srgb, var(--tma-text) 12%, transparent);
  /* status colors (used by badges — NEVER hardcode hex in views) */
  --tma-ok: #34c759; --tma-warn: #ff9f0a; --tma-err: #ff3b30;
}
```
Rules: all colors via tokens; all spacing via `--sp-*`; all font sizes via `--fs-*`; touch targets ≥44px (`min-height:44px` on buttons, inputs, tab links, list rows); visible `:focus-visible` outline using `--tma-accent`. Dark mode comes free via Telegram theme vars — remove the badge-only media query, keep `--tma-ok/warn/err` legible in both schemes (use `color-mix` backgrounds at ~18% opacity with full-strength text).

### Shared server components — new file `src/web/views/mini-app/components.ts`
Single home for ALL shared HTML builders and helpers. Every page must use these; no page-local reimplementations.

```ts
escapeHtml(s), escapeAttr(s)               // consolidate the 3+ copies
truncate(s, n), formatDate(ts), formatAgo(ts), formatCost(usd)
pageHeader(title, opts?: { subtitle?, actions? })
card(inner, opts?: { onclick?, href? })     // .tma-card
badge(label, kind: "ok"|"warn"|"err"|"muted"|"accent")
statusBadge(status)                          // maps job/agent/skill statuses -> badge kinds
filterChips(name, options, active)           // horizontal scroll chip row, HTMX-driven
searchBar(action, placeholder, value?)       // standard hx-get search input
emptyState(icon, title, hint?)
errorState(message, retryUrl?)
skeletonList(n)                              // loading placeholder rows
listRow({ title, subtitle?, meta?, badge?, href?, hxGet? })  // standard tappable row
section(title, inner)                        // titled group with consistent margins
formField(label, inputHtml), formActions(...buttons)
detailsPanel(summary, inner)                 // styled <details>
```
Components return HTML strings (same pattern as today). All dynamic text goes through `escapeHtml`; all attribute interpolation through `escapeAttr` (fixes the sessions `hx-vals` injection).

### Shared client JS — new file `public/tma.js`
Move ALL inline `<script>` logic out of shell.ts and pages into one static file:
- Telegram init: `ready()`, `expand()`, per-page BackButton management (`data-tma-root` attr on primary pages hides it).
- Auth header injection for HTMX + fetch (as today).
- **HTMX error handling**: `htmx:responseError` / `htmx:sendError` → error toast ("Request failed — tap to retry" where target known). No more silent failures.
- Toast helper (success + error variants), markdown rendering (`marked`), raw/rendered toggle.
- Haptics: `tg.HapticFeedback.impactOccurred('light')` on tap of `.tma-btn`, tab links; `notificationOccurred('success'|'error')` on toast.
- Filter/search list helper: one generic `tmaFilter(inputEl)` replacing the per-page copies.
- Serve via existing `/tma/static/` route.

### Backend restructure — `src/web/routes/mini-app/` directory
Split the 1017-line monolith mechanically, then harden:

```
src/web/routes/mini-app/
  index.ts     # createMiniAppRoutes(deps) — mounts sub-routers, static files, auth middleware (same public API as today)
  shared.ts    # deps type, requireIntParam(c,"id") helper, session store, SSE stream registry
  chat.ts      # chat page + POST /api/chat + SSE stream
  jobs.ts      # jobs pages + 8 job API routes
  agents.ts    # agents pages + 9 agent API routes
  library.ts   # library/entities/synthesis/aliases
  youtube.ts   # youtube list/tags/channels/graph + graph APIs
  misc.ts      # memory, logs, sessions, skills, /tma/more
```

Hardening (done during split, verified by review):
1. `requireIntParam`: every `parseInt` guarded — non-finite → 400. Every `getJob()`/`getAgent()`-style fetch null-checked → 404. No `!` assertions on query results.
2. All error strings rendered into HTML pass through `escapeHtml`.
3. `activeSessionId` → `Map<telegramUserId, sessionId>` in `shared.ts` (per-user).
4. SSE: log real exceptions (don't swallow as "client disconnected"), 30-min idle timeout sweep on the stream registry, remove entry on close.
5. N+1: job mutation endpoints return the single updated job card, not the re-rendered full list (add a small `jobCardFragment` response; HTMX targets the card by id `#job-<id>`). `/agents` computes job-usage counts in one query (`GROUP BY agent`) — add a `countJobsByAgent(): Map` query in `src/db/queries.ts` if not present.
6. Keep dashboard routes untouched (dedup with dashboard is out of scope for this pass).

`src/web/index.ts` import updates from `./routes/mini-app` continue to work (directory index).

---

## Page specs (one implementation agent each)

Global acceptance criteria for EVERY page:
- Uses `components.ts` + tokens only — zero hardcoded hex, zero page-local escape/format/truncate helpers, minimal inline `style=` (layout one-offs only).
- Loading (skeleton or HTMX indicator), empty, and error states present.
- Touch targets ≥44px; forms stack single-column below 400px (`grid-template-columns` responsive or flex-column).
- All user/DB text escaped. All HTMX mutation endpoints give visual feedback (toast or swap).
- Owns its view file AND its sub-router file; must not edit other pages' files, shell.ts, components.ts, tma.css, or tma.js (request additions via notes in output instead of editing shared files).
- `bun run tsc --noEmit` passes when done.

### P1 — Chat (`views/mini-app/chat.ts`, `routes/mini-app/chat.ts`)
- Message bubbles (user right/accent, assistant left/surface), timestamps, cost per assistant message (hint text).
- Streaming: typing indicator (animated dots), stream error → visible error bubble with retry button (re-POST last prompt); EventSource close handled.
- Sticky composer above tab bar (CSS class, not inline styles), textarea autosize, send disabled while streaming, Cancel button while streaming if API supports it.
- Session context: show current session id/model in header; "New chat" action.

### P2 — Jobs (`views/mini-app/jobs.ts`, `routes/mini-app/jobs.ts`)
- List: `listRow`-based cards — name, schedule (human cron), next/last run, status badge, topic chip.
- Filters via `filterChips` (topic, type, status) + search; keep client-side but through shared `tmaFilter`; state in URL query params so reload preserves it.
- Detail: opens as its own view (BackButton pattern), not a giant inline expansion. Sections: schedule, prompt, config, last 10 runs (compact rows, status badge + duration + cost).
- Edit form: single column, `formField` components; toggle/pause/trigger/delete actions with confirm on delete (`tg.showConfirm` fallback `confirm()`).
- Mutations swap the single job card (uses new fragment endpoint), toast on success.

### P3 — Agents (`views/mini-app/agents.ts`, `routes/mini-app/agents.ts`)
- Keep current structure (best page) but port to components/tokens; policy colors → `badge` kinds.
- "New agent" gets a proper header action button (not a bottom `<details>`).
- Memory file editor: monospace via CSS class, save gives toast + haptic.
- Forms drop multipart encoding (no file uploads).

### P4 — Library (`views/mini-app/library.ts`, `routes/mini-app/library.ts`)
- Split the 4 sub-pages into clearly separated render functions; keep one file if <400 lines after componentization, else note for follow-up.
- Health strip → horizontally scrollable chip row.
- Synthesis: file list as rows (no fixed-width sidebar); file view is its own page with BackButton.
- Alias approve/reject: confirm dialog + toast; entity detail caps related entities at 20 with "show all" expander.
- Large metadata JSON inside collapsed `detailsPanel`.

### P5 — YouTube (`views/mini-app/youtube.ts`, `views/mini-app/youtube-graph.ts`, `routes/mini-app/youtube.ts`)
- List/tags/channels: componentize, replace duplicated inline `filterList()` with shared `tmaFilter`, filter state in URL params.
- Graph page: keep D3 app but wrap in shell layout (or add explicit back-to-app header), extract its 880-line CSS into a `<style>` of trimmed rules using tokens where feasible, escape summary markdown output (`escapeHtml` before `marked` or DOMPurify-style attribute stripping — at minimum render with `marked.parse` then strip `<script>`), ESC closes search drawer, node sheet scrollable.
- This is the largest partition; prioritize list pages, keep graph changes surgical.

### P6 — Misc: Memory, Logs, Sessions, Skills + More page (`views/mini-app/{memory,logs,sessions,skills}.ts`, new `more.ts`, `routes/mini-app/misc.ts`)
- New `/tma/more`: icon grid of secondary pages (listRow or 2-col grid cards).
- Memory: componentize, search via `searchBar`, entries as `detailsPanel`.
- Logs: filter chips by source/model, tool calls in scrollable `detailsPanel`, show "$0.00" not "–".
- Sessions: sort by recency, fix `hx-vals` escaping via `escapeAttr`, confirm before fork, ellipsis on truncated previews.
- Skills: status badges via components, sort by state, keep detail markdown toggle.

---

## Phasing & dependencies

```
Phase A (parallel):  A1 foundation-frontend (shell.ts, components.ts, tma.css, tma.js — views side only, no route edits)
                     A2 foundation-backend  (routes/mini-app/ split + hardening + placeholder GET /tma/more in misc.ts; views untouched)
Gate:                typecheck must pass (fix-forward agent if not)
Phase B (parallel):  P1..P6 page agents (each owns view file(s) + its sub-router)
Phase C:             review fan-out — correctness/security (opus), UX/design-consistency, code-duplication/simplify
                     → dedupe findings → fixers grouped by file partition
Phase D:             verify — tsc, `psibot restart`, curl every /tma page for 200 + no raw "undefined"/"[object Object]",
                     screenshots of main pages via agent-browser at 390px width
Phase E:             results doc + CLAUDE.md active-plans update
```

Notes for all agents:
- Working tree has unrelated uncommitted changes — do NOT commit, do NOT touch files outside your partition.
- Bun runtime: `bun run tsc --noEmit` to typecheck. No jest/vitest.
- The daemon serves at `http://localhost:3141`; `/tma` pages are reachable from localhost (IP-allowlist auth fallback). `psibot restart` reloads it.
- HTML is produced as template-literal strings — keep that pattern; no JSX/frameworks.
