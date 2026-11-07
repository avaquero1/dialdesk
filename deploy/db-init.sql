-- db-init.sql: roles and schemas for the app database.
--
-- One login role and one schema per service that stores data: accounts, board, agent, runner,
-- markets, connections, models, audit. Role svc_<name> owns schema <name> and sees only it.
-- edge and sandbox-manager store nothing and have no role.
-- audit is the exception: a NOLOGIN role audit_owner owns schema audit and its tables, and
-- svc_audit may only SELECT and INSERT there. So even the audit service can't change, delete,
-- truncate or alter a row of the log, or drop its triggers. audit's migrations run as audit_owner
-- (an admin login that may SET ROLE to it: `npm run migrate -w services/audit`), never as svc_audit.
-- The append-only trigger and the REVOKE from the owner itself are in audit's own migration.
--
-- Runs unchanged on the local container (docker-entrypoint-initdb.d) and on managed Postgres:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/db-init.sql
-- Passwords come from the environment (DB_PASSWORD_<SERVICE>) through psql's \getenv, so they
-- are never in this file. Run it again to rotate passwords: every step is safe to repeat.
-- Needs psql 15 or newer (\getenv) and Postgres 16 or newer (GRANT ... WITH SET).

\set ON_ERROR_STOP on

-- \getenv leaves the variable unchanged when the environment variable is not set,
-- so start each one empty and let the check below catch it.
\set pw_accounts ''
\set pw_board ''
\set pw_agent ''
\set pw_runner ''
\set pw_markets ''
\set pw_connections ''
\set pw_models ''
\set pw_audit ''
\getenv pw_accounts DB_PASSWORD_ACCOUNTS
\getenv pw_board DB_PASSWORD_BOARD
\getenv pw_agent DB_PASSWORD_AGENT
\getenv pw_runner DB_PASSWORD_RUNNER
\getenv pw_markets DB_PASSWORD_MARKETS
\getenv pw_connections DB_PASSWORD_CONNECTIONS
\getenv pw_models DB_PASSWORD_MODELS
\getenv pw_audit DB_PASSWORD_AUDIT

CREATE TEMP TABLE db_init_services (svc text PRIMARY KEY, env text NOT NULL, pw text NOT NULL, owner text);
INSERT INTO db_init_services (svc, env, pw) VALUES
  ('accounts',    'DB_PASSWORD_ACCOUNTS',    :'pw_accounts'),
  ('board',       'DB_PASSWORD_BOARD',       :'pw_board'),
  ('agent',       'DB_PASSWORD_AGENT',       :'pw_agent'),
  ('runner',      'DB_PASSWORD_RUNNER',      :'pw_runner'),
  ('markets',     'DB_PASSWORD_MARKETS',     :'pw_markets'),
  ('connections', 'DB_PASSWORD_CONNECTIONS', :'pw_connections'),
  ('models',      'DB_PASSWORD_MODELS',      :'pw_models'),
  ('audit',       'DB_PASSWORD_AUDIT',       :'pw_audit');
-- Who owns each schema: the service's own login, except audit.
UPDATE db_init_services SET owner = CASE svc WHEN 'audit' THEN 'audit_owner' ELSE 'svc_' || svc END;

-- Fail loudly when a password is missing. (A NULL result leaves missing_passwords unset.)
SELECT string_agg(env, ', ' ORDER BY env) AS missing_passwords FROM db_init_services WHERE pw = '' \gset
\if :{?missing_passwords}
\warn 'db-init: empty or unset:' :missing_passwords
DO $$ BEGIN RAISE EXCEPTION 'db-init: a DB_PASSWORD_* variable is empty or not set'; END $$;
\endif

-- Nobody but the owner uses the public schema, and only the service roles may connect.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database()) \gexec

-- audit's owner: no login, no password. The admin may SET ROLE to it to run audit's migrations.
SELECT
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'audit_owner') THEN 'CREATE ROLE audit_owner' END,
  'ALTER ROLE audit_owner WITH NOLOGIN PASSWORD NULL',
  'GRANT audit_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE'
\gexec

-- Per service: create the role if it is missing, (re)set its password and limits, then the schema.
-- The GRANT ... TO CURRENT_USER lets a non-superuser admin (managed Postgres, which has only
-- CREATEROLE) hand the schema to the role. It gives the admin no privileges of the role.
SELECT
  CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'svc_' || s.svc)
       THEN format('CREATE ROLE %I', 'svc_' || s.svc) END,
  format('ALTER ROLE %I WITH LOGIN CONNECTION LIMIT 5 PASSWORD %L', 'svc_' || s.svc, s.pw),
  format('ALTER ROLE %I SET search_path = %I', 'svc_' || s.svc, s.svc),
  format('GRANT %I TO CURRENT_USER WITH INHERIT FALSE, SET TRUE', 'svc_' || s.svc),
  format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', s.svc, s.owner),
  format('ALTER SCHEMA %I OWNER TO %I', s.svc, s.owner),
  format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', s.svc),
  format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'svc_' || s.svc),
  -- A schema the login doesn't own (audit): it may use it, not create in it, and it may only
  -- SELECT and INSERT on the tables the owner makes there.
  CASE WHEN s.owner <> 'svc_' || s.svc THEN format('GRANT USAGE ON SCHEMA %I TO %I', s.svc, 'svc_' || s.svc) END,
  CASE WHEN s.owner <> 'svc_' || s.svc THEN format('REVOKE CREATE ON SCHEMA %I FROM %I', s.svc, 'svc_' || s.svc) END,
  CASE WHEN s.owner <> 'svc_' || s.svc
       THEN format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT ON TABLES TO %I', s.owner, s.svc, 'svc_' || s.svc) END
FROM db_init_services s
ORDER BY s.svc
\gexec

-- Check: no service role (login or owner) can use another service's schema, each schema has the
-- right owner, and a login that doesn't own its schema can't create in it.
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('%s on %s', r.role, n.svc), ', ') INTO bad
  FROM (SELECT svc, 'svc_' || svc AS role FROM db_init_services
        UNION SELECT svc, owner FROM db_init_services) r
  CROSS JOIN db_init_services n
  WHERE r.svc <> n.svc
    AND (has_schema_privilege(r.role, n.svc, 'USAGE')
         OR has_schema_privilege(r.role, n.svc, 'CREATE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'db-init: a service role can use another schema: %', bad;
  END IF;
  SELECT string_agg(n.svc, ', ') INTO bad
  FROM db_init_services n
  WHERE NOT has_schema_privilege(n.owner, n.svc, 'CREATE')
     OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = n.svc) <> n.owner;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'db-init: a schema has the wrong owner: %', bad;
  END IF;
  SELECT string_agg(n.svc, ', ') INTO bad
  FROM db_init_services n
  WHERE n.owner <> 'svc_' || n.svc
    AND (has_schema_privilege('svc_' || n.svc, n.svc, 'CREATE')
         OR NOT has_schema_privilege('svc_' || n.svc, n.svc, 'USAGE')
         OR (SELECT rolcanlogin FROM pg_roles WHERE rolname = n.owner));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'db-init: a login can create in a schema it does not own, or its owner can log in: %', bad;
  END IF;
END $$;

DROP TABLE db_init_services;
\echo 'db-init: 8 service roles and schemas are ready (audit owned by audit_owner)'
