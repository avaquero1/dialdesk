#!/usr/bin/env bash
# The web app's local stack, beside (never on) vha-dev's ports:
#   Compose project vha-web: Postgres :55491, Valkey :56491, Caddy http://localhost:8490 (serves web/dist, policy on)
#   real: edge :18480, accounts :18481, board :18482, agent :18483, audit :18488 (Postgres + Valkey; audit chains and signs
#   the real log)
#   fakes: runner :18484, markets :18485, connections :18486, models :18487
# The agent is the real one on the models fake (canned chat steps, no model calls), so first-visit picks, proposals
# and set_look come from the agent's own code in the browser tests.
#
#   web/dev/stack.sh up | down | status       (needs `make dev-secrets` and `npx tsx web/build.ts` first)
# Logs and pids: web/dev/.run/
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
run="$here/.run"
export WEB_PORT="${WEB_PORT:-8490}" WEB_PG_PORT="${WEB_PG_PORT:-55491}" WEB_VALKEY_PORT="${WEB_VALKEY_PORT:-56491}"
compose() { docker compose -f "$here/compose.yml" --env-file "$repo/.env" "$@"; }

declare -A PORT=([edge]=18480 [accounts]=18481 [board]=18482 [agent]=18483 [runner]=18484 [markets]=18485 [connections]=18486 [models]=18487 [audit]=18488)
REAL="edge accounts board agent audit"
FAKE="runner markets connections models"
export WEB_EDGE="127.0.0.1:${PORT[edge]}"

envs() {
  set -a; . "$repo/.env"; set +a
  local s c S C
  for s in "${!PORT[@]}"; do
    S=${s^^}
    export "${S}_PORT=${PORT[$s]}"
    for c in "${!PORT[@]}"; do C=${c^^}; export "${S}_URL_${C}=http://127.0.0.1:${PORT[$c]}"; done
    local db="${S}_DATABASE_URL" vk="${S}_VALKEY_URL"
    [ -n "${!db:-}" ] && export "$db=${!db/127.0.0.1:55432/127.0.0.1:$WEB_PG_PORT}"
    [ -n "${!vk:-}" ] && export "$vk=${!vk/127.0.0.1:56379/127.0.0.1:$WEB_VALKEY_PORT}"
  done
  export EDGE_ALLOWED_ORIGINS="http://localhost:$WEB_PORT" EDGE_TRUST_PROXY=1 EDGE_HOST=127.0.0.1
  export BOARD_SCREENSHOT_DIR="$run/screenshots" AUDIT_HEADS_DIR="$run/audit-heads"
}

start() {
  local s=$1 fake=$2 S=${1^^}
  # exec: the pid file holds node itself, so `down` stops the process that holds the port (not a wrapper shell).
  ( cd "$repo" && exec env "${S}_FAKE=$fake" node --import tsx "services/$s/src/main.ts" ) > "$run/$s.log" 2>&1 < /dev/null &
  echo $! > "$run/$s.pid"
}

wait_health() {
  local s p
  for s in "${!PORT[@]}"; do
    p=${PORT[$s]}
    for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$p/health" > /dev/null 2>&1 && break; sleep 0.5; done
    curl -fsS "http://127.0.0.1:$p/health" > /dev/null 2>&1 && alive "$s" || { echo "$s did not start (see $run/$s.log)"; tail -5 "$run/$s.log"; exit 1; }
  done
}

stop_services() {
  local f pid p
  for f in "$run"/*.pid; do
    [ -e "$f" ] || continue
    pid=$(cat "$f"); rm -f "$f"
    kill "$pid" 2> /dev/null || continue
    for _ in $(seq 1 40); do kill -0 "$pid" 2> /dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2> /dev/null || true
  done
  # Wait for every port to free (a loaded box can take a while to close a socket). A port still held after that is a
  # service from elsewhere: refuse rather than start beside it (EADDRINUSE) or test against it.
  for p in "${PORT[@]}"; do
    for _ in $(seq 1 60); do listening "$p" || break; sleep 0.5; done
    if listening "$p"; then echo "port $p is still in use; stop that process first"; exit 1; fi
  done
}

listening() { [ -n "$(ss -Hltn "sport = :$1" 2> /dev/null)" ]; }

# The service this run started is still alive: /health could otherwise come from a leftover on the same port.
alive() {
  local pid
  pid=$(cat "$run/$1.pid" 2> /dev/null) || return 1
  kill -0 "$pid" 2> /dev/null
}

case "${1:-}" in
  up)
    [ -f "$repo/.env" ] || { echo "run make dev-secrets first"; exit 1; }
    [ -f "$repo/web/dist/index.html" ] || { echo "run npx tsx web/build.ts first"; exit 1; }
    mkdir -p "$run"; stop_services
    # Postgres is fresh each time (tmpfs), so its write-once signed heads must be too.
    rm -rf "${run:?}/audit-heads"
    compose up -d --wait postgres valkey
    envs
    for s in $FAKE; do start "$s" 1; done
    for s in $REAL; do start "$s" 0; done
    wait_health
    compose up -d caddy
    for _ in $(seq 1 40); do curl -fsS "http://localhost:$WEB_PORT/" > /dev/null 2>&1 && break; sleep 0.5; done
    curl -fsS -o /dev/null "http://localhost:$WEB_PORT/" && echo "up: http://localhost:$WEB_PORT/ (real: $REAL; fakes: $FAKE)"
    ;;
  down)
    stop_services
    compose down -v --remove-orphans
    ;;
  status)
    for s in "${!PORT[@]}"; do printf '%-12s %s\n' "$s" "$(curl -fsS "http://127.0.0.1:${PORT[$s]}/health" 2> /dev/null || echo DOWN)"; done
    ;;
  *) echo "usage: $0 up|down|status"; exit 2 ;;
esac
