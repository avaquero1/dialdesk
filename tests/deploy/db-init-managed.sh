#!/usr/bin/env bash
# deploy/db-init.sql the way managed Postgres runs it: the admin is a non-superuser with CREATEROLE that owns the
# database. The dev container's superuser hides every missing right, so this is the check that it works on Vultr.
# Needs Docker. `make db-init-test`.
set -euo pipefail
IMAGE=postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94
NAME=vha-db-init-test-$$
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$NAME" --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=app \
  -v "$PWD/deploy/db-init.sql:/db-init.sql:ro" "$IMAGE" >/dev/null
# The image's first start runs a temporary server on the socket only: TCP answers once the real one is up.
for _ in $(seq 120); do docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d app && break; sleep 0.5; done
docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U postgres -d app

as() { local user=$1; shift; docker exec -i "$NAME" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U "$user" -d app "$@"; }
as postgres -c 'CREATE ROLE vha_admin LOGIN CREATEROLE NOSUPERUSER' -c 'ALTER DATABASE app OWNER TO vha_admin'

envs=()
for s in ACCOUNTS BOARD AGENT RUNNER MARKETS CONNECTIONS MODELS AUDIT; do envs+=(-e "DB_PASSWORD_$s=test-$s"); done
init() { docker exec -i "${envs[@]}" "$NAME" psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U vha_admin -d app -f /db-init.sql; }
init
init   # safe to run again (a redeploy, or a first run that stopped halfway)

fails=0
check() {   # check <what> <sql> <expected>
  local got; got=$(as postgres -At -c "$2")
  if [[ $got == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$got', wanted '$3'"; fails=$((fails + 1)); fi
}
check 'the admin is no superuser' "select rolsuper from pg_roles where rolname = 'vha_admin'" f
check 'every service schema has its owner' \
  "select count(*) from pg_namespace where (nspname, pg_get_userbyid(nspowner)) in
   (('accounts','svc_accounts'),('board','svc_board'),('agent','svc_agent'),('runner','svc_runner'),
    ('markets','svc_markets'),('connections','svc_connections'),('models','svc_models'),('audit','audit_owner'))" 8
check 'the admin has no rights in a service schema' "select has_schema_privilege('vha_admin', 'accounts', 'USAGE')" f
check 'PUBLIC has no rights in a service schema' "select has_schema_privilege('public', 'accounts', 'USAGE')" f
check 'svc_audit may use the audit schema' "select has_schema_privilege('svc_audit', 'audit', 'USAGE')" t
check 'svc_audit may not create in it' "select has_schema_privilege('svc_audit', 'audit', 'CREATE')" f
check 'audit_owner cannot log in' "select rolcanlogin from pg_roles where rolname = 'audit_owner'" f
check "audit_owner's new tables go to svc_audit" \
  "select count(*) from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'audit' and pg_get_userbyid(d.defaclrole) = 'audit_owner' and d.defaclobjtype = 'r'" 1
check 'a role can connect only by name' "select has_database_privilege('public', 'app', 'CONNECT')" f
((fails == 0)) || { echo "db-init-managed: $fails failed"; exit 1; }
echo 'db-init-managed: passed, run twice as a non-superuser admin'
