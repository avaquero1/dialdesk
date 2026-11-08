# Deploy

| File | What it is |
|---|---|
| `compose.dev.yml` | Dev infrastructure (Compose project `vha-dev`): Postgres 17, Valkey 8.1 and a Caddy server for `fixtures/site`. Ports bind to 127.0.0.1 only; images are pinned by tag and digest. The TypeScript services run natively with `tsx`, and sandbox-manager with `cargo`. |
| `db-init.sql` | One login role (`svc_<name>`) and one schema per data-storing service: accounts, board, agent, runner, markets, connections, models, audit. Passwords come from `DB_PASSWORD_<NAME>` through psql's `\getenv`. Safe to run again (that also rotates passwords). Runs as the container's init script and on managed Postgres with `psql -v ON_ERROR_STOP=1 -f deploy/db-init.sql`. |
| `fixtures.Caddyfile` | Static file server for `fixtures/site` (no directory listings). |
| `Caddyfile` | The control VM's only public listener: TCP 443 (no port 80, no HTTP/3, no admin API; the certificate comes over TLS-ALPN-01). Serves the web app from `/srv/web`, sends `/api/*` (bodies capped at 64 KB) and `/live` to `edge:8080`, and sets a CSP with no inline scripts. `caddy adapt --validate` passes; `services/edge/test/caddy.test.ts` guards its promises. |
| `nftables/sandbox.nft` | The sandbox machine's firewall, applied by `sandbox-host/setup.sh` with a timed rollback. |
| `nftables/control.nft` | control's firewall. Addresses come from an included `control-vars.nft` (example: `example-control-vars.nft`); `make nft-check` checks both tables and the egress refill in a private namespace. Installed by `scripts/deploy.sh` as `vha-nft.service`. |
| `nftables/egress-*.nft`, `egress-refresh.sh`, `vha-egress-refresh.*` | control's egress mode (log-only or enforce) and the timer that refills each container's allow set from `egress-hosts.ts`. |
| `sandbox-host/` | The sandbox machine in one script: `push.sh` (from a dev PC), `setup.sh`, `smoke.sh`, `run-containment.sh` (`make containment`). See its README. `scripts/deploy.sh sandbox` runs it for the deploy. |
| `compose.control.yml` | control's containers, with their uids, networks and secret files. |
| `compose.sandbox.yml` | Not used by any script: the sandbox machine runs the proxy and the manager under systemd (`sandbox-host/`). |
| `prod-secrets.ts`, `s3-bucket.ts`, `egress-hosts.ts` | Run on control in the app image by `scripts/deploy.sh`: the secret files, the two buckets, the egress table. |
| `scripts/deploy.sh` | Deploys control and the sandbox machine (below). `--dry-run` prints every step and changes nothing; `tests/deploy/deploy-script.test.ts` and `make deploy-dry-run` run it. |
| `deploy.env.example` | control's settings, copied to `/etc/vha/deploy.env` on control. `deploy/deploy.env` is gitignored. |
| `PROVISION.md` | The Vultr resources to create, in order, with their settings and prices. |

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

## Deploying control

Once the resources in `PROVISION.md` exist, control has Docker, `/etc/vha/deploy.env` is filled in (from
`deploy.env.example`) and the key files are in `/etc/vha/inputs/`:

```sh
deploy/scripts/deploy.sh --dry-run --env-file deploy/deploy.env.example   # anywhere: the whole deploy, printed
VHA_CONTROL_HOST=root@<control> VHA_SSH_KEY=<key file> deploy/scripts/deploy.sh push
```

`push` copies `HEAD` to `/opt/vha/src/<rev>` on control (a git archive over ssh; nothing is pushed anywhere) and runs
`deploy.sh control` there: checks, the images (built on control), the firewall, the egress table and its timer, the
buckets, the secrets, `db-init.sql` over TLS, `docker compose up --wait`, and the health checks.

- **The firewall** loads with a timed rollback (`--rollback-seconds`, 300). deploy.sh waits until `vha-nft-confirm`
  runs from a NEW ssh connection (push does that by itself); without it, the old table comes back and ufw goes back on.
  An unchanged, confirmed table isn't reloaded.
- **Egress starts log-only.** Read `journalctl -k | grep vha-egress-would-drop` on control, add what's missing to
  `egress-hosts.ts`, then deploy again with `--enforce-egress` (`--log-only-egress` goes back).
- **The sandbox machine** comes after: `VHA_CONTROL_HOST=… VHA_SANDBOX_HOST=root@<its VPC address> VHA_SSH_KEY=…
  deploy/scripts/deploy.sh sandbox` copies runner's token hash (`/etc/vha/secrets/sandbox-manager/env`) to
  `/etc/vha/sandbox-manager.env` there, through control, and then runs the sandbox machine's own setup.
