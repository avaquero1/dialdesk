#!/usr/bin/env bash
# Sets up the sandbox machine (Ubuntu 24.04, Docker and gVisor installed) from an unpacked copy of the repo.
# Run as root from the copy's top folder (push.sh does both):
#
#   deploy/sandbox-host/setup.sh --ssh-from <admin address> [--rollback-seconds 300] [--with-tests] [--no-firewall]
#                                [--vpc-if <if> --control-vpc-ip <ip> --vpc-subnet <cidr>]   (the deploy, once the VPC is on)
#
# In this order (the firewall is last, with a timed rollback, so a mistake cannot lock SSH out):
#   1  checks: root, Docker, the runsc runtime
#   2  users: vha-egress (the proxy), vha-sandbox (the manager; in the docker group), group vha-ctl (the control socket)
#   3  images, built here from this copy: vha-browse, vha-probe, vha-engine-compute; their ids go in /etc/vha/images.env
#   4  sandbox-manager and egress-proxy, built here in a pinned Rust container, installed in /usr/local/lib/vha
#   5  the Docker network vha-sbx (bridge vha-sbx, 172.30.78.0/24, no container-to-container traffic)
#   6  systemd: vha-egress-proxy (as vha-egress, on 172.30.78.1:8201) and vha-sandbox-manager (as vha-sandbox,
#      SANDBOX_BACKEND=gvisor, images by id, API on 127.0.0.1:8200), plus a caller token for runner in /etc/vha
#   7  with --with-tests: Node (pinned tarball) in /opt/vha/node and `npm ci` here, for `make containment`
#   8  nftables (deploy/nftables/sandbox.nft, in /etc/vha/nft) loaded live and ufw turned off, the old tables kept for the rollback, which fires after
#      --rollback-seconds unless `vha-nft-confirm` is run from a NEW ssh connection.
# Safe to run again: each step checks what is already there.
set -euo pipefail

SSH_FROM=""; ROLLBACK=300; WITH_TESTS=0; FIREWALL=1
# Until the VPC is attached: no such interface, a documentation address (RFC 5737), and 10/8 (already blocked).
VPC_IF=none; CONTROL_VPC_IP=192.0.2.1; VPC_SUBNET=10.0.0.0/8
while [[ $# -gt 0 ]]; do
  case $1 in
    --ssh-from) SSH_FROM=$2; shift 2;; --rollback-seconds) ROLLBACK=$2; shift 2;;
    --with-tests) WITH_TESTS=1; shift;; --no-firewall) FIREWALL=0; shift;;
    --vpc-if) VPC_IF=$2; shift 2;; --control-vpc-ip) CONTROL_VPC_IP=$2; shift 2;; --vpc-subnet) VPC_SUBNET=$2; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
SRC=$(pwd)
NET=vha-sbx; BRIDGE=vha-sbx; SUBNET=172.30.78.0/24; GW=172.30.78.1; PROXY_PORT=8201
LIB=/usr/local/lib/vha; ETC=/etc/vha; NFT=/etc/vha/nft
NODE_VERSION=v26.8.2
NODE_SHA256=40e1d3225c1c9ae9a2671c98ecb9857e4d5555026394f348645676798840d5c5
step() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }

step "1 checks"
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f $SRC/deploy/sandbox-host/setup.sh ]] || { echo "run from the repo copy's top folder" >&2; exit 1; }
docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || { echo "Docker has no runsc runtime: install gVisor first (README)" >&2; exit 1; }
if (( FIREWALL )) && [[ -z $SSH_FROM ]]; then echo "--ssh-from <admin address> is needed for the firewall (or --no-firewall)" >&2; exit 2; fi
REV=$(cat "$SRC/.vha-rev" 2>/dev/null || echo unknown)
note "source $SRC (rev $REV), $(docker --version), $(runsc --version 2>&1 | head -n1)"

step "2 users"
getent group vha-ctl >/dev/null || groupadd --system vha-ctl
id vha-egress >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vha-egress
id vha-sandbox >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vha-sandbox
usermod -aG vha-ctl vha-egress; usermod -aG docker,vha-ctl vha-sandbox
PROXY_UID=$(id -u vha-egress); MANAGER_UID=$(id -u vha-sandbox); CTL_GID=$(getent group vha-ctl | cut -d: -f3)
note "vha-egress uid $PROXY_UID, vha-sandbox uid $MANAGER_UID (docker group: it can run containers), vha-ctl gid $CTL_GID"

step "3 images"
export DOCKER_BUILDKIT=1
docker build -q --target browse -t vha-browse:dev -t "vha-browse:$REV" sandbox/images/browse >/dev/null
docker build -q --target probe -t vha-probe:dev -t "vha-probe:$REV" sandbox/images/browse >/dev/null
docker build -q -f engine/Dockerfile --build-arg GIT_HASH="$REV" -t vha-engine-compute:dev -t "vha-engine-compute:$REV" . >/dev/null
BROWSE_ID=$(docker image inspect --format '{{.Id}}' vha-browse:dev)
PROBE_ID=$(docker image inspect --format '{{.Id}}' vha-probe:dev)
COMPUTE_ID=$(docker image inspect --format '{{.Id}}' vha-engine-compute:dev)
mkdir -p "$ETC"
cat > "$ETC/images.env" <<EOF
# Written by deploy/sandbox-host/setup.sh (rev $REV): the sandbox images by content id.
SANDBOX_BROWSE_IMAGE=$BROWSE_ID
SANDBOX_PROBE_IMAGE=$PROBE_ID
SANDBOX_COMPUTE_IMAGE=$COMPUTE_ID
EOF
note "browse $BROWSE_ID"; note "probe $PROBE_ID"; note "compute $COMPUTE_ID"

step "4 binaries"
OUT=$(mktemp -d)
docker build -q -f deploy/sandbox-host/Dockerfile.bins --build-arg GIT_HASH="$REV" --output "type=local,dest=$OUT" . >/dev/null
install -d -m 755 "$LIB"
install -m 755 "$OUT/sandbox-manager" "$OUT/egress-proxy" "$LIB/"
rm -rf "${OUT:?}"
note "$("$LIB/sandbox-manager" --version 2>/dev/null || echo sandbox-manager) in $LIB; egress-proxy in $LIB"

step "5 network"
# An older layout (another subnet or bridge name) is replaced while no sandbox is on it.
if docker network inspect "$NET" >/dev/null 2>&1 && [[ $(docker network inspect "$NET" --format '{{(index .IPAM.Config 0).Subnet}} {{index .Options "com.docker.network.bridge.name"}}') != "$SUBNET $BRIDGE" ]]; then
  systemctl stop vha-sandbox-manager.service vha-egress-proxy.service 2>/dev/null || true
  docker network rm "$NET" >/dev/null
fi
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" --gateway "$GW" \
  -o com.docker.network.bridge.name="$BRIDGE" -o com.docker.network.bridge.enable_icc=false "$NET" >/dev/null
note "$(docker network inspect "$NET" --format '{{.Name}} {{(index .IPAM.Config 0).Subnet}} icc={{index .Options "com.docker.network.bridge.enable_icc"}}')"

step "6 services"
if [[ ! -f $ETC/runner-token ]]; then
  ( umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$ETC/runner-token" )
fi
TOKEN_SHA=$(tr -d '\n' < "$ETC/runner-token" | sha256sum | cut -d' ' -f1)
( umask 027; cat > "$ETC/sandbox-manager.env" <<EOF
# Written by deploy/sandbox-host/setup.sh. The caller token itself is in $ETC/runner-token (root only); runner gets a copy.
SANDBOX_BACKEND=gvisor
SANDBOX_CHROMIUM_SANDBOX=on
SANDBOX_MANAGER_ADDR=127.0.0.1:8200
SANDBOX_MANAGER_CALLERS=runner:$TOKEN_SHA
SANDBOX_NETWORK=$NET
SANDBOX_PROXY_URL=http://$GW:$PROXY_PORT
SANDBOX_PROXY_CONTROL=/run/vha-egress/control.sock
SANDBOX_STATE_DIR=/var/lib/vha-sandbox
EOF
)
chgrp vha-sandbox "$ETC/sandbox-manager.env"
cat > /etc/systemd/system/vha-egress-proxy.service <<EOF
[Unit]
Description=Blast Radius Zero egress proxy (the sandboxes' only way out)
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
User=vha-egress
Group=vha-ctl
RuntimeDirectory=vha-egress
RuntimeDirectoryMode=0750
ExecStart=$LIB/egress-proxy serve --listen $GW:$PROXY_PORT --control /run/vha-egress/control.sock --control-gid $CTL_GID
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
CapabilityBoundingSet=
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/vha-sandbox-manager.service <<EOF
[Unit]
Description=Blast Radius Zero sandbox-manager (one fresh gVisor sandbox per job)
After=docker.service vha-egress-proxy.service
Requires=docker.service vha-egress-proxy.service

[Service]
User=vha-sandbox
Group=vha-sandbox
SupplementaryGroups=docker vha-ctl
EnvironmentFile=$ETC/sandbox-manager.env
EnvironmentFile=$ETC/images.env
StateDirectory=vha-sandbox
ExecStart=$LIB/sandbox-manager serve
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet vha-egress-proxy.service vha-sandbox-manager.service
systemctl restart vha-egress-proxy.service
for _ in $(seq 50); do [[ -S /run/vha-egress/control.sock ]] && break; sleep 0.1; done
systemctl restart vha-sandbox-manager.service
for _ in $(seq 100); do curl -fsS http://127.0.0.1:8200/health >/dev/null 2>&1 && break; sleep 0.2; done
note "proxy $(systemctl is-active vha-egress-proxy), manager $(systemctl is-active vha-sandbox-manager): $(curl -fsS http://127.0.0.1:8200/health || echo 'no /health')"
note "control socket $(stat -c '%U:%G %a' /run/vha-egress/control.sock)"

if (( WITH_TESTS )); then
  step "7 test tools"
  if [[ ! -x /opt/vha/node/bin/node ]] || [[ $(/opt/vha/node/bin/node --version) != "$NODE_VERSION" ]]; then
    T=$(mktemp -d)
    curl -fsSL -o "$T/node.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-x64.tar.xz"
    echo "$NODE_SHA256  $T/node.tar.xz" | sha256sum -c --quiet
    rm -rf /opt/vha/node && mkdir -p /opt/vha/node && tar -xJf "$T/node.tar.xz" -C /opt/vha/node --strip-components 1
    rm -rf "${T:?}"
  fi
  PATH=/opt/vha/node/bin:$PATH npm ci --no-audit --no-fund --loglevel=error
  note "node $(/opt/vha/node/bin/node --version); run: PATH=/opt/vha/node/bin:\$PATH SANDBOX_BACKEND=gvisor make containment"
fi

step "8 nftables"
if (( ! FIREWALL )); then note "skipped (--no-firewall)"; exit 0; fi
PUBLIC_IF=$(ip -4 route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[[ -n $PUBLIC_IF ]] || { echo "no default route: can't tell the public interface" >&2; exit 1; }
install -d -m 755 "$NFT"
cat > "$NFT/sandbox-vars.nft" <<EOF
# Written by deploy/sandbox-host/setup.sh: this machine's values for deploy/nftables/sandbox.nft.
define PUBLIC_IF = "$PUBLIC_IF"
define VPC_IF = "$VPC_IF"
define ADMIN_IP = $SSH_FROM
define CONTROL_VPC_IP = $CONTROL_VPC_IP
define VPC_SUBNET = $VPC_SUBNET
define PROXY_UID = $PROXY_UID
define MANAGER_UID = $MANAGER_UID
EOF
install -m 644 deploy/nftables/sandbox.nft "$NFT/sandbox.nft"
nft -c -I "$NFT" -f "$NFT/sandbox.nft"
note "public $PUBLIC_IF, admin $SSH_FROM, VPC $VPC_IF ($CONTROL_VPC_IP, $VPC_SUBNET)"
# The rollback: back to the inet tables loaded now (ours too, on a re-run), saved before the switch.
OLD=$(nft list tables | awk '$2=="inet"{print $3}')
{ echo "#!/bin/sh"; echo "nft delete table inet vha_sandbox 2>/dev/null"; for t in $OLD; do echo "nft -f $ETC/rollback-$t.nft"; done; } > "$ETC/nft-rollback.sh"
for t in $OLD; do nft list table inet "$t" > "$ETC/rollback-$t.nft"; done
# ufw's own chains (default deny in) would drop the sandboxes' packets to the proxy too: every table must accept a packet.
# This table replaces it; the rollback turns it back on.
UFW=0; command -v ufw >/dev/null && ufw status | grep -q 'Status: active' && UFW=1
(( UFW )) && echo "ufw --force enable" >> "$ETC/nft-rollback.sh"
chmod 700 "$ETC/nft-rollback.sh"
cat > /etc/systemd/system/vha-nft.service <<EOF
[Unit]
Description=Blast Radius Zero sandbox machine firewall (table inet vha_sandbox)
Before=network-pre.target docker.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -I $NFT -f $NFT/sandbox.nft
ExecStop=/usr/sbin/nft delete table inet vha_sandbox

[Install]
WantedBy=multi-user.target
EOF
cat > /usr/local/sbin/vha-nft-confirm <<EOF
#!/bin/sh
# Run from a NEW ssh connection: if it runs, the firewall did not lock you out. Cancels the rollback and keeps the table at boot.
systemctl stop vha-nft-rollback.timer vha-nft-rollback.service 2>/dev/null
nft list table inet vha_sandbox >/dev/null 2>&1 || { echo "table inet vha_sandbox is not loaded (the rollback fired?)"; exit 1; }
for t in $OLD; do [ "\$t" = vha_sandbox ] || systemctl disable --quiet "\$t-nft.service" 2>/dev/null; done
systemctl daemon-reload; systemctl enable --quiet vha-nft.service
echo "vha_sandbox firewall CONFIRMED: rollback cancelled, loaded at boot"
EOF
chmod 755 /usr/local/sbin/vha-nft-confirm
systemctl daemon-reload
systemctl stop vha-nft-rollback.timer vha-nft-rollback.service 2>/dev/null || true
# One transaction: the old inet tables out, ours in.
{ for t in $OLD; do [[ $t == vha_sandbox ]] || echo "delete table inet $t"; done; echo "include \"$NFT/sandbox.nft\""; } | nft -I "$NFT" -f -
(( UFW )) && { ufw disable >/dev/null; systemctl disable --quiet ufw 2>/dev/null || true; note "ufw turned off (this table replaces it)"; }
systemd-run --quiet --unit=vha-nft-rollback --on-active="${ROLLBACK}s" --description="roll back the vha_sandbox firewall" "$ETC/nft-rollback.sh"
note "loaded; the rollback fires in ${ROLLBACK}s"
note ">>> from a NEW ssh connection run:  vha-nft-confirm"
