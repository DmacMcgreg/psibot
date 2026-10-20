# PsiBot quiet mode (2026-10-20)

David asked for PsiBot to stop being noisy and keep only YouTube video processing. Everything below was disabled, not deleted. Backups: `data/app.db.bak-2026-10-20-quiet` and `.env.bak-2026-10-20-quiet`.

## Still running

- YouTube watchlist processing, now scheduled by command-center (`apps/youtube-watchlist`, LaunchAgent `com.dmac.youtube-watchlist`). It runs this repo's `scripts/youtube-watchlist.ts` every 3 hours. Job 12 is disabled (see below).
- Telegram chat (polling), the web dashboard and the Mini App.
- Silent hygiene runners: log rotation, Google (YouTube) token check, published-date sweep. None of them post to Telegram unless something breaks.

## Scheduled jobs disabled (were `enabled`)

| ID | Job | Schedule |
|---|---|---|
| 12 | YouTube Watchlist Processor (moved to command-center) | every 3h |
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
| `NOTEPLAN_SWEEP_ENABLED=false` | weekly NotePlan archive sweep (ingest into `noteplan_archive`, then prune files on disk) |

`BACKGROUND_PIPELINES_ENABLED` and `NOTEPLAN_SWEEP_ENABLED` are new flags added in `src/index.ts` / `src/config.ts` on this date.

## Undo everything

To give YouTube back to PsiBot, first stop command-center's copy (`launchctl bootout gui/$(id -u)/com.dmac.youtube-watchlist`), then re-enable job 12 with `UPDATE jobs SET status='enabled' WHERE id=12;`. Never run both: they race on the same playlist.

To restore the other jobs and runners:

```bash
cd ~/Documents/2_Code/2026/telegram-claude-code
sqlite3 data/app.db "UPDATE jobs SET status='enabled' WHERE id IN (26,31,32,34,62,66,70);"
sed -i '' '/^# Quiet mode (2026-10-20)/,/^NOTEPLAN_SWEEP_ENABLED=false$/d' .env
psibot restart
```

To undo one piece, re-enable that job ID or delete that one line from `.env`, then `psibot restart`.
