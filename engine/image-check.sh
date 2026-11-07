#!/usr/bin/env bash
# Runs the compute image the way the sandbox manager will and checks what it does.
# Usage: engine/image-check.sh [image]   (default vha-engine-compute:dev)
set -euo pipefail
IMAGE="${1:-vha-engine-compute:dev}"
HEAD_HASH="$(git rev-parse --short=12 HEAD)"
RUN=(docker run --rm -i --network none --read-only --cap-drop ALL
  --security-opt no-new-privileges --pids-limit 8 --memory 64m --memory-swap 64m --cpus 0.5)
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }

[ -z "$(git status --porcelain -- engine Cargo.toml Cargo.lock)" ] || echo "note: engine/ has uncommitted changes, so the git hash in the image is not the whole story"

size=$(docker image inspect "$IMAGE" --format '{{.Size}}')
user=$(docker image inspect "$IMAGE" --format '{{.Config.User}}')
[ "$user" = "65534:65534" ] || fail "image user is '$user', want 65534:65534"
pass "image $IMAGE: $size bytes, user $user"

# The filesystem holds the engine binary and nothing else (docker adds the mount points).
cid=$(docker create --network none "$IMAGE")
files=$(docker export "$cid" | tar -t | grep -v -E '^(dev|proc|sys|etc)(/|$)|^\.dockerenv$' || true)
nets=$(docker inspect "$cid" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
docker rm -f "$cid" >/dev/null
[ "$files" = "engine" ] || fail "image files: $files"
pass "filesystem: only /engine (no shell, no libc, no tools)"
[ "$nets" = "none " ] || fail "networks: '$nets'"
pass "network: none"

v=$("${RUN[@]}" "$IMAGE" --version)
[ "$v" = "engine 0.1.0 ($HEAD_HASH)" ] || fail "version '$v', want hash $HEAD_HASH"
pass "version: $v"

input='{"plan":{"plan_version":1,"ops":[
  {"id":"q","op":"implied_probability","args":{"price_cents":"poly"}},
  {"id":"ev","op":"expected_value","args":{"price_cents":"kalshi","probability":"q"}},
  {"id":"gap","op":"gap","args":{"a_cents":"kalshi","b_cents":"poly"}},
  {"id":"br","op":"base_rate_history","args":{"history":"h","lo_cents":"lo","hi_cents":"hi"}},
  {"id":"model_ev","op":"expected_value","args":{"price_cents":"kalshi","probability":"guess"}}]},
  "numbers":{"kalshi":57,"poly":61,"guess":0.9,"lo":55,"hi":65,
    "h":[{"t":1,"price_cents":58,"outcome":1},{"t":2,"price_cents":60,"outcome":0},{"t":3,"price_cents":63,"outcome":1},{"t":4,"price_cents":20,"outcome":0}]},
  "origins":{"kalshi":"market","poly":"market","h":"history"}}'
out=$(printf '%s' "$input" | "${RUN[@]}" "$IMAGE")
native=$(printf '%s' "$input" | cargo run -q -p engine)
node -e '
const [o, n, head] = [JSON.parse(process.argv[1]), JSON.parse(process.argv[2]), process.argv[3]];
const val = (id) => o.numbers.find((x) => x.id === id)?.value;
const must = (c, m) => { if (!c) { console.error("FAIL: " + m); process.exit(1); } console.log("ok   " + m); };
must(o.git_hash === head && o.receipts.every((r) => r.git_hash === head), "receipts carry git hash " + head);
must(o.plan.ops.length === 5 && o.plan_hash.length === 64 && o.input_hash.length === 64, "result holds the plan, plan_hash and input_hash");
must(val("ev") === 4 && val("gap") === 4, "EV 4 cents from the other exchange, gap 4 points");
must(Math.abs(val("br") - 2 / 3) < 1e-9 && o.receipts.find((r) => r.op_id === "br").sample_size === 3, "base rate 2/3 over 3 resolved markets");
must(o.errors.length === 1 && o.errors[0].op_id === "model_ev" && o.errors[0].code === "unsourced_probability", "EV on an untagged (model) probability is refused");
must(o.input_hash === n.input_hash && o.plan_hash === n.plan_hash && JSON.stringify(o.numbers) === JSON.stringify(n.numbers), "same numbers and hashes as the native build");
' "$out" "$native" "$HEAD_HASH"

set +e
bad=$(printf '{not json' | "${RUN[@]}" "$IMAGE"); code=$?
set -e
[ "$code" = 2 ] && [[ "$bad" == *bad_input* ]] || fail "bad input gave exit $code: $bad"
pass "bad input: exit 2, bad_input"

set +e
big=$(head -c 17000000 /dev/zero | tr '\0' ' ' | "${RUN[@]}" "$IMAGE"); code=$?
set -e
[ "$code" = 2 ] && [[ "$big" == *"larger than"* ]] || fail "17 MB input gave exit $code"
pass "17 MB input: refused under the 64 MB memory cap"
echo "engine-image-check: all green"
