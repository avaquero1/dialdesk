-- agent: first migration. Runs inside schema "agent" as role svc_agent (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for agent writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
