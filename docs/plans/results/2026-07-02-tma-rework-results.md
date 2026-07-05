# Telegram Mini App Rework — Results

**Plan:** [2026-07-02-tma-rework.md](../2026-07-02-tma-rework.md)
**Date:** 2026-07-02
**Status:** Complete — verified end-to-end, daemon restarted clean.

---

## What changed

### Phase A — Foundation

**A1 (frontend):**
- `public/tma.css` rebuilt on the plan's token system: `--sp-*` spacing ladder, `--fs-*` type scale, `--rad-*` radii, Telegram-theme-derived semantic colors (`--tma-bg`, `--tma-accent`, `--tma-ok/warn/err` etc). Badge-only dark-mode media query removed — theming now flows from Telegram theme vars everywhere. 1023 lines changed.
- `src/web/views/mini-app/components.ts` created (413 lines) — single home for `escapeHtml`/`escapeAttr`, `truncate`, `formatDate`/`formatAgo`/`formatCost`, `pageHeader`, `card`, `badge`/`statusBadge`, `filterChips`, `searchBar`, `emptyState`/`errorState`, `skeletonList`, `listRow`, `section`, `formField`/`formActions`, `detailsPanel`.
- `public/tma.js` created (235 lines) — all inline `<script>` logic consolidated: Telegram `ready()`/`expand()`, per-page BackButton handling, HTMX auth header injection, `htmx:responseError`/`htmx:sendError` toast handling, toast helper, markdown render + raw/rendered toggle, haptics on `.tma-btn`/tab taps, shared `tmaFilter()`.
- `src/web/views/mini-app/shell.ts` rewritten (91→147 lines) for the new 4-tab + More nav.

**A2 (backend):**
- `src/web/routes/mini-app.ts` (1017 lines) split into `src/web/routes/mini-app/` — `index.ts`, `shared.ts`, `chat.ts`, `jobs.ts`, `agents.ts`, `library.ts`, `youtube.ts`, `misc.ts`. The old path is now a 5-line re-export shim (see Follow-ups — kept because `src/web/index.ts` imports with a literal `.ts` extension that can't resolve to a directory index, and editing `index.ts` was out of partition).
- Hardening landed in `shared.ts`: `requireIntParam()` guards every `parseInt`; `activeSessionId` global replaced with `Map<telegramUserId, sessionId>`; SSE stream registry (`Map`) with real exception logging instead of silent catches.

### Phase B — Per-page rework (P1–P6)

| Page | View file | Route file | Notes |
|---|---|---|---|
| P1 Chat | `chat.ts` (226 lines) | `chat.ts` (205 lines) | Bubbles, streaming typing indicator, error bubble + retry, sticky composer, session header, Cancel button |
| P2 Jobs | `jobs.ts` (554 lines) | `jobs.ts` (258 lines) | `listRow` cards, `filterChips` + URL-param state, BackButton detail view, single-card-fragment mutations |
| P3 Agents | `agents.ts` (445 lines) | `agents.ts` (232 lines) | Ported to components/tokens, header action button for "New agent", monospace memory editor with toast+haptic |
| P4 Library | `library.ts` (636 lines) | `library.ts` (336 lines) | Componentized sub-pages, chip-row health strip, alias confirm+toast, capped related-entities list |
| P5 YouTube | `youtube.ts` (233), `youtube-graph.ts` (682) | `youtube.ts` (148) | List/tags/channels componentized with `tmaFilter`; graph kept surgical, wrapped in shell, tokens applied to chrome (graph node/edge colors intentionally left hex — see Follow-ups) |
| P6 Misc | `logs.ts`, `memory.ts`, `sessions.ts`, `skills.ts`, new `more.ts` | `misc.ts` (140 lines) | New `/tma/more` grid page; sessions `hx-vals` now via `escapeAttr`; logs show `$0.00` not `–` |

All pages pulled from the shared `components.ts`/`tma.css`/`tma.js` set with no page-local reimplementations reported as needed, except Library's file length (see below).

### Phase C — Review fan-out

Correctness/security, UX/design-consistency, and duplication/simplify reviews ran in parallel. Findings were grouped by file partition and fixed by the owning agents. **7 low-severity findings were deferred** (not blocking, logged as follow-ups below) — no high/critical findings were deferred.

### Phase D — Verification (Round 1, passed)

- `bun run tsc --noEmit` — clean, zero errors.
- Daemon restarted successfully (PID 44503, running); no crashes, no new mini-app errors in logs since restart.
- All 10 primary/secondary TMA pages (chat, jobs, agents, library, youtube, memory, logs, sessions, skills, more) return 200 with `tma.css` and `tma.js` present, non-empty bodies, no `undefined`/`[object Object]`/`NaN` rendering artifacts (the sole "undefined" hits were legitimate memory-file content referencing `Bun.env`, not template bugs).
- `/tma` (no trailing slash) 302-redirects to `/tma/chat` as expected.
- HTMX fragment spot-checks: `/tma/api/chat/init` returns rendered chat history HTML; `/tma/api/agents/coder/detail` returns a valid expanded card; `/tma/api/library/search?q=test` returns HTML rows; `/tma/jobs/12` renders a fully styled detail page.
- Hardening verified: `/tma/jobs/abc` → 400 (non-finite `requireIntParam` guard); `/tma/jobs/999999` → 404 (null-check after fetch); sessions `hx-vals` attributes are `&quot;`-escaped, confirming the `escapeAttr` fix.

---

## Known follow-ups

- **tma.css:** `.tma-save-ok` / `.tma-save-error` classes (agent memory save feedback) need legible token-based styling (success green / destructive red text) — currently unstyled after the inline-hex-to-class refactor.
- **`src/web/routes/mini-app.ts` shim:** kept as a 1-line re-export rather than deleted, because `src/web/index.ts` imports it with a literal `./routes/mini-app.ts` extension that can't resolve to a directory index. Drop the `.ts` extension in `index.ts` to remove the shim.
- **Foreign typecheck errors during the build** (`misc.ts` "Cannot find name log", TS2304 at various lines) were transient — resolved by end of session; final `tsc --noEmit` is clean.
- **Per-user session fallback:** unauthenticated `/chat` and `/sessions` page GETs key the "last active session" fallback on `ALLOWED_TELEGRAM_USER_IDS[0]`. Fine for single-user deployments; multi-user page loads would all show the first configured user's session on initial GET (API POSTs are correctly per-authenticated-user).
- **`/tma/more`** is a minimal placeholder (plain link list) — flagged in the plan as a P6 stopgap pending a designed icon grid.
- **`src/web/views/mini-app/library.ts`** ended at 636 lines, above the plan's <400-line single-file guidance; not split further to stay within partition boundaries.
- **`youtube-graph.ts`** keeps hardcoded hex for D3 node/edge colors (graph semantics, not theme) — chrome around the graph uses tokens; the visualization palette itself was left alone per "surgical changes only" scope.
- **`searchBar()` in components.ts** targets a `.tma-search-scope` wrapper class that isn't formally defined in `tma.css` yet; pages using it currently supply their own wrapper. Worth formalizing upstream if more pages adopt `searchBar()`.

---

## File footprint

- Modified: `public/tma.css`, `src/web/routes/mini-app.ts` (now a shim), `src/web/views/mini-app/{agents,chat,jobs,library,logs,memory,sessions,shell,skills,youtube,youtube-graph}.ts`
- New: `public/tma.js`, `src/web/views/mini-app/components.ts`, `src/web/views/mini-app/more.ts`, `src/web/routes/mini-app/{index,shared,chat,jobs,agents,library,youtube,misc}.ts`
- Net diff on touched files: +2804 / −2770 lines (roughly flat total, heavily de-duplicated).
