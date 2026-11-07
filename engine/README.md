# engine

The fixed math engine. It reads an `EngineInput` (a plan of ops plus named numbers) as JSON on stdin and writes an
`EngineResult` on stdout. Every number comes with a receipt: its resolved inputs, the formula, hashes of the plan and
inputs, and the engine version and git hash. Per-op problems are reported in `errors` (exit 0); unparsable input exits 2.

```sh
cargo run -q -p engine -- --schema      # JSON Schemas: {plan, input, result, receipt}
cargo run -q -p engine -- --version
echo '{"plan":{"plan_version":1,"ops":[{"id":"n1","op":"implied_probability","args":{"price_cents":"c"}}]},"numbers":{"c":57}}' \
  | cargo run -q -p engine
```

Ops: `implied_probability`, `price_to_odds`, `odds_to_probability`, `expected_value`, `movement`, `volatility`, `gap`,
`base_rate`, `base_rate_history`, `position_value`, `pnl`. It is also a library (`engine::run`), which the sandbox manager uses.

**Inputs are numbers only.** `numbers` holds numbers, price series (`[{t, v}]`) and histories of resolved markets
(`[{t, price_cents, outcome}]`, outcome 0 or 1). A plan's args name inputs or earlier ops; they never hold a value.

**Origins.** `origins` tags inputs by key: `user`, `market`, `history` or `connection`. There is no `model` origin.
`expected_value` refuses (`unsourced_probability`) unless its probability traces back, through any earlier ops, only to
`user`, `market` or `history` inputs, and comes from a probability or ratio. So a model's number can never be EV's
probability.

**Base rates from history.** `base_rate_history` takes a history and an optional price band (`lo_cents`, `hi_cents`):
the share of resolved markets priced in the band that resolved YES. Its receipt holds `sample_size`.

**Receipts.** The result holds the plan as run, `plan_hash` (sha256 of the plan's JSON), `input_hash` (sha256 of
`{"numbers", "origins"}`), the engine version and git hash. Each number's receipt holds the resolved args, the plan's
`refs` for them, the formula, the origins its inputs trace to, and the same hashes and version.

The git hash comes from `git rev-parse` at build time, or from `ENGINE_GIT_HASH` when set (the compute image).

## The compute sandbox image

`engine/Dockerfile` builds `vha-engine-compute`: the static (musl) engine binary alone on `scratch`, run as uid 65534.
About 450 KB. It has no shell, no libc and no network code, and it runs with no network:

```sh
make engine-image          # vha-engine-compute:<git hash> and :dev; the git hash comes in as a build arg
make engine-image-check    # runs it with the flags below and checks the output against the native build
docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 8 --memory 64m --memory-swap 64m --cpus 0.5 vha-engine-compute:dev < input.json
```

The base image is pinned by digest. The sandbox manager should run the image by its id or digest, never by tag.

## Tests

`cargo test -p engine`: unit tests (`src/tests.rs`), the CLI (`tests/cli.rs`) and the property suite (`tests/props.rs`,
proptest): probabilities and ratios stay in 0..=1, price, probability and odds round-trip, EV's sign is right and its
probability is sourced, the gap is symmetric, base rates match a plain count, and arbitrary plans never panic and
give receipts that hash exactly what ran.
