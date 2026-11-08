# DialDesk

**A friend who does the research for your prediction-market trading.**

You tell a chat agent which teams and markets you follow. It builds your board: an interactive feed of widgets, all in
one house style. Each widget has its own sub-agent. The sub-agent reads the news, does the math and keeps the widget
current. Every number on the board comes from code and shows how it was calculated and where its inputs came from.

It is **math, not advice.** It shows implied probability, odds, movement, expected value and base rates. It never says
what to trade, and it never trades. You decide, on your own exchange account.

Built for the Vultr hackathon's **Blast Radius Zero** challenge. The agents read the open web, and the open web can be
hostile. So every web read and every calculation runs in a throwaway sandbox on its own Vultr machine. The sandbox
holds nothing worth stealing, reaches only the sites its job allows, and is destroyed after the job.

## What it does

1. **You sign up and talk to the agent.** It proposes widgets for your teams and markets. Nothing goes on your board
   until you tap it.
2. **Each widget's sub-agent runs on a schedule.** It finds sources, reads them in a sandbox, and runs the math in a
   fixed Rust engine.
3. **The board stays alive.** Prices refresh, movement is flagged, and a "since you last looked" strip shows what changed.
4. **"How we got this"** opens on every number: the calculation, its inputs, their sources and a receipt.
5. **Your accounts, read only.** You can connect Kalshi with a read-only key, or Polymarket with a public wallet
   address. One service holds the keys, encrypted, and it only reads.

Sports come first. Plans (free and paid) are shown in the app, and nobody is billed.

## Containment: how a hostile page is stopped

One widget run, step by step:

```
 runner (the widget's sub-agent)
   |
 0 SOURCES   code, no model: catalog, news feeds, search -> links on allowed sites
 1 PLAN      a model chooses links and math (it never sees page text)
 2 READ      [browse sandbox] on the sandbox machine; its only way out is the proxy
               off-list hosts, the metadata address, DNS: refused and logged    <- layer 1
 3 EXTRACT   a reader model with NO tools -> facts and quotes
               the guard: hidden orders in the page?
                 yes -> the live sandbox is killed; the widget keeps its clean numbers  <- layer 2
                 no  -> the sandbox is released and destroyed
 4 MATH      [compute sandbox] the Rust engine, NO network -> numbers and receipts
 5 SUMMARY   words with blanks; only engine numbers fill them
 6 GUARD     advice words? sources? receipts? secrets? -> blocked if bad
 7 PUBLISH   board -> edge -> your browser, live
```

- **Process isolation.** Sandboxes run on a separate machine under gVisor (`runsc`, systrap). Chromium's own sandbox
  stays on inside it. Each sandbox runs as uid 10001 with every capability dropped, no-new-privileges, a read-only root,
  no Docker socket and no host folders.
- **No secrets inside.** No key, token or password ever enters a sandbox. The proxy knows which job a connection belongs
  to by the sandbox's source address, so a sandbox doesn't even need a token.
- **Limits per sandbox.** Memory 1 GB with no swap, 1 CPU, 256 processes, a time cap, small `noexec` tmpfs mounts and an
  output cap. The model service has per-account caps and a daily spend kill switch.
- **Fresh every time.** One sandbox per job, destroyed after it. The next job finds nothing the last one wrote.
- **Fenced network.** A browse sandbox has one route: the egress proxy. There is no DNS inside. The proxy resolves names
  itself, allows only the job's sites on port 443, refuses IP literals, private ranges and the metadata address, and
  logs every request. A compute sandbox has no network at all.
- **One-way calls.** Control calls the sandbox machine. The sandbox machine never opens a connection back to control,
  the database or anything private.
- **Verifiable.** Screenshots, receipts on every number, and a hash-chained, signed audit log with a public `verify`.
- **A human decides.** The app can't trade, and every board change the agent proposes needs your tap.

### The scoreboard (a real run on Vultr)

`make containment` on the VX1 sandbox machine, gVisor backend, from commit `b56772b`, on 2026-11-08 (UTC):

| Number | Value |
|---|---|
| Containment checks passed | **12 / 12** |
| Backend | gVisor, Chromium's own sandbox on |
| Fork bomb held at | 250 processes (cap 256) |
| Memory hog stopped at | 992 MB (cap 1024 MB; OOM-killed, exit 137) |
| Infinite loop killed after | 4,098 ms (cap 4,000 ms) |
| Direct routes out blocked | 6 of 6 (public IP, public DNS, metadata address, 10/8, 192.168/16, the proxy's other ports); no DNS inside |
| Poisoned page: callouts refused | 4 of 4 (8 requests refused in all) |
| Poisoned page: create to page read | 3,295 ms |
| Kill answered in | 167 ms |
| Kill to `sandbox.destroyed` in the audit log | 168 ms |

The twelve checks: not root; no secret inside; the process cap; the memory cap; the time cap; no route out but the
proxy, and no DNS; a fresh sandbox per job; an off-list host refused and logged; the metadata address refused, by
address and by a name that resolves to it; held until the verdict, then destroyed, and `busy` past the slot cap; the
poisoned page's callouts refused and its sandbox killed and destroyed; compute with no network.

Before gVisor was chosen, a spike on the same machine tried three backends. gVisor and a KVM microVM each passed 16 of
16 checks. Plain runc passed 15 (Chromium's own sandbox can't run under Docker's default seccomp). gVisor was faster
(3.7 s against 4.9 s from create to page read) and used half the host memory per sandbox (308 MB against 646 MB), so it
ships. The microVM backend is not wired into the manager.

The poisoned test page is our own fixture (`fixtures/site`). It hides orders to the agent in the page, and it tries to
call an off-list host and the metadata address.

## Vultr services

| Service | What it does here |
|---|---|
| **Serverless Inference** | Every model call: the chat agent, the planner, the reader, the summarizer and the guard's second layer. Only the `models` service holds the key. |
| **Cloud Compute** (`vc2-4c-8gb`) | The control machine: the web app, nine of the ten services, Valkey and Caddy. |
| **VX1** (`vx1-g-2c-8g`, dedicated CPU) | The sandbox machine: `sandbox-manager`, the egress proxy and the gVisor sandboxes. It holds no keys and no database. |
| **VPC** | The private network between control, the sandbox machine and the database. |
| **Firewall** | Inbound rules for both machines: control takes 443 only, and the sandbox machine takes nothing public. On the sandbox machine, nftables enforces outbound traffic. On control, it logs outbound traffic and does not block it (see "Outbound traffic from control"). |
| **Managed PostgreSQL** | One schema and one login per data-storing service, TLS required, reachable from control's VPC address only. |
| **Object Storage** | Two buckets: screenshots (board) and the signed audit-log heads (audit). The heads bucket uses object lock. |

The Vultr account API key never goes on either machine, and nothing secret goes in cloud-init user-data (the metadata
address would serve it to any process on the VM).

## Architecture

```
            [ your browser ]  (a session cookie only)
                   |  HTTPS 443
                   v
+------------------------------------------------+
| CONTROL  (Cloud Compute)   in: 443   out: list |
|                                                |
| caddy        TLS, the web app's files          |
| edge         session check, routes, live push  |
|  |-> accounts*     sign-up, login, sessions    |
|  |-> board*        widgets, results            |
|  |-> agent         the chat agent              |
|  |-> connections*  your exchange keys, read    |
|  '-> audit*        trust page, verify          |
| agent   -> models, markets, board              |
| board   -> runner (job queue)                  |
| runner  -> markets, models, connections        |
|         ==> sandbox-manager  (one way)         |
| markets* -> Kalshi, Polymarket, news, search   |
| models*  -> Vultr Serverless Inference         |
| every service -> log stream -> audit*          |
| valkey       jobs, events, the log stream      |
+--------+------------------------+--------------+
         |                        ||  VPC, one way
         v                        vv
+-----------------+   +---------------------------+
| Managed         |   | SANDBOX MACHINE (VX1)     |
| PostgreSQL      |   | in: control only          |
| control only,   |   | out: the proxy only       |
| TLS             |   | holds no secrets          |
+-----------------+   |                           |
                      | sandbox-manager           |
Object Storage:       |  [browse]  x  gVisor      |
 screenshots, heads   |  [compute] x  no network  |
                      | egress proxy -> allowed   |
                      |                 sites     |
                      +---------------------------+

*  holds one secret     x  destroyed after every job     ==>  the only link between the machines
```

### The ten services

| # | Service | Language | Job |
|---|---|---|---|
| 1 | edge | TypeScript | The only door behind Caddy: checks the session, routes, rate limits, pushes live events over WebSocket |
| 2 | accounts | TypeScript | Sign-up, login, sessions (Ed25519-signed), the plan and the theme |
| 3 | board | TypeScript | Widgets, layouts, results with their run trace, screenshots; the agent's proposals wait for your tap |
| 4 | agent | TypeScript | The chat agent, with six fixed tools; it never sees raw pages, reader output or a key |
| 5 | runner | TypeScript | Each widget's sub-agent: drives the run's steps and calls the guard |
| 6 | markets | TypeScript | Public Kalshi and Polymarket data, news feeds and search, cached |
| 7 | connections | TypeScript | The vault: users' exchange keys, encrypted; read-only calls |
| 8 | models | TypeScript | Every model call: role to model, metering, caps, the kill switch, a fake mode for tests |
| 9 | audit | TypeScript | The hash-chained, signed log; no row is ever updated or deleted |
| 10 | sandbox-manager | Rust | On the sandbox machine: one sandbox per job, limits, hold and kill, destroy; the egress proxy is its own process |

Also: the **math engine** (Rust, `engine/`), a stdin/stdout CLI with no network that runs in the compute sandbox, and
the **guard** (`packages/guard`), a library inside agent and runner. The guard checks for advice words in code first,
then asks a model as a second layer. It checks chat replies too.

### How they talk

- **HTTP and JSON between services.** Every API, event and job is a zod schema in `packages/contracts`. The Rust
  crates print their own JSON Schema, and the TypeScript types are generated from it.
- **A token per caller.** Each service accepts only the callers that need it.
- **Valkey** carries the job queues (BullMQ), the events and one log stream. Each service has its own Valkey user that
  can reach only its own queues and channels.
- **Postgres:** each data-storing service has its own schema and login. No service reads another's tables.
- **Outbound traffic from control** is logged per container and is not blocked. Each container has a list of the hosts
  it should reach (for example, only `models` should reach Vultr Serverless Inference). A call to a host off the list
  goes to the kernel log and still goes out, so a control container can reach any public address. It stays log-only
  because Kalshi's and Polymarket's APIs sit behind CloudFront addresses that rotate faster than an address list can
  follow, and blocking could break market data. The sandbox's containment does not depend on this: the firewall and the
  egress proxy on the sandbox machine are enforced there.

### Where the secrets live

| Secret | Only in |
|---|---|
| Vultr Serverless Inference key | models |
| Search API key | markets |
| Users' exchange keys and the master key | connections |
| Session signing key | accounts (edge has the public half) |
| Audit signing key, heads bucket | audit |
| Screenshots bucket | board |
| A caller's token, a database password, a Valkey password | that one service |

**No sandbox ever holds a secret.** The sandbox machine holds only the token that lets runner call it.

## Run it locally

You need Node 26 (through [mise](https://mise.jdx.dev): `mise install` reads `mise.toml`), a stable Rust toolchain
(`rustup`, with clippy and rustfmt), and Docker with Compose.

```sh
mise install            # Node 26
npm ci                  # every workspace, from the lockfile
make dev-secrets        # writes .env and deploy/.dev/valkey-users.acl (both gitignored)
make check              # the gate (see Tests)
```

`.env.example` lists every variable by name. Never commit `.env`. No key goes in this repo.

```sh
make infra-up           # Postgres :55432, Valkey :56379, the fixture site :8300
make fakes              # the nine TypeScript services as in-memory fakes; prints each /health
make stop-fakes
make infra-down         # removes the containers and volumes
```

One service: `npm run dev -w services/board` (real handlers, watch mode) or `npm run fake -w services/board`.

Ports: edge 8080, accounts 8101, board 8102, agent 8103, runner 8104, markets 8105, connections 8106, models 8107,
audit 8108, sandbox-manager 8200, egress-proxy 8201, fixtures 8300.

Locally, the sandboxes use the `docker` backend (runc, Chromium's own sandbox off). The sandbox machine uses `gvisor`.
See [sandbox/README.md](sandbox/README.md).

## Deploy it on Vultr

1. [deploy/PROVISION.md](deploy/PROVISION.md): the Vultr resources to create, in order, with their settings and
   prices.
2. [deploy/sandbox-host/README.md](deploy/sandbox-host/README.md): the sandbox machine in one script (images, static
   binaries, systemd services, nftables with a timed rollback).
3. [deploy/README.md](deploy/README.md): `deploy/scripts/deploy.sh` deploys control and the sandbox machine.
   `--dry-run` prints every step and changes nothing.

## Tests

| Command | What it checks |
|---|---|
| `make check` | The gate: Rust (fmt, clippy, tests), generated files, typecheck, lint, shellcheck, the contract tests, the web app build and the end-to-end flow |
| `make e2e` | The end-to-end flow on fakes, with real sandboxes: sign up, the chat builds a widget, a run fills it with numbers and receipts, a poisoned page gets its sandbox killed. `E2E_SANDBOX=stub make e2e` runs it without Docker |
| `make e2e-real` | The same journey on the real services, with only the model faked and the market data from a recording, so nothing reaches the internet |
| `make containment-local` | The containment checks on a dev PC (Docker) |
| `make containment` | The containment checks on the sandbox machine with `SANDBOX_BACKEND=gvisor`, behind the real proxy and nftables; writes the scoreboard |

More targets (Valkey, audit, Postgres, nftables, the deploy dry run): [HOW-TO-BUILD.md](HOW-TO-BUILD.md), "Tests".

## Layout

| Path | What |
|---|---|
| `services/<name>` | The nine TypeScript services (Hono): edge, accounts, board, agent, runner, markets, connections, models, audit |
| `packages/contracts` | Every schema and API (zod v4), the catalogs, the bus names |
| `packages/service-kit` | The service template: health, config, logs, token check, contract-checked routes and client, migrations |
| `packages/guard` | The guard, a library inside agent and runner |
| `packages/testkit` | Fixture readers, the contract-test harness, sample results |
| `packages/design-kit` | The board's look: a base stylesheet and the liquid-glass themes |
| `web/` | The web app: TypeScript and esbuild, no framework |
| `engine/` | The Rust math engine: a stdin/stdout CLI with receipts (`engine --schema`) |
| `sandbox/` | Rust: `sandbox-manager` and `egress-proxy`; the browse image; the containment tests |
| `fixtures/` | A static site of made-up pages, clean and poisoned; made-up Kalshi and Polymarket data, and one recording of their public APIs |
| `deploy/` | Dev Compose, `db-init.sql`, the Caddyfile, nftables, the sandbox-host scripts, the deploy script |
| `scripts/` | `dev-secrets.ts` |
| `tests/`, `e2e/` | The contract gate and the deploy tests; the end-to-end tests on fakes and on the real services |

How to change a contract or build a piece: [HOW-TO-BUILD.md](HOW-TO-BUILD.md).

## License

MIT. See [LICENSE](LICENSE).
