-- models: first migration. Runs inside schema "models" as role svc_models (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for models writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
