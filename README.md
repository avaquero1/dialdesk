# vultr-hackathon-app (name to come)

A friend who does the research for your prediction-market trading: a chat agent builds your board of widgets, and
each widget's sub-agent reads the news in a throwaway sandbox and runs the math in fixed Rust code.
Every number on the board comes from code and carries a receipt. It informs; it never trades and never gives advice.

Built for the Vultr hackathon's Blast Radius Zero challenge: every web read and every calculation runs in a sandbox on
its own Vultr machine, behind an egress proxy, and is thrown away after the job.

> Status: **Phase 0, the shared backbone.** Contracts v0 (tag `contracts-v0`), the service template, an in-memory fake
> per service, fixtures, the gate and the end-to-end test on fakes. The real services are built from here.

## Layout

| Path | What |
|---|---|
| `services/<name>` | The 9 TypeScript services: edge, accounts, board, agent, runner, markets, connections, models, audit |
| `packages/contracts` | Every schema and API (zod v4), the catalogs, the bus names. **The contract** |
| `packages/service-kit` | The service template: health, config, logs, token check, contract-checked routes and client, migrations |
| `packages/guard` | The guard (a library inside agent and runner) |
| `packages/testkit` | Fixture readers, the contract-test harness, sample results |
| `packages/design-kit` | The board and the glass themes (after the mockup review) |
| `engine/` | The Rust math engine: a stdin/stdout CLI with receipts. `engine --schema` |
| `sandbox/` | Rust: `sandbox-manager` (the `Backend` trait; `docker` backend stub) and `egress-proxy` |
| `fixtures/` | A static site with clean and poisoned pages; made-up Kalshi and Polymarket JSON |
| `deploy/` | Dev Compose (Postgres, Valkey 8.1, fixtures), `db-init.sql`, Caddyfile and nftables stubs |
| `tests/`, `e2e/` | The contract gate; the end-to-end test on fakes |

## Setup

You need Node 26 (through [mise](https://mise.jdx.dev): `mise install` reads `mise.toml`), a stable Rust toolchain
(`rustup`, with clippy and rustfmt), and Docker with Compose.

```sh
mise install            # Node 26
npm ci                  # every workspace, from the lockfile
make dev-secrets        # writes .env and deploy/.dev/valkey-users.acl (both gitignored)
make check              # the gate: rust, generated files, typecheck, lint, contract tests, e2e
```

`.env.example` lists every variable by name. Never commit `.env`. No key goes in this repo.

## Running locally

Infra runs in Compose; the services run natively with `tsx`.

```sh
make infra-up           # Postgres :55432, Valkey :56379, fixtures :8300 (project name vha-dev)
make fakes              # all 9 services as in-memory fakes; prints each /health
make stop-fakes
make infra-down         # removes the containers and volumes
```

One service: `npm run dev -w services/board` (real handlers, watch mode) or `npm run fake -w services/board`.
sandbox-manager: `SANDBOX_MANAGER_CALLERS=runner:<sha256 of RUNNER_TOKEN_SANDBOX_MANAGER> cargo run -p sandbox-manager -- serve`.

Ports: edge 8080, accounts 8101, board 8102, agent 8103, runner 8104, markets 8105, connections 8106, models 8107,
audit 8108, sandbox-manager 8200, egress-proxy 8201, fixtures 8300.

## The contract rule

`packages/contracts` was frozen as **v0** at the tag `contracts-v0`. After v0, a contract changes only through its owner
(named by the project manager): open the change with the owner, who updates the schema, runs `npm run gen`, and lands
it before anyone codes against it. A service never adds a field, a route or an event on its own. The Rust crates own
their schemas (`engine --schema`, `sandbox-manager --schema`); `make gen-check` fails when the generated TypeScript
is stale.

How to build a piece: [HOW-TO-BUILD.md](HOW-TO-BUILD.md).

## License

MIT. See [LICENSE](LICENSE).
