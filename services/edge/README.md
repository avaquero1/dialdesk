# edge and accounts: the door

edge is the only service behind caddy. accounts signs people in. Together they make the session.

## Sessions

- **Passwords:** argon2id from `node:crypto` (46 MiB, 1 pass, 1 lane: OWASP's first setting), stored as PHC strings.
  Emails are compared lower-case. An unknown email costs the same argon2 time as a wrong password, and both answer the
  same 401. Ten failed logins for one email in 15 minutes answer 429.
- **Tokens:** Ed25519 JWTs (`alg: EdDSA`). accounts holds the private key in a file only it reads
  (`ACCOUNTS_SESSION_KEY_FILE`, mode 600, or it refuses to start). edge holds only the public key
  (`EDGE_SESSION_PUBLIC_KEYS`; two during a rotation, told apart by `kid`). edge accepts exactly the header
  `{alg, typ, kid}` and the claims in `SessionClaims` (strict). Anything else is a 401: `alg: none`, another algorithm,
  an unknown key, a changed claim, an extra field, an expired token.
- **Revocation:** every session has a row. Logout revokes it. edge asks accounts whether a session is still valid and
  caches a yes for 15 s and a no until the token expires. A logout through edge takes effect on that edge at once and
  closes the session's `/live` sockets.
- **The cookie:** `app_session`, `HttpOnly; Secure; SameSite=Strict; Path=/`, living as long as the session (7 days, 1
  day for a guest).
- **Guests ("Try it"):** no email, no password. They're deleted nightly at 08:00 UTC (3 AM in New York): every guest
  older than an hour, with its sessions. accounts also caps new guests per hour.
- **The look:** `{theme, mode, hue}`, checked against `Look` by the template, again by accounts, and by a database check.
  A change emits `look.changed`.

## Every request through edge

1. A body over 64 KiB is refused (413) before it's read. caddy caps it too.
2. A state-changing call (anything but GET, HEAD, OPTIONS) needs an `Origin` that exactly matches
   `EDGE_ALLOWED_ORIGINS`, and no `Sec-Fetch-Site: cross-site` (403). This is the second CSRF layer after SameSite=Strict.
3. Rate limits (token buckets, in memory): per address on every call, per account on every signed-in call, and tighter
   ones on sign-up, login, guest, chat and refresh. A refusal is 429 with `Retry-After`. Behind caddy
   (`EDGE_TRUST_PROXY=1`), the address is the last `X-Forwarded-For` entry, which caddy writes.
4. Browser routes need a valid session. The account id always comes from the session, never from the browser.
5. Responses are `Cache-Control: no-store`.

The connect route (`POST /api/connections`) is opaque: edge never reads, logs or echoes the body (its private key is
sealed to connections in the browser). It only sets `account_id` from the session, last, so a browser can't name another
account. connections checks the rest.

## /live

A WebSocket on the same port. The handshake is refused unless the path is `/live`, the `Origin` is one of
`EDGE_ALLOWED_ORIGINS` (403; a missing Origin is refused too), and the session cookie is valid (401). An account gets at
most 5 sockets (429). A socket carries only its own account's events (`BrowserEvent` frames), takes no input (a frame
over 1 KiB closes it), closes with 4001 when the session expires, is revoked or logs out, and is dropped when it falls
1 MiB behind. Events are hints: the browser refetches on reconnect.

edge listens to every event on Valkey (`ValkeyBus.subscribe('all')`, as `svc-edge`, which may only PSUBSCRIBE `events.*`)
and fans each one out to the sockets of the account it names. In tests the same fan-out (`LocalBus`) is fed in process.

## Tests

- `services/accounts/test/real.test.ts` and `services/edge/test/real.test.ts`: the contract cases on the real
  handlers, then the security checks above, with `/live` over a real socket. Part of `make check`.
- `services/accounts/test/pg.test.ts`: the same on Postgres, with the migration and its checks. It runs when
  `ACCOUNTS_TEST_DATABASE_URL` is set (for example `svc_accounts` on a throwaway Compose Postgres).
- `services/edge/test/caddy.test.ts`: the Caddyfile's promises.
