-- audit: what svc_audit may do in schema "audit". Runs as audit_owner, the owner of the schema and its tables
-- (see deploy/db-init.sql), never as svc_audit, which may only SELECT and INSERT.
--
-- db-init.sql's default privileges already give svc_audit SELECT and INSERT on every table audit_owner makes here.
-- This file says so explicitly for the log's three tables, and takes INSERT on _migrations back: the service reads
-- it at start to check nothing is pending, but it must not mark a migration as applied.

grant select, insert on chain, heads, head_pushes to svc_audit;
revoke all on _migrations from svc_audit;
grant select on _migrations to svc_audit;
