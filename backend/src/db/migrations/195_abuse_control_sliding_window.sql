-- Admission weighs the window that just expired against the one now running, so a caller cannot
-- spend a whole budget at the end of one window and the whole budget again at the start of the
-- next. The column holds the expiring window's count; it is 0 when the last window ended more
-- than one window ago, because a count that old no longer overlaps anything.
ALTER TABLE abuse_control_entries
  ADD COLUMN previous_attempt_count INTEGER NOT NULL DEFAULT 0;
