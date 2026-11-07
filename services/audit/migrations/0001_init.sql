-- audit: first migration. Runs inside schema "audit" as role svc_audit (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for audit writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
