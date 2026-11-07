# sandbox

Everything that runs on the sandbox machine.

- `manager/` (`sandbox-manager`): the HTTP API that creates one fresh sandbox per job, runs it (browse pages, or
  compute with the engine), holds a browse sandbox until release or kill, and destroys it. Every route but
  `GET /health` needs a bearer token whose sha256 is listed in `SANDBOX_MANAGER_CALLERS`.
- `proxy/` (`egress-proxy`): the sandboxes' only way out, as its own process.
- `images/browse/`: the browse sandbox (Debian's Chromium and a small driver) and, as a second target, the same image
  with the attack probes the containment tests run.
- `dev/`: the sandbox machine's network rebuilt on one dev PC for the tests (DEV ONLY).
- `test/`: the containment tests (`make containment-local`).

## Backends (`SANDBOX_BACKEND`)

| Backend | What | Where |
|---|---|---|
| `gvisor` | The docker backend with `--runtime runsc` (systrap). Chromium's own sandbox on. | The sandbox machine (chosen by the VX1 spike, Nov 7) |
| `docker` | The same backend on runc. Chromium's own sandbox off (Docker's seccomp blocks it). | Local development and tests |
| `stub` | No Docker: no pages, the engine in process. | Unit tests, `E2E_SANDBOX=stub` |

Every sandbox: uid 10001, every capability dropped, no-new-privileges, a read-only root with small tmpfs mounts
(`noexec`), memory with no swap, CPU, process and open-file caps, no env from the manager, no host folder (only an
empty read-only `resolv.conf`), no Docker socket, `--log-driver none`. The process cap is `--ulimit nproc` under gVisor
(its own kernel counts only the sandbox) and the pids cgroup on runc (where nproc would count every sandbox's uid
10001). A browse sandbox sits on the sandbox network at an address the manager picks and registers with the proxy
before it starts; a compute sandbox has `--network none`. The manager removes its leftover sandboxes at start-up.

## The egress proxy

- Maps each connection to its sandbox by source address (no token enters a sandbox); an unknown source gets nothing.
- `CONNECT host:443` only, to a name on that sandbox's allowlist (subdomains included). IP literals, other ports and
  plain-HTTP proxy requests are refused.
- Resolves names itself, only after the allowlist check, and refuses a name if any address is private, loopback,
  link-local (169.254.169.254), carrier NAT, multicast, or IPv6 link-local / ULA. The tunnel goes to a checked address.
- Logs every request, allowed or refused, per sandbox. The manager takes the log over the control socket (a Unix
  socket, mode 0600, on no network) and returns it with the job. The proxy never calls anything.

```sh
egress-proxy serve --listen 172.30.77.1:8201 --control /run/egress/control.sock
egress-proxy --check api.kalshi.com 443 104.18.1.1 kalshi.com     # one decision as JSON
```

`--dev-map` and `--dev-resolve` exist for the dev topology only (the fixture site, the rebinding test).

## The manager

```sh
cargo run -q -p sandbox-manager -- --schema   # paths and JSON Schemas
SANDBOX_MANAGER_CALLERS="runner:$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)" \
SANDBOX_NETWORK=… SANDBOX_PROXY_URL=http://<proxy ip>:8201 SANDBOX_PROXY_CONTROL=/run/egress/control.sock \
  cargo run -q -p sandbox-manager -- serve    # listens on SANDBOX_MANAGER_ADDR (default 127.0.0.1:8200)
sandbox-manager probe [--allow a,b] [--wall S] -- whoami   # one attack probe in a fresh sandbox (tests)
```

| Env | Default | What |
|---|---|---|
| `SANDBOX_BACKEND` | `docker` (`stub` with `SANDBOX_MANAGER_DEV=1`) | `gvisor`, `docker` or `stub` |
| `SANDBOX_RUNTIME` | `runsc` / `runc` | Override the runtime (e.g. `runsc-kvm`) |
| `SANDBOX_SLOTS` | 6 | Live sandboxes at most; past it `POST /jobs` answers 503 busy |
| `SANDBOX_STARTING` | 2 | Sandboxes starting at once; the rest wait queued (the spike: 2 starting, 12 live on the VX1) |
| `SANDBOX_NETWORK` | (required) | The Docker network of the browse sandboxes |
| `SANDBOX_PROXY_URL` | (required) | The proxy as a sandbox sees it |
| `SANDBOX_PROXY_CONTROL` | (required) | The proxy's control socket |
| `SANDBOX_BROWSE_IMAGE` | `vha-browse:dev` | Pin by digest on the sandbox machine |
| `SANDBOX_COMPUTE_IMAGE` | `vha-engine-compute:dev` | The engine image (`make engine-image`); pin by digest on the sandbox machine |
| `SANDBOX_CHROMIUM_SANDBOX` | `on` under gVisor, `off` on runc | `on`, `off` or `auto` |
| `SANDBOX_INSTANCE` | `vha` | Container name prefix and `vha.instance` label |
| `SANDBOX_STATE_DIR` | a temp folder | Holds the empty `resolv.conf` |
| `SANDBOX_MANAGER_DEV` | unset | `1` allows http URLs and `SANDBOX_DEV_SPKI` (the fixture certificate pin) |

Each `JobStatus` carries `trust_log`: the trust page's rows for that job, in the shape of `TRUST_ACTIONS`
(`packages/contracts/src/api/audit.ts`). `sandbox.created`, `sandbox.killed` (ids: reason, audit_row_id) and `sandbox.destroyed`,
each with subject_id = the sandbox id, and one `proxy.refused` with `sizes.requests` when the proxy refused anything. The manager
never writes to the log itself: the caller adds account_id and appends each row as service `sandbox-manager`.

## Tests

- `cargo test -p egress-proxy -p sandbox-manager`: decisions, the proxy over loopback sockets, the lifecycle on the stub,
  the docker flags.
- `make containment-local` (Docker, `make images`): not root, no secret inside, the process, memory and time caps, no
  route out but the proxy and no DNS, a fresh sandbox per job, an off-list host and the metadata address refused and
  logged, held until release or kill, busy past the slot cap, compute with no network.
- `make e2e`: the research run reads the fixture pages in real sandboxes; the poisoned page's callouts are refused and
  logged, and its sandbox is killed.
