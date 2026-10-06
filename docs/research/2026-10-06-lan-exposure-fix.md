# PsiBot LAN exposure fix (2026-10-06)

PsiBot now listens on `127.0.0.1:3141` only and takes the client IP from the TCP socket, so
LAN devices can no longer reach the dashboard, `/api/chat`, job controls, or `/tma/api/*`.
Tailnet access through `tailscale serve`, including the Telegram Mini App, works as before.
David approved the change, and it's committed in both repos.

## What changed

PsiBot repo:

- `src/web/client-ip.ts` (new): `clientIp(c)` reads the socket peer through Hono's
  `getConnInfo`. It trusts `X-Forwarded-For` only when the peer is loopback, takes the
  rightmost non-loopback hop, never reads `X-Real-IP`, and returns `null` (never
  `127.0.0.1`) when the peer is unknown. `ipAllowlisted()` rejects `null`.
- `src/web/index.ts`: the dashboard allowlist uses the shared helpers. This also closes a
  latent hole where an empty `TAILSCALE_IP_PREFIX` allowed every IP (`startsWith("")`).
- `src/web/middleware/telegram-auth.ts`: the Mini App API's IP fallback uses the same
  helpers; the header-based `requestIp()` is gone.
- `src/telegram/webhook.ts`: same IP fix, plus `hostname: "127.0.0.1"` in place of a
  hard-coded `0.0.0.0`. Webhook mode is off (`TELEGRAM_WEBHOOK_ENABLED=false`), so this
  has no runtime effect today.
- `src/config.ts`: the `HOST` default changes from `0.0.0.0` to `127.0.0.1`.
- `src/web/ip-allowlist.test.ts` (new): 9 tests.
- `.env`: `HOST=0.0.0.0` → `HOST=127.0.0.1`. `.env` is gitignored, so this change does not
  show in `git diff`.

command-center repo:

- `apps/casl-outreach-pack/listing/serve.ts`: adds `hostname: "127.0.0.1"`. The running
  instance (pid 51553, hand-started 2026-10-05 20:54) still listens on `*:4177` until
  someone restarts it. Its suite, `apps/casl-outreach-pack/listing.test.ts`, passes 20/20.

The working tree's `src/web/index.ts` also holds two uncommitted `createAssetRoutes` lines
from separate assets work. The commit leaves them out.

## Verification

`bun test src/web/ip-allowlist.test.ts` passes 9/9. Against a scratch copy of the tree with
only this change reverted, the same file fails 5 tests (exactly the bug cases) and passes 4
(the paths that must stay allowed).

After `bun ~/Code/command-center/scripts/safe-restart.ts psibot` (new pid 48532), `lsof`
shows a single listener, `127.0.0.1:3141`. The boot line reads
`Web server listening on http://127.0.0.1:3141`, the bot restarted in polling mode, and
the daemon logged no blocked requests.

| Request | Before | After |
| --- | --- | --- |
| LAN IP `192.168.1.81:3141` `/chat` and `/tma/api/logs`, no headers or a forged `X-Forwarded-For: 127.0.0.1` | 200 | connection refused |
| Same LAN URLs from `david-imac`, a real LAN peer (`192.168.1.99`) | not measured | connection refused |
| Tailnet URL `/chat`, `/tma/review`, `/tma/api/logs`, from this Mac (IPv4 and IPv6) and from `vol-newmac` | 200 | 200 |
| Raw tailnet IP `http://100.110.54.112:3141/chat` | 200 | connection refused (see the trade-off below) |
| `127.0.0.1:3141` and `localhost:3141` | 200 | 200 |

## What was checked so it wouldn't break

- **Telegram Mini App.** Telegram requires HTTPS, so the menu button and every link PsiBot
  generates use `https://davids-macbook-pro.tailb4cc40.ts.net/tma…`, which `tailscale serve`
  proxies to `localhost:3141`. Page and API both return 200 from two tailnet machines.
  initData auth reads a header and is unchanged.
- **vaultd approvals.** None go through PsiBot. VaultApprove (the Touch ID menubar app)
  talks to vaultd over a local socket. The passkey approver is its own server
  (`127.0.0.1:3142`, tailnet `:8444`), and remote approval would use `:8445`. vaultd's code
  never references PsiBot, Telegram, or `:3141`.
- **YouTube OAuth callback.** `/auth/youtube/callback` now serves a static "moved to the
  OAuth vault" page. The vault handles Google consent itself, and PsiBot only calls the
  vault outbound.
- **Telegram updates.** Webhook mode is off; the bot long-polls, which is outbound only.
- **Other callers of `:3141`.** Every reference in `~/Documents/2_Code`, `~/Code`,
  `~/.config`, skills, and LaunchAgents uses `127.0.0.1`, `localhost`, or `0.0.0.0` (the
  last is a safe-restart log fixture). A probe showed all three reach a loopback-only bind.
  The command-center gateway links to `http://127.0.0.1:3141/tma` and reads PsiBot's
  database directly.
- **Watchdog and restart tooling.** `~/.psibot/scripts/ensure-tailscale-serve.sh` only
  re-applies `serve → localhost:3141`. safe-restart's boot-line regex doesn't depend on the
  host part.

## How `tailscale serve` forwards requests (measured)

A header echo ran for 45 seconds on the idle `127.0.0.1:5179` backend that serve's `:8443`
route already points at, so the serve config never changed. Results:

- The socket peer is always `127.0.0.1`.
- Serve replaces `X-Forwarded-For` with the client's IPv4 tailnet address, even when the
  client connects over IPv6, and drops any value the client sent.
- Serve passes a client's `X-Real-IP` through untouched, so the new code never reads it.

This matches tailscale's source: `addProxyForwardedHeaders` in `ipn/ipnlocal/serve.go` uses
`Header.Set` inside a `Rewrite`-based reverse proxy.

## Trade-off

`http://100.110.54.112:3141/…` no longer answers. `~/Documents/2_Code/2026/TAILSCALE-PHONE-LINKS.md`
tells agents to prefer raw-IP links for the phone, because the phone's MagicDNS can break.
No PsiBot code or config generates such links, but a phone bookmark in that form is now
dead; the HTTPS tailnet URL is the only tailnet path. That doc now lists PsiBot among the
loopback-only services. If raw-IP access matters, add a second listener on
`100.110.54.112` (the command-center gateway does this on `:4890`) rather than going back
to `0.0.0.0`.

## Unrelated issues seen along the way

- `src/web/routes/assets.test.ts` fails 1 test (a ranking expectation) in the uncommitted
  assets work. That test mounts its routes on a bare app, so the allowlist never runs.
- `bun run tsc --noEmit` reports 12 errors, none in the files listed above.
- Each boot logs `[memory] Failed to index file USER.md` with `EPERM`; the 07:40 boot did
  too. This is macOS privacy protection (TCC) on the NotePlan symlink.

## Remaining step

Restart the CASL listing (pid 51553) so it binds `127.0.0.1:4177`.
