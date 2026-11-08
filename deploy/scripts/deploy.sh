#!/usr/bin/env bash
# Deploys the control VM (deploy/compose.control.yml): caddy, the 9 services and Valkey, behind its host firewall.
#
#   deploy.sh push [control options]      from a dev PC: copy HEAD to control and run `control` there (see below)
#   deploy.sh control [options]           on control, as root, from a copy of the repo (push makes it)
#   deploy.sh sandbox                     from a dev PC: the sandbox machine's part (the hook for S1.3.1's script)
#
# Control options:
#   --dry-run               print every step, every command and every file it would write; change nothing
#                           (no root, Docker or nft needed, so it runs anywhere)
#   --env-file FILE         the machine's settings (default /etc/vha/deploy.env; see deploy/deploy.env.example)
#   --enforce-egress        the egress table drops what isn't on a container's list (read the would-drop log first:
#                           journalctl -k | grep vha-egress-would-drop)
#   --log-only-egress       back to log-only. Without either flag the installed mode stays; a new machine starts log-only
#   --rollback-seconds N    how long a new firewall waits for vha-nft-confirm before it is taken out again (300)
#   --rotate                new tokens and passwords (prod-secrets.ts --rotate; db-init.sql then sets them)
#
# The control steps, in order (each is safe to run again):
#    1 checks       root, Docker, Compose, nft, the settings and the input files
#    2 images       vha/app:<rev> and vha/caddy:<rev>, built here from the copy (no registry)
#    3 firewall     deploy/nftables/control.nft as vha-nft.service, loaded live with a timed rollback; ufw off.
#                   It waits for `vha-nft-confirm` from a NEW ssh connection (push runs it), or the rollback puts the
#                   old table back after --rollback-seconds, so a mistake can't lock SSH out
#    4 egress       the egress table (egress-hosts.ts in the app image), egress-refresh.sh and its 3-minute timer
#    5 buckets      s3-bucket.ts in the app image (skipped without S3_ENDPOINT: the services keep local folders)
#    6 secrets      prod-secrets.ts as root in the app image, into /etc/vha/secrets
#    7 database     deploy/db-init.sql on Managed Postgres over TLS, with the passwords from postgres/env
#    8 services     docker compose up -d --wait
#    9 health       every container healthy, https://<VHA_HOSTNAME>/ through Caddy, the egress sets filled, the timer,
#                   the would-drop count, and runner's line to sandbox-manager
#   10 sandbox      what `deploy.sh sandbox` does next (the sandbox machine is set up from the dev PC)
#
# push and sandbox read the machines from the environment, never from the repo:
#   VHA_CONTROL_HOST=root@<control>  VHA_SANDBOX_HOST=root@<sandbox, VPC address>  VHA_SSH_KEY=<key file>
#   VHA_SANDBOX_VIA_CONTROL=1 (default): reach the sandbox machine through control (ssh -J); 0: directly
set -euo pipefail

ETC=/etc/vha
NFT_DIR=$ETC/nft
SECRETS=$ETC/secrets
INPUTS=$ETC/inputs
STATE=/var/lib/vha
UNITS=/etc/systemd/system
SBIN=/usr/local/sbin
PG_IMAGE=postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94
SANDBOX_CALLERS_PATH=$ETC/sandbox-manager.env   # where the sandbox machine reads runner's token hash (step 10)
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

DRY=0; ENV_FILE=$ETC/deploy.env; EGRESS_MODE=""; ROLLBACK=300; ROTATE=0
STEP=0; STEPS=10

say() { printf '%s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit "${2:-1}"; }
step() { STEP=$((STEP + 1)); printf '\n== %d/%d %s\n' "$STEP" "$STEPS" "$*"; }
quote() { local out="" a; for a in "$@"; do out+="$(printf '%q' "$a") "; done; printf '%s' "${out% }"; }
# Every change goes through run / run_to / put, so --dry-run prints it instead.
run() { if ((DRY)); then say "   + $(quote "$@")"; else "$@"; fi; }
run_to() { local f=$1; shift; if ((DRY)); then say "   + $(quote "$@") > $f"; else "$@" > "$f.new"; mv "$f.new" "$f"; fi; }
# put FILE MODE: write stdin to FILE atomically (dry run: show it). Only for files that hold no secret.
put() {
  local f=$1 mode=$2
  if ((DRY)); then say "   write $f (mode $mode):"; sed 's/^/   | /'; return; fi
  install -d -m 0755 "$(dirname "$f")"
  cat > "$f.new"; chmod "$mode" "$f.new"; mv "$f.new" "$f"
}

# --- settings: KEY=value lines, read as data (never sourced). The same file is Compose's and the containers' --env-file.
declare -A CFG=()
read_env() {
  local line k
  [[ -r $1 ]] || die "no settings file at $1 (copy deploy/deploy.env.example there and fill it in)" 2
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || die "$1: not a KEY=value line: ${line%%=*}" 2
    k=${BASH_REMATCH[1]}; CFG[$k]=${BASH_REMATCH[2]}
  done < "$1"
}
cfg() { printf '%s' "${CFG[$1]:-${2:-}}"; }
need() {
  local k missing=()
  for k in "$@"; do [[ -n ${CFG[$k]:-} ]] || missing+=("$k"); done
  ((${#missing[@]} == 0)) || die "$ENV_FILE: not set: ${missing[*]}" 2
}
ipv4() { [[ $2 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || die "$1 must be an IPv4 address" 2; }
ifname() { [[ $2 =~ ^[a-z][a-z0-9]{1,14}$ ]] || die "$1 must be an interface name like enp1s0" 2; }
# An input file the containers read: it must sit under $INPUTS (the only folder mounted into them).
input() {
  local k=$1 v=${CFG[$1]:-}
  [[ -z $v ]] && return 0
  [[ $v == "$INPUTS"/* && $v != *..* ]] || die "$k must be a file under $INPUTS/ (got another path)" 2
  if ((DRY)); then note "input $k: $v"; elif [[ -s $v ]]; then note "input $k: present"; else note "input $k: MISSING ($v): prod-secrets writes an empty file and names it"; fi
}

compose() {
  local args=(docker compose -p vha-control -f "$SRC/deploy/compose.control.yml" --env-file "$ENV_FILE" --env-file "$ETC/release.env")
  [[ $(cfg VHA_LOCAL_DB 0) == 1 ]] && args+=(--profile local-db)
  run "${args[@]}" "$@"
}
in_app() {   # a one-off container from the app image, with the settings and the input files (read only)
  run docker run --rm --read-only --tmpfs /tmp:size=64m --security-opt no-new-privileges --env-file "$ENV_FILE" \
    -v "$INPUTS:$INPUTS:ro" "$@"
}

# ---------------------------------------------------------------------------------------------------------- control
control_vars() {   # control.nft's addresses, from the settings (example: deploy/nftables/example-control-vars.nft)
  local p; p=$(cfg EGRESS_PREFIX 172.31.250)
  cat <<EOF
# Written by deploy/scripts/deploy.sh from $ENV_FILE. Run deploy.sh again to change it.
define PUBLIC_IF = "$(cfg PUBLIC_IF)"
define VPC_IF = "$(cfg VPC_IF)"
define ADMIN_IP = $(cfg ADMIN_IP)
define SANDBOX_VPC_IP = $(cfg SANDBOX_VPC_IP)
define PG_IP = $PG_IP
define PG_PORT = $PG_PORT
define CADDY_IP = $p.10
define MODELS_IP = $p.11
define MARKETS_IP = $p.12
define CONNECTIONS_IP = $p.13
define RUNNER_IP = $p.14
define AUDIT_IP = $p.15
define BOARD_IP = $p.16
define ACCOUNTS_IP = $p.17
define AGENT_IP = $p.18
EOF
}

nft_unit() {
  cat <<EOF
# Written by deploy/scripts/deploy.sh. Loads control's host firewall (deploy/nftables/control.nft) at boot, before
# Docker. Enabled by vha-nft-confirm once a new ssh connection has shown that SSH still works.
[Unit]
Description=vha: control's host firewall (table inet vha)
Wants=network-pre.target
Before=network-pre.target docker.service vha-egress-refresh.service
DefaultDependencies=no
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -I $NFT_DIR -f $NFT_DIR/control.nft
ExecReload=/usr/sbin/nft -I $NFT_DIR -f $NFT_DIR/control.nft

[Install]
WantedBy=multi-user.target
EOF
}

confirm_script() {
  cat <<EOF
#!/bin/sh
# Written by deploy/scripts/deploy.sh. Run it from a NEW ssh connection after a firewall change: that it runs at all
# shows SSH still works. It stops the rollback and loads the table at boot from now on.
set -e
systemctl stop vha-nft-rollback.timer 2>/dev/null || true
systemctl enable --quiet vha-nft.service
mkdir -p /run/vha
date +%s > /run/vha/nft-confirmed
echo "vha-nft: confirmed. The rollback is off and vha-nft.service loads the table at boot."
EOF
}

rollback_script() {
  cat <<EOF
#!/bin/sh
# Written by deploy/scripts/deploy.sh. Runs when vha-nft-confirm didn't come in time: puts control's firewall back as
# it was before the last load (the previous files, or no table inet vha at all) and turns ufw back on if it was on.
nft delete table inet vha 2>/dev/null || true
if [ -d $NFT_DIR.prev ]; then
  rm -rf $NFT_DIR && mv $NFT_DIR.prev $NFT_DIR && nft -I $NFT_DIR -f $NFT_DIR/control.nft || true
fi
if [ -f $STATE/ufw-was-active ]; then ufw --force enable && rm -f $STATE/ufw-was-active; fi
mkdir -p /run/vha
date +%s > /run/vha/nft-rolled-back
echo "vha-nft: rolled back (no vha-nft-confirm in time)"
EOF
}

control_main() {
  STEPS=10
  ((DRY)) && say "deploy: DRY RUN. Nothing is changed; every step, command and file is printed."
  read_env "$ENV_FILE"
  SRC=$(cd "$SCRIPT_DIR/../.." && pwd)

  step "checks"
  if ((DRY)); then
    note "would check: root, docker, docker compose, nft, systemd-run, curl"
  else
    [[ $(id -u) -eq 0 ]] || die "run as root (or pass --dry-run)" 2
    local t; for t in docker nft systemctl systemd-run curl getent; do command -v "$t" >/dev/null || die "$t is missing" 2; done
    docker compose version >/dev/null || die "docker compose is missing" 2
  fi
  [[ -f $SRC/deploy/compose.control.yml && -f $SRC/deploy/nftables/control.nft ]] || die "run from a copy of the repo" 2
  if [[ -f $SRC/.vha-rev ]]; then REV=$(cat "$SRC/.vha-rev"); else REV=$(git -C "$SRC" rev-parse --short=12 HEAD 2>/dev/null) || die "no .vha-rev and no git: use deploy.sh push" 2; fi
  [[ $REV =~ ^[0-9a-f]{7,40}$ ]] || die "bad revision $REV" 2
  need VHA_HOSTNAME PUBLIC_IF VPC_IF ADMIN_IP SANDBOX_VPC_IP
  ifname PUBLIC_IF "$(cfg PUBLIC_IF)"; ifname VPC_IF "$(cfg VPC_IF)"
  ipv4 ADMIN_IP "$(cfg ADMIN_IP)"; ipv4 SANDBOX_VPC_IP "$(cfg SANDBOX_VPC_IP)"
  [[ $(cfg EGRESS_PREFIX 172.31.250) =~ ^172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}$ ]] || die "EGRESS_PREFIX must look like 172.31.250" 2
  [[ $(cfg VHA_HOSTNAME) =~ ^[a-z0-9.-]+$ ]] || die "VHA_HOSTNAME must be a host name" 2
  grep -qxF "https://$(cfg VHA_HOSTNAME) {" "$SRC/deploy/Caddyfile" || die "VHA_HOSTNAME isn't the site in deploy/Caddyfile" 2
  LOCAL_DB=$(cfg VHA_LOCAL_DB 0)
  if [[ $LOCAL_DB == 1 ]]; then
    note "database: the fallback Postgres container on control (VHA_LOCAL_DB=1)"
    PG_IP=127.0.0.1; PG_PORT=5432
  else
    need PG_HOST PG_PORT PG_DATABASE PG_ADMIN_USER PG_ADMIN_PASSFILE
    [[ $(cfg PG_PORT) =~ ^[0-9]{2,5}$ ]] || die "PG_PORT must be a port number" 2
    PG_PORT=$(cfg PG_PORT)
    PG_IP=$(cfg PG_IP)
    if [[ -z $PG_IP ]]; then
      if ((DRY)); then PG_IP=10.255.255.254; note "PG_IP not set: would resolve $(cfg PG_HOST) (getent ahostsv4); the dry run shows a placeholder, $PG_IP"
      else PG_IP=$(getent ahostsv4 "$(cfg PG_HOST)" | awk 'NR == 1 { print $1 }'); note "PG_IP: $(cfg PG_HOST) resolves to $PG_IP"; fi
    fi
    ipv4 PG_IP "$PG_IP"
    [[ $(cfg PG_SSLMODE require) =~ ^(require|verify-ca|verify-full)$ ]] || die "PG_SSLMODE must be require, verify-ca or verify-full (never without TLS)" 2
    [[ $PG_IP =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]] || die "PG_IP $PG_IP isn't a VPC (private) address: use the database's VPC host" 2
  fi
  if [[ -n $(cfg S3_ENDPOINT) ]]; then
    need S3_BUCKET_SCREENSHOTS S3_BUCKET_HEADS S3_SCREENSHOTS_CREDENTIALS
    [[ $(cfg S3_ENDPOINT) =~ ^https://[a-z0-9.-]+/?$ ]] || die "S3_ENDPOINT must be https://<host>" 2
  fi
  local k; for k in PG_ADMIN_PASSFILE S3_SCREENSHOTS_CREDENTIALS S3_HEADS_CREDENTIALS VULTR_INFERENCE_KEY_FILE BRAVE_KEY_FILE; do input "$k"; done
  if ((!DRY)) && [[ $LOCAL_DB != 1 && ! -s $(cfg PG_ADMIN_PASSFILE) ]]; then
    die "no database admin pgpass file at $(cfg PG_ADMIN_PASSFILE) (deploy/PROVISION.md, \"What comes back\")" 2
  fi
  note "source $SRC, rev $REV"

  step "images (built here: vha/app:$REV, vha/caddy:$REV)"
  run docker build -f "$SRC/deploy/images/app.Dockerfile" --target app --build-arg "GIT_HASH=$REV" -t "vha/app:$REV" "$SRC"
  run docker build -f "$SRC/deploy/images/app.Dockerfile" --target caddy --build-arg "GIT_HASH=$REV" -t "vha/caddy:$REV" "$SRC"
  printf '# Written by deploy/scripts/deploy.sh: the images Compose runs.\nVHA_TAG=%s\n' "$REV" | put "$ETC/release.env" 0644

  step "firewall (vha-nft.service, timed rollback after ${ROLLBACK}s)"
  firewall
  step "egress table ($(egress_mode_name) mode) and vha-egress-refresh.timer"
  egress
  step "buckets (s3-bucket.ts)"
  if [[ -n $(cfg S3_ENDPOINT) ]]; then
    in_app --user 0:0 --cap-drop ALL "vha/app:$REV" node --import tsx deploy/s3-bucket.ts
  else
    note "no S3_ENDPOINT: skipped (board and audit keep their local folders)"
  fi

  step "secrets (prod-secrets.ts as root, into $SECRETS)"
  local ps=(node --import tsx deploy/prod-secrets.ts --out /out)
  ((ROTATE)) && ps+=(--rotate)
  [[ $LOCAL_DB == 1 ]] && ps+=(--local-db)
  run install -d -m 0700 "$SECRETS"
  # It gives each file to its container's uid: chown needs CHOWN, the 0700 folders FOWNER and DAC_OVERRIDE. No network.
  in_app --user 0:0 --network none --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE \
    -v "$SECRETS:/out" "vha/app:$REV" "${ps[@]}"

  step "database (db-init.sql over TLS)"
  if [[ $LOCAL_DB == 1 ]]; then
    note "VHA_LOCAL_DB=1: the postgres container runs db-init.sql itself when its volume is new"
  else
    # The admin password stays in its pgpass file (PG_ADMIN_PASSFILE); the services' passwords come from postgres/env
    # (sourced inside the container). Nothing secret is on a command line or in `docker inspect`.
    run docker run --rm --read-only --security-opt no-new-privileges --cap-drop ALL --user 0:0 --entrypoint sh \
      -e "PGHOST=$(cfg PG_HOST)" -e "PGPORT=$PG_PORT" -e "PGDATABASE=$(cfg PG_DATABASE)" -e "PGUSER=$(cfg PG_ADMIN_USER)" \
      -e "PGSSLMODE=$(cfg PG_SSLMODE require)" -e PGPASSFILE=/run/pg/pgpass -e PGCONNECT_TIMEOUT=10 \
      -v "$(cfg PG_ADMIN_PASSFILE):/run/pg/pgpass:ro" -v "$SECRETS/postgres/env:/run/pg/env:ro" \
      -v "$SRC/deploy/db-init.sql:/run/pg/db-init.sql:ro" "$PG_IMAGE" \
      -c 'set -a; . /run/pg/env; set +a; exec psql -X -q -v ON_ERROR_STOP=1 -f /run/pg/db-init.sql'
  fi

  step "services (docker compose up --wait)"
  compose config -q
  compose up -d --wait --wait-timeout 300 --remove-orphans

  step "health"
  health

  step "sandbox machine (next: deploy.sh sandbox, from the dev PC)"
  note "runner's token hash is in $SECRETS/sandbox-manager/env. \`deploy.sh sandbox\` copies it to $SANDBOX_CALLERS_PATH"
  note "on the sandbox machine and runs its own setup (deploy/sandbox-host, S1.3.1). runner reaches it at $(cfg SANDBOX_VPC_IP):8200."
  say ""
  if ((DRY)); then say "deploy: dry run done ($STEPS steps), nothing changed"; else say "deploy: control is up at https://$(cfg VHA_HOSTNAME)/ (rev $REV)"; fi
}

egress_mode_name() {
  if [[ -n $EGRESS_MODE ]]; then printf '%s' "$EGRESS_MODE"
  elif ((!DRY)) && cmp -s "$NFT_DIR/control-egress-mode.nft" "$SRC/deploy/nftables/egress-enforce.nft" 2>/dev/null; then printf enforce
  else printf log-only; fi
}

firewall() {
  local stage mode; mode=$(egress_mode_name)
  if ((DRY)); then stage=$NFT_DIR.new; else stage=$(mktemp -d "$ETC/nft.stage.XXXXXX"); fi
  control_vars | put "$stage/control-vars.nft" 0644
  run install -m 0644 "$SRC/deploy/nftables/control.nft" "$SRC/deploy/nftables/egress-log-only.nft" \
    "$SRC/deploy/nftables/egress-enforce.nft" "$stage/"
  run install -m 0644 "$SRC/deploy/nftables/egress-$mode.nft" "$stage/control-egress-mode.nft"
  note "egress mode: $mode"
  run nft -c -I "$stage" -f "$stage/control.nft"

  if ((!DRY)) && systemctl is-enabled -q vha-nft.service 2>/dev/null && nft list table inet vha >/dev/null 2>&1 \
    && cmp -s "$stage/control.nft" "$NFT_DIR/control.nft" && cmp -s "$stage/control-vars.nft" "$NFT_DIR/control-vars.nft" \
    && cmp -s "$stage/control-egress-mode.nft" "$NFT_DIR/control-egress-mode.nft"; then
    note "unchanged and confirmed before: not reloaded"
    rm -rf "${stage:?}"
    return
  fi

  confirm_script | put "$SBIN/vha-nft-confirm" 0755
  rollback_script | put "$SBIN/vha-nft-rollback" 0755
  nft_unit | put "$UNITS/vha-nft.service" 0644
  run systemctl daemon-reload
  # Keep the previous files (and the egress table, so the timer keeps working) for the rollback.
  run rm -rf "$NFT_DIR.prev" /run/vha/nft-confirmed /run/vha/nft-rolled-back
  if ((DRY)) || [[ -d $NFT_DIR ]]; then run cp -a "$NFT_DIR" "$NFT_DIR.prev"; fi
  if ((DRY)) || [[ -f $NFT_DIR/egress-hosts.txt ]]; then run cp -a "$NFT_DIR/egress-hosts.txt" "$stage/"; fi
  run rm -rf "$NFT_DIR"
  run mv "$stage" "$NFT_DIR"
  run systemctl stop vha-nft-rollback.timer 2>/dev/null || true
  run systemctl reset-failed vha-nft-rollback.timer vha-nft-rollback.service 2>/dev/null || true
  run systemd-run --quiet --unit vha-nft-rollback --on-active="${ROLLBACK}s" --timer-property=AccuracySec=1s "$SBIN/vha-nft-rollback"
  run nft -I "$NFT_DIR" -f "$NFT_DIR/control.nft"
  # ufw's own tables would still filter every packet; the rollback turns it back on.
  if ((DRY)); then
    note "if ufw is active: record it in $STATE/ufw-was-active, then"; run ufw disable
  elif command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    install -d -m 0700 "$STATE"; touch "$STATE/ufw-was-active"; ufw disable >/dev/null; note "ufw: turned off"
  fi
  say "vha-nft: waiting for confirm: run vha-nft-confirm from a NEW ssh connection within ${ROLLBACK}s"
  if ((DRY)); then note "(the dry run doesn't wait)"; return; fi
  local i
  for ((i = 0; i < ROLLBACK + 5; i += 2)); do
    [[ -f /run/vha/nft-confirmed ]] && { note "confirmed: SSH works, vha-nft.service is enabled"; return; }
    [[ -f /run/vha/nft-rolled-back ]] && break
    sleep 2
  done
  die "no vha-nft-confirm in ${ROLLBACK}s: the firewall was rolled back. Fix it and run deploy.sh again."
}

egress() {
  run_to "$NFT_DIR/egress-hosts.txt" docker run --rm --network none --read-only --tmpfs /tmp:size=64m --cap-drop ALL \
    --security-opt no-new-privileges --env-file "$ENV_FILE" "vha/app:$REV" node --import tsx deploy/egress-hosts.ts
  run install -m 0755 "$SRC/deploy/nftables/egress-refresh.sh" "$NFT_DIR/egress-refresh.sh"
  run install -m 0644 "$SRC/deploy/nftables/vha-egress-refresh.service" "$SRC/deploy/nftables/vha-egress-refresh.timer" "$UNITS/"
  run systemctl daemon-reload
  run "$NFT_DIR/egress-refresh.sh" --check
  run systemctl start vha-egress-refresh.service
  run systemctl enable --now vha-egress-refresh.timer
  if [[ $(egress_mode_name) == log-only ]]; then
    note "log-only: calls off a container's list are logged and let through. Before --enforce-egress, read"
    note "journalctl -k | grep vha-egress-would-drop and add any CDN redirect hosts to deploy/egress-hosts.ts."
  fi
}

health() {
  local host; host=$(cfg VHA_HOSTNAME)
  compose ps --format '{{.Service}} {{.State}} {{.Health}}'
  if ((DRY)); then
    note "would check: every container healthy (compose --wait), then https://$host/ through Caddy (200 and its CSP)"
    run curl -fsS --retry 24 --retry-delay 5 --retry-all-errors --resolve "$host:443:127.0.0.1" -o /dev/null -D - "https://$host/"
    run nft list set inet vha allow_models
    run systemctl is-active vha-egress-refresh.timer
    note "would count vha-egress-would-drop lines in journalctl -k (last hour)"
    compose exec -T runner wget -q -T 5 -O /dev/null "http://$(cfg SANDBOX_VPC_IP):8200/health"
    return
  fi
  local bad; bad=$(compose ps --format '{{.Service}} {{.Health}}' | awk '$2 != "healthy" { print $1 }')
  [[ -z $bad ]] || die "not healthy: $bad"
  note "every container healthy"
  local headers
  headers=$(curl -fsS --retry 24 --retry-delay 5 --retry-all-errors --resolve "$host:443:127.0.0.1" -o /dev/null -D - "https://$host/") \
    || die "https://$host/ doesn't answer through Caddy: does the A record point here, and is 443 open? (docker logs vha-control-caddy-1)"
  grep -qi '^content-security-policy:' <<< "$headers" || die "https://$host/ answers without its Content-Security-Policy"
  note "https://$host/: 200, with its CSP"
  local n; n=$(nft -j list set inet vha allow_models | grep -o '"elem"' | wc -l)
  ((n > 0)) || die "allow_models is empty: did egress-refresh run? (journalctl -u vha-egress-refresh)"
  note "egress sets filled; timer $(systemctl is-active vha-egress-refresh.timer)"
  note "would-drop lines in the last hour: $(journalctl -k --since -1h 2>/dev/null | grep -c vha-egress-would-drop || true)"
  if compose exec -T runner wget -q -T 5 -O /dev/null "http://$(cfg SANDBOX_VPC_IP):8200/health"; then
    note "runner reaches sandbox-manager at $(cfg SANDBOX_VPC_IP):8200"
  else
    note "WARNING: runner can't reach sandbox-manager at $(cfg SANDBOX_VPC_IP):8200 yet (set up the sandbox machine: deploy.sh sandbox)"
  fi
}

# ---------------------------------------------------------------------------------------------------------- dev PC
SSH_OPTS=()
ssh_setup() {
  local key=${VHA_SSH_KEY:?set VHA_SSH_KEY=<key file>}
  # ControlPath=none: every call is a NEW connection (vha-nft-confirm must prove a fresh login works).
  SSH_OPTS=(-i "$key" -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=30)
}
ssh_control() { run ssh "${SSH_OPTS[@]}" "${VHA_CONTROL_HOST:?set VHA_CONTROL_HOST=root@<control>}" "$@"; }

push_main() {
  STEPS=3
  ssh_setup
  local host=${VHA_CONTROL_HOST:?set VHA_CONTROL_HOST=root@<control>}
  local rev; rev=$(git rev-parse --short=12 HEAD)
  [[ -z $(git status --porcelain --untracked-files=no) ]] || say "push: uncommitted changes are NOT copied (HEAD $rev is)" >&2
  step "copy HEAD ($rev) to control:/opt/vha/src/$rev"
  local unpack="set -e; d=/opt/vha/src/$rev; rm -rf \$d; mkdir -p \$d; tar -x -C \$d; echo $rev > \$d/.vha-rev; ln -sfn \$d /opt/vha/src/current"
  if ((DRY)); then say "   + git archive --format=tar HEAD | ssh $host $(quote "$unpack")"
  else
    # shellcheck disable=SC2029 # $unpack is built here on purpose (its \$d expands on control)
    git archive --format=tar HEAD | ssh "${SSH_OPTS[@]}" "$host" "$unpack"
  fi

  step "run deploy.sh control on control (it waits for vha-nft-confirm; this script sends it over a NEW connection)"
  local args=(); ((DRY)) && args+=(--dry-run)
  args+=("${PASS[@]}")
  local cmd; cmd="cd /opt/vha/src/$rev && deploy/scripts/deploy.sh control $(quote "${args[@]}")"
  if ((DRY)); then say "   + ssh $host $(quote "$cmd")"; say "   + (on \"vha-nft: waiting for confirm\") ssh $host vha-nft-confirm   # a new connection"
  else
    local rc line
    set +e
    # shellcheck disable=SC2029 # the command is meant to expand here
    ssh "${SSH_OPTS[@]}" "$host" "$cmd" | while IFS= read -r line; do
      printf '%s\n' "$line"
      if [[ $line == "vha-nft: waiting for confirm"* ]]; then
        ( sleep 3; ssh "${SSH_OPTS[@]}" "$host" vha-nft-confirm || say "push: the new ssh connection FAILED: the firewall will roll back" >&2 ) &
      fi
    done
    rc=${PIPESTATUS[0]}
    set -e
    wait
    ((rc == 0)) || die "deploy.sh control failed on control (exit $rc)" "$rc"
  fi

  step "next"
  note "the sandbox machine: deploy.sh sandbox (copies runner's token hash and runs its setup)"
}

sandbox_main() {
  STEPS=2
  ssh_setup
  local control=${VHA_CONTROL_HOST:?set VHA_CONTROL_HOST=root@<control>} sbx=${VHA_SANDBOX_HOST:?set VHA_SANDBOX_HOST=root@<sandbox VPC address>}
  local via=()
  [[ ${VHA_SANDBOX_VIA_CONTROL:-1} == 1 ]] && via=(-o "ProxyCommand=ssh $(quote "${SSH_OPTS[@]}") -W %h:%p $control")
  step "copy runner's token hash: control:$SECRETS/sandbox-manager/env -> sandbox:$SANDBOX_CALLERS_PATH (root, 0400)"
  # Through this PC's pipe only: never on this PC's disk, never on a command line.
  local put_cmd="set -e; install -d -m 0755 $ETC; umask 077; cat > $SANDBOX_CALLERS_PATH.new; chmod 0400 $SANDBOX_CALLERS_PATH.new; mv $SANDBOX_CALLERS_PATH.new $SANDBOX_CALLERS_PATH"
  if ((DRY)); then say "   + ssh $control cat $SECRETS/sandbox-manager/env | ssh ${via[*]:+(via control) }$sbx $(quote "$put_cmd")"
  else
    # shellcheck disable=SC2029 # fixed paths, built here on purpose
    ssh "${SSH_OPTS[@]}" "$control" cat "$SECRETS/sandbox-manager/env" | ssh "${SSH_OPTS[@]}" "${via[@]}" "$sbx" "$put_cmd"
  fi

  step "the sandbox machine's own setup (S1.3.1: deploy/sandbox-host)"
  # THE HOOK. S1.3.1's script plugs in here. What it must do with what this script gives it:
  #   - read SANDBOX_MANAGER_CALLERS from $SANDBOX_CALLERS_PATH (runner's token hash, made on control by prod-secrets.ts)
  #     instead of making its own runner token;
  #   - have sandbox-manager listen on the VPC address (SANDBOX_VPC_IP:8200), where runner calls it, and let only
  #     control's VPC address reach that port (sandbox.nft).
  local setup=$SCRIPT_DIR/../sandbox-host/push.sh
  if [[ -x $setup ]]; then
    # It reaches the machine directly (no jump through control yet): andre's address must be allowed SSH there.
    run env "VHA_SANDBOX_HOST=$sbx" "VHA_SANDBOX_SSH_KEY=$VHA_SSH_KEY" "$setup" "${PASS[@]}"
  else
    note "deploy/sandbox-host isn't on this branch yet (S1.3.1). Until it lands, set the sandbox machine up from its"
    note "own branch; it must read $SANDBOX_CALLERS_PATH."
  fi
}

# ---------------------------------------------------------------------------------------------------------- options
CMD=control
case "${1:-}" in control|push|sandbox) CMD=$1; shift ;; esac
PASS=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY=1 ;;
    --env-file) ENV_FILE=${2:?--env-file needs a file}; PASS+=("$1" "$2"); shift ;;
    --enforce-egress) EGRESS_MODE=enforce; PASS+=("$1") ;;
    --log-only-egress) EGRESS_MODE=log-only; PASS+=("$1") ;;
    --rollback-seconds) ROLLBACK=${2:?}
                        if [[ ! $ROLLBACK =~ ^[0-9]+$ ]] || ((ROLLBACK < 60)); then die "--rollback-seconds: 60 or more" 2; fi
                        PASS+=("$1" "$2"); shift ;;
    --rotate) ROTATE=1; PASS+=("$1") ;;
    -h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) if [[ $CMD == sandbox ]]; then PASS+=("$1"); else die "unknown option $1 (deploy.sh --help)" 2; fi ;;
  esac
  shift
done

case $CMD in
  control) control_main ;;
  push) push_main ;;
  sandbox) sandbox_main ;;
esac
