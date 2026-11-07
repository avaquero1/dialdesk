-- agent: a turn's tap-to-pick answers (ChatTurn.picks, written by code), so the first-visit chips survive a reload.
-- null when the turn has none.
alter table turns add column picks jsonb;
