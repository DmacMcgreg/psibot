# Inbox Pipeline — State Machine

Items flow through a pipeline from capture to user action. Both Telegram and NotePlan are first-class interfaces — every action available in one is available in the other.

## States

```
captured → pending → triaged → [user action] → archived/deleted
```

| Status | Meaning |
|--------|---------|
| `pending` | Awaiting auto-triage (next heartbeat) |
| `triaged` | Classified, surfaced to user, awaiting action |
| `archived` | User acted on it (research done, watching, or dismissed) |
| `deleted` | Dropped — no value |

## Triage (automatic)

Runs every heartbeat tick on `pending` items. Uses GLM to:
- Fetch and read the actual page content
- Classify value type (technique, tool, actionable, no_value)
- Extract the transferable nugget (not just a summary)
- Assign priority 1-5
- Create a NotePlan note in `00 - Inbox/`

After triage, items are surfaced to Telegram (News topic) with action buttons.

## User Actions

Available from both Telegram buttons and NotePlan tags:

| Action | Telegram Button | NotePlan Tag | What Happens |
|--------|----------------|--------------|--------------|
| Quick Scan | Research > Quick Scan | `action/research-quick` | Web search + synthesize findings (GLM, cheap) |
| Deep Dive | Research > Deep Dive | `action/research-deep` | Full analysis + NotePlan research note (Claude, expensive) |
| Research (generic) | — | `action/research` | Alias for Deep Dive |
| Watch | Watch | `action/watch` | Archives + sets watch_status for monitoring |
| Archive | Archive | `action/archive` | Dismisses the item |
| Drop | Drop | `action/drop` | Marks as deleted (no value) |
| Retriage | — | `action/retriage` | Resets to `pending`, clears all triage data |

## Three Levels of Analysis

| Level | Trigger | Model | Web Search | NotePlan Note | Output | Cost |
|-------|---------|-------|------------|---------------|--------|------|
| **Triage** | Automatic on capture | GLM | No (reads page directly) | `00 - Inbox/` (classification only) | value_type, priority, 2-3 sentence summary | Cheapest |
| **Quick Scan** | User-triggered | GLM + web tools | Yes (2-3 pages) | `70 - Research/queued/` (with theme links) | Summary, key findings, suggested actions | Medium |
| **Deep Dive** | User-triggered | Claude + web tools | Yes (5+ pages) | `70 - Research/queued/` (with theme links) | Full analysis, suggested actions, sources | Expensive |

All three levels create NotePlan notes. Quick Scan and Deep Dive both create research notes with automatic linking to related existing notes via the knowledge linker.

## Execution Paths

### From Telegram
1. Backlog items surfaced with [Research] [Watch] [Archive] [Drop] buttons
2. [Research] shows [Quick Scan] [Deep Dive] buttons
3. Quick Scan / Deep Dive execute immediately inline
4. Results posted back with [Deep Dive] [Watch] [Archive] buttons

### From NotePlan
1. User adds `action/research-quick` (or other tag) to note frontmatter
2. Inbox watcher (heartbeat tick) detects tag, sets `auto_decision` queue flag
3. Research execution phase (same heartbeat tick) picks up queued items
4. Results posted to Telegram News topic with action buttons
5. Deep Dive also saves a research note to NotePlan

## auto_decision Values

| Value | Meaning |
|-------|---------|
| `quick_research_queued` | Awaiting quick scan execution |
| `quick_research_running` | Quick scan in progress |
| `quick_research_done` | Quick scan complete |
| `quick_research_failed` | Quick scan errored |
| `deep_research_queued` | Awaiting deep dive execution |
| `deep_research_running` | Deep dive in progress |
| `deep_research_done` | Deep dive complete |
| `deep_research_failed` | Deep dive errored |
| `research_requested` | Legacy — user clicked Research in Telegram |

## Signal Scoring & Autonomy

### Compound Signal Keys
Each item gets a compound key: `{platform}:{profile}:{value_type}` (e.g., `reddit:LocalLLaMA:technique`).

### Automatic Actions (no learning needed)
- P5 + `no_value` (confirmed, not a triage failure) → auto-archive
- Everything else → surface to user

### Learned Autonomy (builds from user clicks)
Every Research/Watch/Archive/Drop action records feedback against the item's compound key. Over time:
- 5 consistent decisions at 70% agreement → `suggest` level
- 15 at 90% → `auto_report` (acts automatically, tells you)
- 30 at 95% → `silent` (acts automatically, no notification)

The system learns patterns like "items from reddit:LocalLLaMA:technique → user usually researches" and eventually auto-triggers research for matching items.

If the user overrides a learned action, the rule resets to manual.

## Heartbeat Tick Phases

1. **Intake** — triage `pending` items, score signals, check autonomy rules
2. **Inbox Watcher** — scan NotePlan tags, sync DB
3. **Theme Clustering** — group related items
4. **Surfacing** — send unsurfaced `triaged` items to Telegram
5. **Research Execution** — run queued quick/deep research
6. **Reminders** — check and send due reminders
