#!/usr/bin/env bash
# From a dev PC: copies this repo's HEAD to the sandbox machine as a git archive (no remote, nothing pushed) and runs
# setup.sh there. The machine and the key come from the environment, never from the repo:
#
#   VHA_SANDBOX_HOST=root@<address> VHA_SANDBOX_SSH_KEY=<key file> deploy/sandbox-host/push.sh [setup.sh options]
#
# The copy lands in /opt/vha/src/<rev> and /opt/vha/src/current points at it. Without options, setup.sh is not run.
set -euo pipefail
HOST=${VHA_SANDBOX_HOST:?set VHA_SANDBOX_HOST=root@<address>}
KEY=${VHA_SANDBOX_SSH_KEY:?set VHA_SANDBOX_SSH_KEY=<key file>}
REV=$(git rev-parse --short=12 HEAD)
[[ -z $(git status --porcelain --untracked-files=no) ]] || echo "push.sh: uncommitted changes are NOT copied (HEAD $REV is)" >&2
ssh_() { ssh -i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15 "$HOST" "$@"; }
git archive --format=tar HEAD | ssh_ "set -e; d=/opt/vha/src/$REV; rm -rf \$d; mkdir -p \$d; tar -x -C \$d; echo $REV > \$d/.vha-rev; ln -sfn \$d /opt/vha/src/current"
echo "push.sh: $REV is in /opt/vha/src/$REV"
if [[ $# -gt 0 ]]; then
  # shellcheck disable=SC2029 # the options are meant to expand here
  ssh_ "cd /opt/vha/src/$REV && deploy/sandbox-host/setup.sh $*"
fi
