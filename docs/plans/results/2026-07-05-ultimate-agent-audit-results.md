# "Ultimate Telegram Agent" Audit + Fix Session — Results

**Date:** 2026-07-05
**Status:** Complete — deployed (daemon restarted, PID 97355), all validation green.
**Method:** 7-auditor parallel workflow (opus×2 + sonnet×5) → 35 structured findings → 2 fix waves (opus/sonnet/glm-5.2 on disjoint file partitions) → adversarial review (opus + codex gpt-5.5, findings verified by sonnet skeptics) → live validation.

## Headline outcomes

| User ask | State before | State after |
|---|---|---|
| Use the latest MCP server (local-mcp-hub) | Not wired at all — `settingSources: []` blocked inheritance; zero hub tools reachable | `src/agent/hub-mcp.ts` wires hub-edge as stdio MCP server (`HUB_MCP_ENABLED`/`HUB_EDGE_BIN` knobs, `--client other`); handshake verified against live hub-core |
| Skills it creates are relevant | HOT tier 100% occupied by zero-usage skills; real-usage history zeroed by a scoring bug; verdicts never recorded | Legacy/event score blend, new-skill boost capped at 0.5 use-equivalent, `latestRealActivity` honors legacy timestamps, deterministic neutral-verdict fallback, export-approval Telegram nudge (Approve/Skip buttons) |
| Keyboard responses make sense | Stale Cancel button on every finished reply; Cancel mistargets overlapping runs; dead ba/br keyboard; brief drill-down lost split-message context | Cancel cleared on success+error (text & voice); activeRuns keyed per thinking-message; dead flow deleted; brief context fetched from job_runs; rxr/rdr share `applyItemAction(reason)` |
| Reminder system not broken | Reminders went permanently inert at max_reminds (dead-code dismiss); malformed once-job `run_at` could crash the daemon; 3 undocumented overlapping mechanisms | Over-cap dismiss sweep (31 stuck rows cleaned); once branch try/catch + tz-aware parsing; routing guidance in TOOLS.md (job_create vs create_reminder vs remindctl) |
| YouTube + weekly newsletter working & relevant | Discovery digest never delivered once in 28 runs; research pipeline notify_policy silenced all successes; "Research completed" section full of triage junk; YouTube section unranked | Delivery fallback fixed + `DISCOVERY_NEWS_TOPIC_ID=49`; job 35 → `dynamic` with [NOTIFY]/[SILENT]; research filter on `auto_decision`; YouTube ranked by rising-entity overlap + mined-news persisted (`discovery_news_items`); short TG summary linking `/tma/digest/:week` |
| Mini app integrated where needed | Review queue lacked Telegram's reason-capture and quick/deep research; no deep links anywhere; no backlog badge | Reason chips + Quick/Deep parity (same `applyItemAction`); job notifications carry "Open in app" buttons (`tmaLink()`); research notifications link review queue; Review tab badge (triaged count) |

## Agent core (bonus findings)

- Background self-review no longer pollutes chat history / daily logs / search: stored as `source='review'`, excluded from `getMessagesBySession` + sessions search; `chat_messages` CHECK rebuilt to admit it (19,947 rows preserved).
- Fallback ladder degrades sonnet-before-haiku with a final `claude-opus-4-8` rung; explicit "think hard / use opus / deep think" marker escalates user-facing turns to Opus (gated so job prompts can't trigger it).
- GLM runs record $0 cost (`(glm flat-rate)` in daily logs) instead of fictitious Anthropic-priced dollars.
- IDENTITY.md markdown guidance fixed (bold works via markdownToTelegramV2); TOOLS.md regenerated from the real tool surface incl. hub workflow.

## Known remaining items (need David)

1. **Bot lacks "Manage Topics" admin right** in the Psibot group — grant it, or discovery keeps using topic 49 / DM fallback (works fine either way).
2. **Primary brain is GLM-5.2** (`DEFAULT_MODEL`/`DEFAULT_BACKEND` in .env) — deliberate quota decision, untouched. Escalation markers ("use opus") now available per-message.
3. **hub-signal telemetry matching** stays expected-zero until PsiBot skills become hub golden paths (documented in hub-signal.ts).
4. Oversized skills (psibot @1197, web-ui-patterns @1231 lines) still need the curator's next pass to split (instruction added to curator prompt).
5. Old "Not logged in · /login" errors from youtube analyzer / news summarizer (2026-07-04, Claude Code OAuth) — recheck if they recur post-restart.

## Validation evidence

- `bun run tsc --noEmit` clean; `bun test` 69/69 (6 new tests).
- Adversarial review: codex found the `source='review'` CHECK violation (fixed + migration verified on live-DB copy); opus review confirmed one low finding (escalation gating, fixed); everything else cleared.
- Daemon restart clean; all 8 TMA pages 200; `/tma/digest/2026-W27` renders; hub-edge JSON-RPC initialize returns hub-core instructions; `composeWeeklyDigest()` live smoke: 4/4 sections, single 653-char TG chunk with `/tma/digest/` link.

## Commit trail (this session)

`30a9cee..fcbe15e` — 7 commits landing the pre-existing open work (skills lifecycle, discovery, digest, TMA rework, core wiring), then 11 fix/feature commits from the audit waves.
