# PsiBot quiet mode (2026-10-20)

David asked for PsiBot to stop being noisy and keep only YouTube video processing. Everything below was disabled, not deleted. Backups: `data/app.db.bak-2026-10-20-quiet` and `.env.bak-2026-10-20-quiet`.

## Still running

- Job 12 **YouTube Watchlist Processor** (every 3 hours).
- Telegram chat (polling), the web dashboard and the Mini App.
- Silent hygiene runners: log rotation, Google (YouTube) token check, NotePlan archive sweep, published-date sweep. None of them post to Telegram unless something breaks.

## Scheduled jobs disabled (were `enabled`)

| ID | Job | Schedule |
|---|---|---|
| 26 | Weekly Bin Reminder | Sun 18:00 |
| 31 | Morning Brief | daily 06:30 |
| 32 | Reddit Saved Poller | every 4h |
| 34 | GitHub Stars Poller | every 4h |
| 62 | Nightly Brief | daily 23:00 |
| 66 | Weekly Maintenance | Mon 04:00 |
| 70 | Daily Claude-Mem Digest | daily 22:00 |

## In-process runners turned off (`.env`, all previously at their default `true`)

| Variable | Turns off |
|---|---|
| `HEARTBEAT_ENABLED=false` | 30-minute heartbeat, News digest, fleet proposal cards, inbox watcher |
| `DISCOVERY_ENABLED=false` | YouTube RSS discovery and its news digest (not your watchlist) |
| `ASSET_DIGEST_ENABLED=false` | daily "Act on these" card and deadline alerts |
| `BACKGROUND_PIPELINES_ENABLED=false` | Atlas weekly/monthly synthesis, weekly digest, skill forge, asset feeds (tenders, funding, HN, Kaggle…), asset extraction from videos/tabs/stars |

`BACKGROUND_PIPELINES_ENABLED` is a new flag added in `src/index.ts` / `src/config.ts` on this date.

## Undo everything

```bash
cd ~/Documents/2_Code/2026/telegram-claude-code
sqlite3 data/app.db "UPDATE jobs SET status='enabled' WHERE id IN (26,31,32,34,62,66,70);"
sed -i '' '/^# Quiet mode (2026-10-20)/,/^BACKGROUND_PIPELINES_ENABLED=false$/d' .env
psibot restart
```

To undo one piece, re-enable that job ID or delete that one line from `.env`, then `psibot restart`.
