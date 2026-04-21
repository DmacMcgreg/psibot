# Morning Brief Instructions

Generate and deliver a life-admin-first morning intelligence briefing via Telegram.

## Intent

This brief is about **important real-life information**, not paper-trade noise. Priority order: what's happening today (calendar), what could ruin today (weather), what I must pay (bills), what I must read (tier-1 emails + info), what I must do (actions). Markets only matter in the context of news that moved them + high-impact events today. Week-ahead weather goes at the bottom for planning.

Hard rules:
- Keep the full brief under 2500 chars for Telegram readability.
- Every actionable item must result in either a NotePlan `task_add` **or** a `create_reminder` call. Nothing the user needs to do should live only in the brief text.
- Never overwhelm: tier-1 info capped at 3 per day; overflow queued to tomorrow via `task_add defer=<tomorrow>`.

## Data Sources (fetch in parallel)

### 1. Current Date/Time
Always run `date '+%Y-%m-%d %A %H:%M %Z'` first. Do NOT assume today's date.

### 2. Weather — Open-Meteo (one API, 7-day + hourly today)

Use Open-Meteo (free, no API key, gives 7+ days). wttr.in is **NOT** used — it only returns 3 days regardless of params.

Default location: Toronto (lat=43.6532, lon=-79.3832). If `knowledge/USER.md` specifies a different city, look up its lat/lon.

**One call covers both sections** — daily for 7 days (Week Ahead) + hourly for today (rain breakdown):

```bash
curl -sS 'https://api.open-meteo.com/v1/forecast?latitude=43.6532&longitude=-79.3832&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&hourly=temperature_2m,precipitation_probability,weather_code&timezone=America/Toronto&forecast_days=7' -o /tmp/wx.json
```

Parse with bun:
```bash
bun -e "const d = JSON.parse(await Bun.file('/tmp/wx.json').text()); console.log(JSON.stringify({days: d.daily, hours_today: d.hourly.time.slice(0,24).map((t,i)=>({t, temp: d.hourly.temperature_2m[i], precip: d.hourly.precipitation_probability[i], code: d.hourly.weather_code[i]}))}, null, 2));"
```

**Today's block (top of brief)**: use `daily.temperature_2m_max[0]`, `daily.temperature_2m_min[0]`, `daily.precipitation_probability_max[0]`, `daily.weather_code[0]`.

**Rain-today check**: if ANY of today's hourly `precipitation_probability >= 40`, show hourly breakdown (pick waking-window buckets: 9am, 12pm, 3pm, 6pm, 9pm — use `hourly.time[i]` where hour ∈ {9,12,15,18,21}).

**Week Ahead (bottom)**: 7 entries from `daily.time[0..6]` with max/min + precip% + emoji.

**WMO weather code → emoji**:
- 0 → ☀ (clear)
- 1, 2 → ⛅ (mainly clear / partly cloudy)
- 3 → ☁ (overcast)
- 45, 48 → 🌫 (fog)
- 51-57, 61-67, 80-82 → 🌧 (drizzle / rain)
- 71-77, 85, 86 → 🌨 (snow)
- 95-99 → ⛈ (thunder)

If Open-Meteo fails, replace the section text with "Weather unavailable" and continue.

### 3. Calendar
Run all in parallel, then merge:

```bash
# Apple Calendar (local SQLite, already set up)
bun run ~/Documents/2_Code/2025-08-01-apple-calendar-query/src/calendar-sqlite.ts

# Google Calendar — today + next 7 days, all calendars
gog calendar events list --json --time-min now --time-max +7d
```
Merge events from both sources. Dedupe by normalized title + start-time within ±15 min.

### 4. Bills — scan 4 sources, dedupe, create_reminder for each

Bill sources are scattered: the user doesn't know whether any given bill lives as an Apple Reminder, an Apple Calendar event, a Google Calendar event, or a Gmail email. Scan ALL four.

```bash
# Apple Reminders — all lists
remindctl show --all --json

# Apple Calendar — already fetched above, filter by bill regex
# Google Calendar — already fetched above, filter by bill regex
# Gmail
gog gmail search --json "subject:(invoice OR bill OR payment OR subscription OR 'amount due') newer_than:10d"
```

**Bill regex** (titles + email subjects): `/bill|pay|invoice|due|subscription|rent|insurance|mortgage|utility|electric|gas|water|hydro|phone|internet|cable/i`

**Dedupe** across sources: normalize vendor name (lowercase, strip punctuation, drop common words like "bill", "invoice", "payment") + due-date within ±2 days. Prefer the source with the most detail.

**For each unique bill**, compute `remind_date = due_date − 5 business days` (skip Sat/Sun). Then:

**If `today ≥ remind_date`** (bill is within the 5-biz-day window):
- Check `reminder_list` for an active or completed reminder matching this bill's `source_id` — **skip if already handled** (user may have already tapped PAID on a prior day).
- Call `create_reminder` with:
  - `type: "bill"`
  - `title: "💰 {vendor} — ${amount} due {due_date}"`
  - `description: "Source: {apple-rem|apple-cal|gcal|gmail}. {any context, e.g. invoice link or reminder list name}"`
  - `source_id: "{source}:{stable_id}"` — e.g. `apple-rem:0x8B92A1CD`, `gcal:event_id_xyz`, `gmail:msg_abc`. For unstable sources, use `bill:{normalized_name}:{due_date}`.
  - `priority: 2` (higher than default)
- This sends a Telegram message with PAID/SKIP/SNOOZE buttons. It is separate from the main brief message.
- Also add a NotePlan task: `task_add(title: "Pay {vendor} (${amount})", emoji: "💰", source: "bill")` on today's calendar note.

**If `today < remind_date`** (future bill, 6+ biz days out):
- Don't create a reminder today. But defer a NotePlan task: `task_add(title: "Pay {vendor}", emoji: "💰", source: "bill", defer: remind_date)`.
- Also schedule a one-off job: `job_create(type: "once", run_at: "{remind_date}T08:00:00", prompt: "[NOTIFY] ⚠️ Bill due in 5 biz days: {vendor} ({due_date}). Source: {source}.", name: "bill-remind-{normalized_vendor}-{due_date}")`.
- Before calling `job_create`, check `job_list` for a job with the same name — skip if it exists.

### 5. Important Emails (max 3, tier-1 only)
```bash
gog gmail search --json "is:important -category:promotions -category:social -category:updates newer_than:1d"
```
Filter to sender domains / contacts the user actually corresponds with. Skip newsletter-like subjects. Show sender name + 1-line subject. Max 3. Skip section if nothing tier-1.

### 6. Tier-1 Info (cap 3 + overflow queue)
Use `inbox_list` to get pending+triaged items from the capture pipeline. Rank by:
1. Explicit `priority` (if set), then
2. `signal_score` (if set), then
3. Source weight: research_done > github > reddit > inbox.

- **Top 3** → show in the brief with source + one-line summary.
- **Items 4..8** → `task_add(title: "{item_title}", emoji: "🔄", source: "queued", defer: tomorrow_YYYYMMDD)`. These re-surface in tomorrow's brief.
- **Items 9+** → leave in `pending_items` for normal triage.
- Brief shows `(queued={N} for tomorrow)` footer on the tier-1 section.

Also check `~/Documents/NotePlan-Notes/Notes/70 - Research/` for research notes modified in the last 24h — list titles only (not content) as a rollup.

### 7. Markets & News (reframed — news context, not watchlists)
```bash
curl -s http://localhost:8000/api/v1/calendar/upcoming?days=1&impact=high
```
- Grab overnight news impact from the latest scan in `knowledge/trading/scans/` (look for a 0200 file dated today or the most recent session) — extract the 1-2 line "what moved and why" summary.
- Show today's high-impact economic events with times (CPI / FOMC / Fed speakers / big earnings).
- Only mention paper-trade positions if trading-bot flags one as HIGH severity.
- If trading-bot is down AND no recent scan → skip section entirely (not "unavailable").

### 8. Class Prep (Wed/Thu only)
If day is Wednesday or Thursday:
- Check `~/Documents/NotePlan-Notes/Notes/20 - Areas/gnostic-teaching/upcoming-lectures/`
- If no notes for tonight's class, add `task_add(title: "Prepare Gnostic class notes", emoji: "📚", source: "briefing")` and mention it in ACTIONS.

## Output Format

Single Telegram message (via `[NOTIFY]...[/NOTIFY]`):

```
☀️ MORNING BRIEF — {Day}, {Date}

📅 CALENDAR
  Today:
    {HH:MM} — {event title}
    ...
  Upcoming (next 7 days):
    {date} — {event}

🌤️ TODAY'S WEATHER
  {high}°/{low}° {conditions} — precip {N}%
  [Rain hourly, if any bucket ≥ 40% or ≥ 0.5mm:]
  Hourly: 8am ☀ 0% · 11am ☁ 10% · 2pm 🌧 70% · 5pm 🌧 80% · 8pm ⛅ 20%

💰 BILLS & PAYMENTS
  Reminders with PAID/SKIP buttons sent separately.
  In-brief summary line: "3 bills in 5-day window — see reminder messages above/below"
  (Or "No bills in the next 5 business days" if empty.)

📧 IMPORTANT EMAILS
  {Sender} — {subject}
  ... (max 3)

📥 TIER-1 INFO  (queued={N} for tomorrow)
  1. {title} — {source}
  2. ...
  3. ...

⚡ ACTIONS NEEDED TODAY
  • {action 1}
  • {action 2}
  (Each is a NotePlan task on today's calendar note.)

📈 MARKETS & NEWS
  {1-2 line overnight news summary}
  Today: CPI 8:30 ET · Fed speaker 2pm ET
  [Only if positions flagged HIGH:] ⚠️ Position alert: {ticker} ...

🗓️ WEEK AHEAD — WEATHER
  Mon ☀ 18°/9° · 0%
  Tue ⛅ 16°/8° · 20%
  Wed 🌧 12°/6° · 80%
  ... (all 7 days)
```

Emoji key for weather: clear→☀, partly→⛅, overcast→☁, rain→🌧, snow→🌨, thunder→⛈.

## Task & Reminder Guarantees

Every action item this brief produces MUST result in a callable artifact:

- **Bills within 5 biz days** → `create_reminder(type: "bill", source_id: ...)` + `task_add(emoji: "💰", source: "bill")` on today's calendar note.
- **Bills beyond 5 biz days** → `task_add` with `defer` set to remind_date + `job_create type=once` for remind_date at 08:00.
- **Tier-1 overflow** → `task_add` with `emoji: "🔄"`, `source: "queued"`, `defer: tomorrow`.
- **Calendar-driven prep items** (e.g. "prep for 2pm meeting") → `task_add` on today's note + optional `job_create type=once` for a time-based Telegram nudge if the user has a specific time.
- **Anything in ACTIONS NEEDED TODAY** → `task_add` on today's note (check `task_list` first; dedupe by title).

## Rules

- If a data source fails, skip it gracefully — never block the whole brief.
- Always call `date` first for today's actual date. Don't guess.
- Wrap the full brief in `[NOTIFY]...[/NOTIFY]` markers so the executor sends it via Telegram.
- Archive the brief as markdown to `~/Documents/NotePlan-Notes/Notes/60 - Briefings/YYYY-MM-DD-morning-brief.md`.
- Bin reminder (garbage): only on Monday evenings (even ISO week = Black + Green, odd week = Black only). Add to ACTIONS if today is Monday.
- Sarunas payments: always note which account (Argentina, Euro, or other) from the email context.
- De-dupe tasks: `task_list` before `task_add`.
- De-dupe reminders: check `reminder_list` (or dedupe by `source_id` you'd use) before `create_reminder`.
- Mark completed items via `task_complete` when the user confirms.
- Keep total message under 2500 chars. If necessary, trim calendar "Upcoming" to the next 3 items.
