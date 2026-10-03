# PsiBot stop-doing-X rules inventory — 2026-10-03

Row `psibot-behaviour-regression-tests` (scout). Serves the Studio goal
"PsiBot behaviour rules stay fixed". Two halves: the 14 `autonomy_rules`
rows (the stop-doing-X inventory) and the regression tests the goal names.

Live registry never touched — every read below is a read-only `/tmp`
snapshot (db+wal+shm copied together, the established pattern from
`apps/psibot-job-health-digest/run.ts:27-35`, vivaldi-home).

## Registry state across this run

| end | Oct 3 00:49 | `e9d2017a24f52013` | 14 |
|---|---|---|---|
| start | Oct 3 00:21 | `e9d2017a24f52013` | 14 |

Byte-stable across the run; equals the day-apart baseline in
`research/psibot-rules-invariant-2026-10.md` (vivaldi-home).

## How a rule is born (mechanics, for future readers)

Every triage action (research/watch/archive/drop on a pending item) calls
`applyItemAction` → `updateAutonomyFromFeedback`
(`src/triage/actions.ts:137-163`, `src/heartbeat/autonomy.ts:36`). The
compound signal key is `platform:profile:value_type`
(`src/triage/actions.ts:54-63`); the system recommendation is always
`triage` (everything is `level=manual`), and `learned_action` records
David's **most recent** action for that signal. `checkAutonomyRule` returns
null at `manual`, so no rule auto-acts — they are the durable record of
"stop doing the default for this signal, do X instead".

## The 14 rules → originating behaviour → test status

Feedback counts from `feedback_log` ⋈ `pending_items` on the Oct 3 00:21
snapshot (420 rows, 2026-03-24 → 2026-09-26). `research`/`watch`/`archive`
columns count David's actions on that signal class; the learned action is
his last one.

| id | signal (platform:profile:value_type) | learned | decisions | David's actions (n) | stop-doing-X reading | test status |
|---|---|---|---|---|---|---|
| 1 | `digest_item:source:telegram` | research | 12 | research 208, watch 56, archive 18 (all sources, digest feedback) | stop auto-filing telegram digest items — surface them | pinned by rulesHash watch |
| 13 | `reddit:*:unknown` | research | 22 | research 19, watch 1, archive 2, archive:irrelevant 1 | stop discarding unclassified reddit captures — research them | pinned by rulesHash watch |
| 16 | `github:*:unknown` | research | 107 | research 67, watch 28, archive 8, archive:known 2, drop:outdated 2, archive:outdated 3 | stop discarding unclassified github captures — research them | pinned by rulesHash watch |
| 30 | `github:*:tool` | research | 49 | research 31, watch 9, archive 6, archive:known 1, archive:outdated 2 | github tool repos stay research-first | pinned by rulesHash watch |
| 39 | `x.com:default:tool` | archive | 30 | research 15, watch 7, archive:known 5, archive:outdated 3, archive 1 | **stop researching/watching X tool posts — archive** (bulk curation 2026-07-02 23:01-23:07Z) | pinned by rulesHash watch |
| 40 | `x.com:default:technique` | watch | 10 | research 11, watch 1, archive:known 1, archive:outdated 1 | stop researching X technique posts — watch only | pinned by rulesHash watch |
| 55 | `x.com:default:actionable` | research | 11 | research 9, watch 3 | X actionable posts stay research | pinned by rulesHash watch |
| 90 | `youtube:*:tool` | research | 55 | research 35, watch 4, drop:low_quality 5, drop:irrelevant 4, drop 2, drop:outdated 1, archive:known 2, archive:outdated 1, archive 1 | youtube tool videos stay research; low-quality ones get dropped (Sep 25 sweep) | pinned by rulesHash watch; channel gate = surface-policy (below) |
| 92 | `youtube:*:technique` | research | 13 | research 11, watch 1, archive:outdated 1 | youtube technique videos stay research | pinned by rulesHash watch |
| 172 | `reddit:*:tool` | research | 2 | research 2 | reddit tool posts stay research | pinned by rulesHash watch |
| 217 | `reddit:holofractal:technique` | watch | 1 | watch 1 | holofractal techniques: watch, don't research | pinned by rulesHash watch |
| 218 | `youtube:*:actionable` | research | 9 | research 7, watch 1, archive:known 1 | youtube actionable stays research (created 2026-07-02 bulk curation) | pinned by rulesHash watch |
| 229 | `reddit:ADHD_Programmers:technique` | archive | 1 | archive 1 | **stop surfacing ADHD_Programmers techniques — archive** | pinned by rulesHash watch |
| 320 | `github:*:technique` | research | 1 | research 1 | github write-ups stay research (created 2026-09-26) | pinned by rulesHash watch |

No per-rule code test exists or is needed: the rules are DB rows, and their
guard is the behaviour-column hash watch (`rulesHash`,
`apps/psibot-job-health-digest/health.ts:187-192`), which fails on any
edit to these 14 rows. The Jul-2 (23:01-23:07Z, ~40 actions) and Sep-25/26
(23:47-01:10Z, drop-storm on `youtube:*:tool`) clusters are bulk
curation sessions, not code regressions.

## The three named regressions (goal criterion 0)

Named in `docs/research/2026-07-22-behavior-regression-analysis.html`:
News-flood, morning-brief self-report, OAuth-link. Each already has the
deterministic gate + the prescribed regression test **sitting uncommitted
in the working tree** (154 dirty files, sibling discovery-quality WIP):

| Regression | Gate | Test | Bite proof (this run, /tmp copy of the working tree) | Status |
|---|---|---|---|---|
| News-flood (per-item GitHub/Reddit cards) | `src/shared/surface-policy.ts` `DISCOVER_ONLY_SOURCES = [youtube, github, reddit]` (github/reddit added 2026-07-22) | `src/shared/surface-policy.test.ts` "keeps automated poller sources out of the inbox channel" | removing github/reddit from the array → test fails | **uncommitted** (`M` both files) |
| Morning-brief self-report | `src/agent/notify-policy.ts` `case "dynamic"`: no `[NOTIFY]` marker + success → `notify:false` | `src/agent/notify-policy.test.ts` "dynamic policy drops an unmarked work report" | making dynamic broadcast unmarked reports → test fails | **untracked** (test file `??`; gate committed) |
| OAuth-link (expiry warnings without dashboard URL) | `src/shared/oauth.ts` `buildReauthMessage()` | `src/shared/oauth.test.ts` "reauth message … includes the dashboard link" | breaking the URL lookup → 2 tests fail | **untracked** (`??` both files) |

Bite-proofs ran on `/tmp/bite-main` (copy of `src/` + symlinks), never on
the sibling's files; restored → 11/11 green. **Gap for David / the WIP
owner:** these three tests satisfy criterion 0's
"failing-then-passing" only once their owner lands them — this row's
scoped commit cannot carry foreign WIP.

## The three recovered regressions landed this row (red → green)

Recovered from git history; all three had **no test at all** before this
row. Red proven at each fix's parent commit (detached worktree, symlinked
`node_modules`/`.env`); green in the working tree:

| Fix commit | Regression | Test (this row) | Red @ parent | Green |
|---|---|---|---|---|
| `fcbe15e` 2026-07-05 | job/heartbeat prompt containing "think hard"/"use opus" overrode the configured model and ran Opus | `src/agent/opus-escalation-gate.test.ts` (3 tests) | 2 fail @ `fcbe15e~1` (`751d1d0`) | 3 pass |
| `8291ea9` 2026-07-05 | offset-bearing `run_at` ("…-04:00") got a `Z` appended → Invalid Date → `toISOString()` threw inside `reload()` — daemon died on restart; invalid `run_at` crashed instead of failing the job | `src/scheduler/once-runat-offset.test.ts` (3 tests) | 2 fail @ `8291ea9~1` (`e7ac451`) | 3 pass |
| `dc6b4b7` 2026-07-05 | internal review turns (`chat_messages.source='review'`) leaked into session search hits/excerpts/counts and session reads | `src/sessions/search-review-exclusion.test.ts` (1 test) | 1 fail @ `dc6b4b7~1` (`c3b268b`) | 1 pass |

Notes on validity: `src/agent/index.ts` and `src/sessions/search.ts` are
clean at HEAD, so those greens are HEAD greens. `src/scheduler/index.ts`
carries sibling WIP (+171 lines) but the once/`run_at` branch is byte-wise
outside every WIP hunk, and the daemon-crash path is the committed logic.
A clean-HEAD worktree cannot run any suite that imports
`src/db/queries.ts` — HEAD's committed `queries.ts` imports the sibling's
untracked `src/shared/published-date.ts` (pre-existing mid-flight refactor,
not this row's doing).

## Already-tested behaviour regressions (record, no action)

- `fc1328c` (2026-10-02) empty first response errored instead of retry/skip
  — `src/agent/empty-response-retry.test.ts`.
- `204c870` (2026-07-15) YouTube summaries leaked into News via the
  heartbeat path — the youtube half of `surface-policy.test.ts` (now folded
  into the github/reddit WIP test above).
- `46fb7f9` (2026-07-05) maintenance touches zeroed skill usage —
  `src/skills/score.test.ts`.

## Residual gaps (honest list)

1. The three named regressions' tests are uncommitted sibling WIP — the
   owner's landing commit is what completes criterion 0 verbatim.
2. `8291ea9`'s other half — the over-cap reminder sweep
   (`dismissOverCapReminders`) — has no test; one-time cleanup dismissed 31
   stuck rows in the live DB.
3. The goal's criterion text itself is not readable through the fleet's
   Studio surface (`fw goals`/`fw thread` show titles only); the three
   names were recovered from the repo's own analysis doc, which matches the
   goal's wording ("three named regressions").
