#!/usr/bin/env bash
# On the sandbox machine, as root, from the repo copy (after setup.sh --with-tests): `make containment` on gVisor
# with the installed binaries and the images by id. Output: containment-out/ (run.log, scoreboard.md, score.json).
set -uo pipefail
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -x node_modules/.bin/vitest ]] || { echo "no node_modules here: run setup.sh --with-tests (or npm ci) in this copy first" >&2; exit 1; }
set -a; . /etc/vha/images.env; set +a
export PATH=/opt/vha/node/bin:$PATH SANDBOX_BACKEND=gvisor \
  SANDBOX_MANAGER_BIN=/usr/local/lib/vha/sandbox-manager SANDBOX_PROXY_BIN=/usr/local/lib/vha/egress-proxy
mkdir -p containment-out
{ echo "rev $(cat .vha-rev 2>/dev/null || echo unknown) on $(hostname), $(date -u +%FT%TZ)"; runsc --version | head -n1; uname -r
  echo "images: $SANDBOX_BROWSE_IMAGE $SANDBOX_PROBE_IMAGE $SANDBOX_COMPUTE_IMAGE"; } > containment-out/run.log
make containment 2>&1 | tee -a containment-out/run.log
s=${PIPESTATUS[0]}
nft list counters table inet vha_sandbox >> containment-out/run.log 2>&1
echo "run-containment: exit $s" | tee -a containment-out/run.log
exit "$s"
