#!/usr/bin/env bash
# Milestone V1.1's end-to-end check (`make deploy-image-check`): build the app image, then in it
#   1. print the egress table (deploy/egress-hosts.ts),
#   2. run the prod-secrets dry run as deploy.sh will (no --out: a temp folder, removed afterwards): exit 0,
#   3. run it again into a mounted folder, and check that nothing it printed is a value from any file it wrote.
# Example inputs only (documentation addresses). Needs Docker; builds locally, so run it through build-slot here.
set -euo pipefail
cd "$(dirname "$0")/../.."
tag="${VHA_APP_TAG:-vha/app:check}"
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT

docker build -q -f deploy/images/app.Dockerfile --target app --build-arg GIT_HASH="$(git rev-parse --short HEAD)" -t "$tag" . >/dev/null
echo "check-app-image: built $tag ($(docker image inspect -f '{{.Size}}' "$tag" | awk '{ printf "%.0f MB", $1 / 1e6 }'))"

inputs=(-e SANDBOX_VPC_IP=10.1.96.4 -e PG_HOST=vultr-prod-pg.internal -e PG_PORT=16751 -e PG_DATABASE=defaultdb
  -e S3_ENDPOINT=https://ewr1.vultrobjects.com)
run() { docker run --rm --network none --read-only --tmpfs /tmp:size=16m --cap-drop ALL --security-opt no-new-privileges "$@"; }

run "${inputs[@]}" "$tag" node --import tsx deploy/egress-hosts.ts > "$work/egress-hosts.txt"
echo "check-app-image: egress table: $(grep -vc '^#' "$work/egress-hosts.txt") hosts"

run "${inputs[@]}" "$tag" node --import tsx deploy/prod-secrets.ts --dry-run > "$work/dry.txt"
echo "check-app-image: dry run exit 0, $(grep -c . "$work/dry.txt") lines"

mkdir -p "$work/out"
run "${inputs[@]}" --user "$(id -u):$(id -g)" -v "$work/out:/out" "$tag" \
  node --import tsx deploy/prod-secrets.ts --dry-run --out /out > "$work/dry-out.txt"
n="$(find "$work/out" -type f | wc -l)"
[ "$n" -ge 20 ] || { echo "check-app-image: expected 20+ files, got $n" >&2; exit 1; }

# Every value in every file (as tests/deploy/prod-secrets.test.ts reads them): what follows `=` in the env and state
# files, and each whole line of the others (keys, the ACL); 8+ characters, no PEM armor lines, no comments.
find "$work/out" -type f | while read -r f; do
  case "$f" in *env|*values) sed 's/^[^=]*=//' "$f" ;; *) cat "$f" ;; esac
done | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | awk 'length($0) >= 8 && $0 !~ /^(-----|#)/' | sort -u > "$work/values"
[ -s "$work/values" ] || { echo "check-app-image: no values found to compare" >&2; exit 1; }
for f in dry.txt dry-out.txt; do
  if grep -qF -f "$work/values" "$work/$f"; then
    echo "check-app-image: FAIL: $f shows a secret value" >&2; exit 1
  fi
done
echo "check-app-image: $n files, $(wc -l < "$work/values") values, none in either report: passed"
