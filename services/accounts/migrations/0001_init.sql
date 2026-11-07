-- accounts: first migration. Runs inside schema "accounts" as role svc_accounts (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for accounts writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
