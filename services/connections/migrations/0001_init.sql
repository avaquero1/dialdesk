-- connections: first migration. Runs inside schema "connections" as role svc_connections (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for connections writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
