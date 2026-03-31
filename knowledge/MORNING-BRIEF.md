# Morning Brief Instructions

Generate and deliver a concise morning intelligence briefing via Telegram.

## Data Sources (fetch in parallel)

### 1. Market Data
Fetch from trading-bot API at `http://localhost:8000`:
- `GET /api/v1/briefings/today` — Full market briefing (watchlist movers, sector rotation)
- `GET /api/v1/calendar/upcoming?days=1&impact=high` — Today's high-impact economic events
- `GET /api/v1/sentiment/trending?limit=5` — Top trending tickers

If the trading-bot is unreachable, note "Market data unavailable" and continue.

### 2. Calendar
Query Apple Calendar directly via the SQLite database:
```bash
bun run ~/Documents/2_Code/2025-08-01-apple-calendar-query/src/calendar-sqlite.ts
```
This outputs upcoming events as JSON to stdout. Parse and include today's events with times.

### 3. Inbox Highlights
Use the `inbox_list` tool to check pending captured items. Report:
- Count of pending items
- Top 3 items by most recent capture
- Any items from high-priority platforms (github, reddit tech subs)

### 3b. Research & YouTube Rollup
Check for recently completed research and YouTube saves since the last brief:
- Use `inbox_list` with status "archived" to find items with auto_decision containing "research_done"
- List titles of research notes completed in the last 24h (just titles, NOT the content)
- Check `~/Documents/NotePlan-Notes/Notes/70 - Research/` for any notes modified in the last 24h
- Mention high-relevance items that the user should review in NotePlan

### 4. Gmail (Bills & Urgent)
Use Gmail MCP tools (gmail_search_messages, gmail_read_message) to check for:
- Bills due within 7 days (search: "subject:(invoice OR bill OR payment due OR subscription) newer_than:7d")
- Urgent emails from known contacts

If Gmail MCP is unavailable, note "Gmail unavailable" and continue.

### 5. Class Prep (Wed/Thu only)
On Wednesdays and Thursdays, check if Gnostic class prep is needed:
- Read `~/Documents/NotePlan-Notes/Notes/20 - Areas/gnostic-teaching/upcoming-lectures/`
- Flag if no notes exist for tonight's class

## Output Format

Format as a clean Telegram message (plain text with emoji section headers):

```
☀️ MORNING BRIEF - [Day], [Date]

📈 MARKETS
[2-3 line market summary]
[Key economic events today]

📅 TODAY
[Calendar events with times]
[Bills due if any]
[Class prep status if Wed/Thu]

📥 INBOX ([count] pending)
[Top 3 recent captures, one line each]

🔬 RESEARCH ([count] completed since last brief)
[Titles of recently completed research notes — just titles]
[Flag any high-relevance items worth reviewing in NotePlan]

✅ TASKS
[Open tasks from today's NotePlan calendar note]

⚡ ACTIONS NEEDED
[Only items requiring immediate attention]
```

Keep it scannable — bullet points, short lines. Total message under 2000 chars.

## Task Management

After generating the brief, use `task_add` to add any new actionable items to today's NotePlan calendar note. Use `task_list` to show existing tasks. Read knowledge/TASKS.md for the emoji and format standards.

When the brief surfaces a new action item (bill due, meeting prep, etc.), add it as a task with the appropriate emoji and source tag. Do NOT add tasks that already exist.

## Rules
- If a data source fails, skip it gracefully — never block the whole brief
- CRITICAL: Use the `date` command to get today's actual date and day of week — do NOT guess or assume
- Include [NOTIFY] markers around the full brief so it gets sent to Telegram
- Archive the brief to `~/Documents/NotePlan-Notes/Notes/60 - Briefings/` as `YYYY-MM-DD-morning-brief.md`
- Bin reminder: only on Monday evenings (even week = Black + Green, odd week = Black only). Check the actual day.
- For Sarunas payments: always note which account (Argentina, Euro, or other) from the email context
- Check task_list before adding new tasks — do NOT duplicate
- Mark completed items with task_complete when user confirms
