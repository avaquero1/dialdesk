# How to build a piece (Phase 1 and after)

One worker, one piece, one branch. `main` only moves forward by fast-forward, and only when `make check` is green.

## 1. Your own worktree and branch

```sh
cd ~/Projects/vultr-hackathon-app
git worktree add ../vha-wt/<piece> -b piece/<piece> main     # e.g. piece/markets
cd ../vha-wt/<piece>
npm ci && make dev-secrets                                   # each worktree has its own .env
make check                                                   # green before you start
```

Never edit another piece's folder. Never commit in the main checkout. No remote: nothing is pushed.

## 2. Work

- **Your service** lives in `services/<name>/`:
  - `src/main.ts`: start-up (don't change it much: the template does config, logs, migrations, listen).
  - `src/real.ts`: your handlers. Phase 0 makes every endpoint answer 501 (`unbuilt(API)`). Replace them one at a time:
    `return { ...unbuilt(BOARD), getBoard: async ({ params }, ctx) => {...} }`.
  - `src/fake.ts`: the in-memory fake. **Keep it working**: other pieces build against it. If you change behavior the
    contract allows, change the fake too.
  - `migrations/NNNN_name.sql`: your tables, in your schema, applied once each at start (never edit an applied file).
  - `test/cases.ts`: the contract cases for your fake. Add cases when you add behavior.
- **Config:** every variable starts with your service's name (`BOARD_PORT`, `BOARD_DATABASE_URL`…). Read it with
  `loadConfig('board', { EXTRA: z.string() })`. Add new names to `scripts/dev-secrets.ts` and regenerate `.env.example`
  (`npx tsx scripts/dev-secrets.ts --example > .env.example`).
- **Calling another service:** `const call = await clientFromEnv('runner', 'markets'); await call(MARKETS.get, { params: { market_id } })`.
  The client validates your request and the answer against the contract. Never hand-roll a fetch.
- **Errors:** `throw new HttpError(404, 'not_found', '…')`. The status must be in the endpoint's `errors`.
- **Logs:** `ctx.log` (pino, JSON). Never log a body, a key, a token or page text. `console.log` fails lint.
- **The audit log:** `bus.log(logEntry('board', 'widget.accepted', {...}))`: ids, hashes and sizes only.
- **The bus in real mode:** `const bus = busFromConfig('board', cfg)` (a `ValkeyBus` on `<SVC>_VALKEY_URL`); fakes keep `MemoryBus`.
  `bus.emit(...)` publishes on `events.<name>`, `bus.log(...)` appends to `log:actions`, `bus.subscribe(['run.step'], fn)` listens
  (edge: `'all'`). audit reads the stream with `LogStreamReader`.
- **Queues:** `createQueue(QUEUES.widgetRuns, cfg.VALKEY_URL, 'board').enqueue(job)` with `job_id = widgetRunJobId(...)`;
  `createWorker(QUEUES.widgetRuns, cfg.VALKEY_URL, 'runner', async (job, { signal, attempt }) => {...})`. In the handler, throw
  `NoRetry('poison')` to fail without a retry, `RetryLater(ms)` (or let `SandboxBusy` through) to wait without spending an attempt;
  any other error is retried per `QUEUE_RULES`. The abort `signal` fires at the timeout. `RUN_RULES` has the step timeouts.

## 3. Adding or changing an endpoint (needs the contracts owner)

After `contracts-v0`, contracts change only through their owner. To propose one:

1. Write the change in `packages/contracts/src/api/<service>.ts` on your branch: method, path, `callers`, `params`,
   `query` (strings: use `z.coerce` for numbers), `body`, `response`, `status`, `errors`, `summary`.
2. `npm run gen` (regenerates `schema/` and the Rust-derived types), add the handler to `fake.ts` and `real.ts`, add a
   case to `test/cases.ts`.
3. Ask the owner. The owner lands contract changes on `main` first, alone, so every piece rebases onto them.

The token check comes from `callers`: list exactly the services that need the endpoint. `make dev-secrets` derives the
call graph (and so every token) from those lists.

Rust-owned schemas (engine, sandbox-manager): change the Rust types, then `npm run gen`. `make gen-check` fails when the
generated TypeScript is stale.

## 4. Where the fakes are

| Service | Fake | Notes |
|---|---|---|
| edge | `services/edge/src/fake.ts` | Routes to the other services through typed clients; fake sessions `fake.<ses>.<acc>` |
| accounts | `services/accounts/src/fake.ts` | In-memory accounts and sessions (not signed JWTs) |
| board | `services/board/src/fake.ts` | Boards, prescribed defaults with first-paint prices (pass `markets`), proposals, results, screenshots; enqueued runs in `fakeQueue` (real: widget-runs on BullMQ). Same rules as the real one (`logic.ts`) |
| agent | `services/agent/src/fake.ts` | The scripted chat from the UI plan; every reply guarded; `advice-test` shows the blocked line |
| runner | `services/runner/src/fake.ts` | `run_state` reads only. The runs themselves: `handleRun` (`services/runner/src/run.ts`) on the other fakes, as `e2e/flow.test.ts` wires it |
| markets | `services/markets/src/fake.ts` | Backed by `fixtures/markets` and `fixtures/site/MANIFEST.json` |
| connections | `services/connections/src/fake.ts` | A key id containing `write` is refused as write scope |
| models | `services/models/src/fake.ts` | Canned answers by role × scenario (`clean`, `poisoned`, `advice`, `error`) |
| audit | `services/audit/src/fake.ts` | An in-memory hash chain; `createFakeAudit().append(entry)` |
| sandbox-manager | `sandbox/manager` (Rust) | Not a fake: the real binary on Docker with real Chromium sandboxes behind the real proxy (`sandbox/dev/topology.ts`). `SANDBOX_BACKEND=stub` for no Docker |

Run one as a fake: `npm run fake -w services/<name>`, or all nine: `make fakes`.

## 5. Tests

- `make contracts`: every fake's cases, validated against the contract both ways; every endpoint must have a success
  case; no route outside the contract; wrong callers get 403, no token 401.
- `make e2e`: the end-to-end flow on fakes (`e2e/flow.test.ts`): sign up, the chat builds a widget, a run fills it
  with numbers and receipts, a poisoned page gets its sandbox killed. Pending steps are `it.todo`: turn yours into a
  real step when your piece lands. It needs Docker, the sandbox images (`make images`) and the Rust binaries (`make rust`);
  `E2E_SANDBOX=stub make e2e` runs it without Docker.
- `make valkey-test`: the bus on a real Valkey 8.1 in its own Compose project (`vha-valkey-test`, port 56393): pub/sub, the log
  stream's consumer group, BullMQ retries, every service's ACL allow and deny, and runner's real worker running the
  scheduler's enqueues on the fakes (`services/runner/test/valkey-worker.test.ts`). Not part of `make check` (it needs Docker
  and `make dev-secrets`). Run it when you touch `bus.ts`, `valkey.ts` or `queues.ts`. The ACL file comes from `valkeyAclRule()`: after a
  rule change, regenerate it with `npx tsx scripts/dev-secrets.ts --force` (every token changes).
- `make audit-test`: audit on a real Postgres 17 and Valkey 8.1 in its own Compose project (`vha-audit-test`, ports 55434 and 56394),
  as svc_audit and svc-audit: the chain from `log:actions`, signed and pushed heads, `verify` catching a tampered row, a rewritten
  chain and a cut tail, UPDATE/DELETE/TRUNCATE refused, XAUTOCLAIM from a dead consumer, and the trust numbers. Not part of
  `make check` (Docker, `make dev-secrets`). `PG_DEV_PORT` moves the dev Postgres port the same way `VALKEY_DEV_PORT` does.
- `make e2e-real`: the same journey on the **real** services, only the model faked (meeting point 1). Compose project
  `vha-e2e-real` (Postgres :55441, Valkey :56441, the fixture site on :8300, which the catalog's fixture rows name); the test
  (`e2e/real/journey.test.ts`) starts sandbox-manager on the docker backend on its own dev topology and the nine services with
  tsx on :18440-18448 (`e2e/real/stack.ts`, models with `MODELS_FAKE=1`), then drives edge's browser API: sign up, the first
  board on this weekend's games, the chat (Hi, a league, a team, two proposals, the taps), the runs on BullMQ, the research
  run with the poisoned page's box killed, a refresh that keeps the clean numbers, the trust counts and audit's verify.
  audit's migrations run first, as audit_owner from the admin login (`npm run migrate -w services/audit`).
  markets runs from `e2e/real/markets-recorded.ts`: the real service on the recording of this weekend
  (`fixtures/markets/live/weekend`); every other host is refused, so nothing reaches the internet. Logs:
  `.logs/e2e-real/<service>.log`. Everything is removed afterwards. Not part of `make check` (Docker, `make dev-secrets`,
  `make images`). `E2E_REAL_PORT_BASE`, `E2E_REAL_PG_PORT` and `E2E_REAL_VALKEY_PORT` move the ports.
- `make agent-pg-test`: agent's Postgres conversation store (`services/agent/test/pg-store.test.ts`) on a throwaway
  Postgres 17 (Compose project `vha-agent-pg-test`, port 55436), as the superuser, removed afterwards.
- **The trust page's numbers** come from log actions named in `TRUST_ACTIONS` (packages/contracts/src/api/audit.ts), with the
  ids, sizes and hashes listed there. Log them with those names or the trust page won't count them.
- Your own unit tests: `services/<name>/test/*.test.ts` (picked up by the contracts project) or Rust `#[test]`s.

## 6. Landing

```sh
make check                       # green, in your worktree
make check                       # green again after the rebase
cd ~/Projects/vultr-hackathon-app && git merge --ff-only piece/<piece>
git worktree remove ../vha-wt/<piece> && git branch -d piece/<piece>
```

If `--ff-only` refuses, someone landed first: rebase again. Never merge with a merge commit, never force.
Leave a handoff note in your report: what you tried, the dead ends, what's left.
