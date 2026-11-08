-- The per-account cap on "Refresh now" (RUN_RULES.refreshesPerAccountHour) counts an account's manual refreshes of the
-- last hour on every tap. Only refresh rows are counted, so the index holds only those.
create index run_requests_account_refresh on run_requests (account_id, requested_at) where reason = 'refresh';
