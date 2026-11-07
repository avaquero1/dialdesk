-- board: first migration. Runs inside schema "board" as role svc_board (see deploy/db-init.sql).
-- Phase 0 creates no tables: the Phase 1 worker for board writes them here (0002_..., 0003_..., never edit an applied file).
select 1;
