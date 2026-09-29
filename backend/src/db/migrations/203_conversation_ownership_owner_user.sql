-- The teammate who owns a human-owned conversation. `owner_account_id` names the organisation the
-- workspace belongs to, which every teammate shares, so it cannot tell two people apart; this names
-- the person. Null while a handoff waits to be claimed, after a hand-back, and on rows claimed before
-- this column existed (the acting user of those claims is unknowable, so there is no backfill).
--
-- `ON DELETE SET NULL` keeps a conversation human-owned when its owner's user is deleted; reads then
-- fall back to the label stored in `owner_display_name` at claim time.
--
-- No index. Reads join `users` from the ownership row, never the other way round. Deleting a
-- user makes Postgres scan this table for rows to null; user deletion is rare, so that scan is
-- accepted rather than paying for an index on every ownership write.
ALTER TABLE conversation_ownership
  ADD COLUMN IF NOT EXISTS owner_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;
