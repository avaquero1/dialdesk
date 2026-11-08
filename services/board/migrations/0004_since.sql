-- "Since you last looked" (N1.2.1): two more result slots per widget. `seen` is the result current at the owner's last
-- read (edge's getBoard); `baseline` is what `seen` was when the current visit began, the previous visit's. A read after
-- a gap of BOARD_VISIT_GAP_S (default 30 min) starts a new visit. Copies of stored results: same checks, same cascade.
alter table results drop constraint results_slot_check;
alter table results add constraint results_slot_check check (slot in ('current', 'previous', 'seen', 'baseline'));
