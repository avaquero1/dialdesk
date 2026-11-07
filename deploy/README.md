# Deploy

| File | What it is |
|---|---|
| `compose.dev.yml` | Dev infrastructure (Compose project `vha-dev`): Postgres 17, Valkey 8.1 and a Caddy server for `fixtures/site`. Ports bind to 127.0.0.1 only; images are pinned by tag and digest. The TypeScript services run natively with `tsx`, and sandbox-manager with `cargo`. |
| `db-init.sql` | One login role (`svc_<name>`) and one schema per data-storing service: accounts, board, agent, runner, markets, connections, models, audit. Passwords come from `DB_PASSWORD_<NAME>` through psql's `\getenv`. Safe to run again (that also rotates passwords). Runs as the container's init script and on managed Postgres with `psql -v ON_ERROR_STOP=1 -f deploy/db-init.sql`. |
| `fixtures.Caddyfile` | Static file server for `fixtures/site` (no directory listings). |
| `Caddyfile` | The control VM's only public listener: TCP 443 (no port 80, no HTTP/3, no admin API; the certificate comes over TLS-ALPN-01). Serves the web app from `/srv/web`, sends `/api/*` (bodies capped at 64 KB) and `/live` to `edge:8080`, and sets a CSP with no inline scripts. `caddy adapt --validate` passes; `services/edge/test/caddy.test.ts` guards its promises. |
| `nftables/sandbox.nft` | The sandbox machine's firewall, applied by `sandbox-host/setup.sh` with a timed rollback. |
| `nftables/control.nft` | Stub firewall rules for the control VM, **not applied**. The deploy tests and enables them. |
| `sandbox-host/` | The sandbox machine in one script: `push.sh` (from a dev PC), `setup.sh`, `smoke.sh`, `run-containment.sh` (`make containment`). See its README. |
| `compose.control.yml`, `compose.sandbox.yml` | Phase 3 stubs: which containers run on which VM. Only `config` is expected to pass. |

## Dev infrastructure

`compose.dev.yml` needs these variables (put them in the repo's `.env`, which is gitignored):

```
PG_SUPERUSER_PASSWORD
DB_PASSWORD_ACCOUNTS  DB_PASSWORD_BOARD  DB_PASSWORD_AGENT    DB_PASSWORD_RUNNER
DB_PASSWORD_MARKETS   DB_PASSWORD_CONNECTIONS  DB_PASSWORD_MODELS  DB_PASSWORD_AUDIT
VALKEY_HEALTH_PASSWORD
```

It also needs `deploy/.dev/valkey-users.acl` (gitignored, made by the setup script). It must start with
`user default off`, hold `user health on >$VALKEY_HEALTH_PASSWORD -@all +ping` and be readable by the container
(mode 644).

```sh
docker compose -f deploy/compose.dev.yml --env-file .env up -d --wait
docker compose -f deploy/compose.dev.yml down -v      # -v also deletes the database volume
```

| Service | Address | Notes |
|---|---|---|
| postgres | `127.0.0.1:55432`, database `app` | each service logs in as `svc_<name>` and sees only its own schema |
| valkey | `127.0.0.1:56379` | no default user; users come from the ACL file |
| fixtures | `http://127.0.0.1:8300/<domain>/<path>` | for example `/fanpost.fixture.test/nfl/chiefs-bills-insider.html` |

`db-init.sql` runs only when the database volume is new. After you change it, run `down -v` and `up` again, or run it by
hand inside the container: `docker compose -f deploy/compose.dev.yml exec postgres psql -U postgres -d app -f /docker-entrypoint-initdb.d/10-init.sql`.
