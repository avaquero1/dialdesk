# sandbox

Everything that runs on the sandbox machine.

- `manager/` (`sandbox-manager`): the HTTP API that creates one fresh sandbox per job, runs it (browse pages, or
  compute with the engine), holds it until release or kill, and destroys it. Every route but `GET /health` needs a
  bearer token whose sha256 is listed in `SANDBOX_MANAGER_CALLERS`.
- `proxy/` (`egress-proxy`): the sandboxes' only way out. It allows port 443 to allowlisted names whose addresses are
  all public, and refuses IP literals, other ports and private or metadata ranges.
- `images/`: the sandbox images (Phase 1).

Phase 0: the manager's `docker` backend is a stub that starts no containers, and the proxy only exposes its decision.

```sh
cargo run -q -p sandbox-manager -- --schema   # paths and JSON Schemas
SANDBOX_MANAGER_CALLERS="runner:$(printf %s "$TOKEN" | sha256sum | cut -d' ' -f1)" \
  cargo run -q -p sandbox-manager -- serve    # listens on SANDBOX_MANAGER_ADDR (default 127.0.0.1:8200)
cargo run -q -p egress-proxy -- --check api.kalshi.com 443 104.18.1.1 kalshi.com
```

Other env: `SANDBOX_SLOTS` (default 6), `SANDBOX_BACKEND` (only `docker`), `SANDBOX_MANAGER_DEV=1` (allows http URLs).
