-- When the board was last read by its owner (edge's getBoard). runner's scheduler asks for it (lastOpened) and runs
-- only boards opened recently, so boards nobody looks at don't use the sandbox machine. Null: never opened.
alter table boards add column last_opened_at timestamptz;
