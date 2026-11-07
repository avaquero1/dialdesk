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
`base_rate`, `position_value`, `pnl`. It is also a library (`engine::run`), which the sandbox manager uses.
