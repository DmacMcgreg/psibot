# PsiBot Capture

Plain-JS MV3 extension, load-unpacked, no build step. Two things live here now:

1. **Capture** (original): send pages, selections, and X bookmarks to
   PsiBot's inbox at `http://localhost:3141/api/inbox`.
2. **Tab archive** (added): silently screenshot + extract text from tabs
   you haven't touched in a while (or once you're over your open-tab
   budget), POST them to the tab-archive server at
   `http://localhost:4820`, and only then close them. Search and restore
   archived tabs from the popup's "Archive" tab.

See `apps/tab-archive/ISA.md` (fleet-native repo) for the full spec this
implements — this extension is the "E4" piece of that plan.

## Load into the browser (Chrome/Edge/Vivaldi)

1. `chrome://extensions` (or `vivaldi://extensions`) → enable **Developer
   mode**.
2. **Load unpacked** → select this folder
   (`telegram-claude-code/extensions/psibot-capture/`).
3. After editing any file, hit the reload icon on the extension card (no
   build/watch step — it's plain JS, edits take effect on reload).

## Capture (unchanged)

- Toolbar icon → **Save This Page**, or `Cmd+Shift+S` / `Ctrl+Shift+S`.
- Right-click → **Save to PsiBot** (selection) / **Save Page to PsiBot**.
- On `x.com/i/bookmarks` or `twitter.com/i/bookmarks`, a content script
  extracts visible bookmarks for bulk save (`content-x-bookmarks.js`).
- Badge shows today's capture count; popup shows connection status and
  totals.

## Tab archive (added)

### Files

- `sweep.js` — **pure logic, no `chrome.*` calls.** Decides which open
  tabs are eligible to archive this sweep, and whether a server response
  means it's safe to close a tab. Fully unit tested (see below) because
  this is the file that encodes the safety invariants.
- `tracking.js` — maintains `chrome.storage.local.tabActivity`, a
  `{[tabId]: {url, lastActiveAt}}` map, updated on tab activation, page
  load completion, and window focus change. Seeds from `tab.lastAccessed`
  on first sight; on worker/browser restart, re-keys by URL when tab ids
  shift (Chrome reassigns ids across restarts), always keeping the
  **older** of two candidate timestamps so reconciliation never makes a
  tab look artificially fresh. Prunes entries for closed tabs.
- `archive.js` — chrome-API-dependent orchestration: per-tab capture
  (screenshot + text + metadata), the sweep loop that calls into
  `sweep.js`, the 30-minute alarm, and the server calls the popup uses for
  search/restore/settings/test-connection.
- `background.js` — unchanged capture logic, plus a few lines at the top
  (`initTracking()`, `initArchiveAlarm()`) and a handful of new
  `chrome.runtime.onMessage` branches (`archive-*`) that the popup calls
  into. The service worker is now `"type": "module"` so these files can
  `import`/`export` each other.

### Sweep behavior

Every 30 minutes (`chrome.alarms`), and only while the user is idle
(`chrome.idle.queryState(300) === "idle"`, per the server's
`requireIdle` setting):

1. Fetch settings from the server (`get-archive-settings`); fall back to
   the last cached copy in `chrome.storage.local` if the server is
   unreachable. **If neither a fresh fetch nor a cache is available, the
   sweep is skipped entirely** — it never runs against hardcoded
   defaults.
2. Reconcile tab-activity tracking and prune closed-tab entries.
3. `selectEligibleTabs()` (in `sweep.js`) picks tabs that are either:
   - older than `archiveAfterDays` (age rule), or
   - among the oldest tabs once total open tabs exceed `tabBudget`
     (budget rule, oldest-first) —

   minus pinned, audible, the active tab in each window, non-`http(s)`
   URLs, tabs matching `excludedDomains`, and the sole remaining tab of a
   window (flagged with `needsBlankTab: true` but never auto-closed — v1
   just leaves it open rather than opening `about:blank` first).
   Capped at `sweepBatchLimit` per sweep cycle.
4. For each eligible tab: remember the window's currently-active tab,
   activate the target tab (this un-discards it if Chrome had discarded
   it), wait for `status: "complete"` + an 800ms settle (capped at 20s —
   on timeout it captures anyway rather than losing the tab), screenshot
   via `captureVisibleTab` (JPEG, quality 80), extract
   `document.body.innerText` (capped 500k chars), meta description, and
   title via `chrome.scripting.executeScript`.
5. **Privacy check** before any of the above content is attached: if the
   URL matches the built-in sensitive-host/path patterns (banks, webmail,
   login/checkout/auth paths — mirrors
   `apps/tab-archive/server/lib/tabs.ts` `DEFAULT_SENSITIVE_PATTERNS`) or
   the server's `excludedDomains`, the tab is archived **title/URL only**
   — no screenshot, no page text sent. The server independently re-checks
   the same blocklist (defense in depth).
6. POST to `archive-tab`. **The tab is closed ONLY if the response is
   HTTP 200 with a non-empty string `id`** (`decideClose()` in
   `sweep.js`) — `deduped: true` still counts as a durable acknowledgment
   and still closes. Any other outcome (network error, non-200, missing
   id) leaves the tab open.
7. The window's previously-active tab is re-activated afterward,
   regardless of outcome.
8. A per-tab failure (thrown exception anywhere in the capture/POST path)
   is caught, logged, and puts that tab on a 6-hour backoff
   (`chrome.storage.local.archiveFailureBackoff`) so **one bad page can
   never wedge the whole sweep**; every other eligible tab in the batch
   is still attempted.

### Popup — Archive tab

- Search box → `search-tabs` on the server; results render as compact
  cards (title, summary, workspace, relative archived-at). **Thumbnails
  are skipped in v1** — the server's `thumbUrl` is behind the same Bearer
  auth as everything else, and wiring an authenticated `<img>` fetch
  (blob URL) felt like more plumbing than it's worth for a first pass.
  Revisit if the list gets hard to scan by title alone.
- **Restore** button per result → `restore-tab` → opens the original URL
  in a new tab.
- "Last sweep" status line (relative time + count archived), from
  `chrome.storage.local.archiveSweepStatus`.
- Collapsible **Server settings**: `serverUrl` (default
  `http://localhost:4820`) and Bearer `token`, stored in
  `chrome.storage.local` (no separate options page — this extension
  doesn't have one, so settings live in the popup itself). A **Test
  connection** button hits `get-archive-settings` and reports success or
  the error.

### `chrome.debugger` fallback (documented, not used)

Screenshot capture uses brief tab activation + `captureVisibleTab`, not
`chrome.debugger`. `chrome.debugger` was considered and rejected for the
sweep path: it shows a persistent "extension is debugging this browser"
infobar (disruptive for a background maintenance task), and discarded
tabs still need a real navigation/reload to extract text regardless — so
debugger attach buys nothing there. If idle-gated brief activation ever
proves too disruptive in practice (e.g. it steals focus from something
the user is doing despite the idle gate), the fallback would be:
attach `chrome.debugger` to the target tab, use
`Page.captureScreenshot` (no visible tab activation needed) and
`Runtime.evaluate` for text extraction, then detach. Not implemented —
the infobar and its "stop debugging" click-through were judged worse
than a five-second tab-switch during confirmed idle time.

### `vivExtData` spike — findings

Vivaldi stashes per-tab workspace/group metadata in an undocumented
`vivExtData` string property on the `chrome.tabs.Tab` object (not part of
the public MV3 `chrome.tabs` typings). `readVivExtData()` in `archive.js`
best-effort `JSON.parse`s it and extracts `workspaceId`/`group` when
present, falling back to just `windowId` + `stackId` (tab group id) when
it isn't. **This needs to be verified against a real Vivaldi window with
workspaces in use** (not exercised by the unit tests, which are pure
`sweep.js` logic and don't touch `chrome.tabs`) — treat the current
implementation as the best-effort floor described in the original plan
(`windowId`/`stackId` always sent; `workspaceId` sent only when Vivaldi
happens to expose it in the shape this code expects). If a live check
shows `vivExtData`'s shape differs, update `readVivExtData()` accordingly
— it's isolated to that one function.

## Tests

`sweep.js` is pure (no `chrome.*` calls) specifically so it can be unit
tested directly with `bun test`:

```sh
bun test extensions/psibot-capture/sweep.test.js
```

Covers, per `apps/tab-archive/ISA.md` ISC-1..4:

- **Age rule** — older-than-threshold selected, younger not, untracked
  tabs treated as maximally old, exact-boundary (`==` threshold) not
  selected.
- **Budget rule** — oldest-first selection once total open tabs exceed
  budget; counts ALL open tabs (including pinned) toward the budget, not
  just candidates; no-op when under budget.
- **Exclusions** — pinned, audible, active-in-window, non-`http(s)`
  schemes, `excludedDomains` (exact host + subdomain match), and the
  last-remaining-tab-of-a-window (flagged, not closed).
- **Batch cap** — `sweepBatchLimit` is respected, oldest first.
- **`decideClose`** — closes only on HTTP 200 + non-empty string `id`
  (including `deduped: true`); never closes on non-200, missing/empty/
  non-string id, or a null/undefined response (network failure).
- **`hasUsableSettings`** — the no-settings-no-sweep guard.

`tracking.js` and `archive.js` are `chrome.*`-dependent and are exercised
by loading the extension unpacked rather than unit tested directly.
