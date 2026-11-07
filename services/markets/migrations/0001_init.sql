-- markets: first migration. Runs inside schema "markets" as role svc_markets (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for markets writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
