# WN-E5-T02: loopback-only `POST /api/notify` for the fleet phone digest

PsiBot now has one send-only endpoint that command-center's `telegramNotify` adapter (WN-E5-T03) can call. It sends one HTML DM to David per call. It has no reply verbs. The contract comes from command-center's `research/redesign-2026-10/program/wave-0-now.md` §N.5.

## Contract as built

```
POST http://127.0.0.1:3141/api/notify
Authorization: Bearer <contents of data/notify-token>
{ "title": "≤80", "text": "≤3,500", "links": [{ "label": "≤60", "url": "http://100.110.54.112:4890/…" }] }  // ≤8 links
→ 200 { "ok": true, "messageId": n }
→ 403 peer not loopback · 401 bad token · 400 bad body · 422 link off origin · 429 seventh send today (Ottawa) · 502 Telegram refused
```

The route runs its checks in this order: 403, 401, 400, 422, 429, then the send.

## Where things live

- `src/web/routes/notify.ts` holds the route, the token bootstrap (`ensureNotifyToken`), the HTML renderer and the daily cap.
- `src/web/index.ts` mounts the route only when `deps.notify` is passed, so existing tests and other `createWebApp` callers see no change.
- `src/index.ts` writes the token at boot and wires `send` to `sendTelegramDm(bot, ALLOWED_TELEGRAM_USER_IDS, html, { parseMode: "HTML", source: "fleet-digest" })`.
- `src/shared/ops-alerts.ts` adds `sendTelegramDm`, the one DM loop. It returns the first message id. `telegramDmSender` is now a thin wrapper around it with the same plain-text behaviour as before. It also adds `DmBot`, a narrow interface that a real grammy `Bot` satisfies, so the tests need no cast.
- `src/shared/types.ts` adds the `"fleet-digest"` `SentMessageSource`, so `sent_messages` records where each digest came from.

## Decisions the spec left open

- **Token path:** `data/notify-token`, next to `DB_PATH` (`./data/app.db`). It holds 64 hex characters (32 random bytes), so `$(cat data/notify-token)` works in a curl header. The route reads the file on every request, so deleting the file makes every call get 401 until the next boot writes a new one. This is the rollback lever named in the spec's risk table. `data/` is already gitignored.
- **What counts as loopback:** the socket peer must be loopback (`clientIp`, same code as the dashboard allowlist). The request must also carry none of `X-Forwarded-For`, `Forwarded` or `Tailscale-User-Login`. A tailnet client that `tailscale serve` proxies arrives on a loopback socket, so the header check is what refuses it. The dashboard allowlist still runs first, so a LAN peer gets 403 before the route sees it.
- **Link origin:** the route compares `new URL(url).origin` exactly against `http://100.110.54.112:4890`. Https, other ports, `user@host` tricks and `javascript:` all get 422. The loopback origin `http://127.0.0.1:4890` is also refused. So if command-center's `config/links.json` host is empty, T03's digest links fall back to loopback and PsiBot refuses them. T03 must set the host before it sends.
- **Daily cap:** one `ops_state` row, `notify:daily = {"day":"YYYY-MM-DD","count":n}`, with the day taken in `America/Toronto`. The route claims a slot before the send, with no `await` between the read and the write. If Telegram refuses the send, the route releases the slot and returns 502.
- **Length limits:** labels are capped at 60 characters, a cap the spec did not set. With it, a full message (80 + 3,500 + 8 × 61 visible characters) stays under Telegram's 4,096-character limit.
- **Malformed body:** the route returns 400. The spec named only 422, and only for links.

## Verification

- `TELEGRAM_BOT_TOKEN=test ALLOWED_TELEGRAM_USER_IDS=111 bun test src/web/routes/notify.test.ts`: 14 pass. The tests go through the real `createWebApp`, its allowlist middleware and the real `sendTelegramDm`, with only `bot.api.sendMessage` faked. One block runs over a real `Bun.serve` loopback socket.
- `src/web` plus the scheduler suites that import ops-alerts: 59 pass, 0 fail.
- Five mutants were each killed: the loopback guard removed, the cap off by one, the token check bypassed, the origin check loosened to `startsWith`, and text escaping removed.
- `bun run tsc --noEmit` reports 20 errors before and 20 after the change, none in touched code. All 20 come from `src/index.ts` importing seven modules (`maintenance/*`, `assets/*`) that are not committed at HEAD `c91ea59`. The main checkout presumably has them as untracked files. This is not verified.
- Live (`curl` to `:3141/api/notify`, then `safe-restart psibot`): **not verified**. The step needs the branch landed and PsiBot restarted, and this session was not allowed to restart PsiBot or send a real message.

## The worktree needs a `.env` to run tests

The worktree has no `.env`, because it is gitignored. The tests pass with the two fake environment variables shown above.
