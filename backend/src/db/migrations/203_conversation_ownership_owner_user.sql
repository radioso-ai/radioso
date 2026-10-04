-- The teammate who owns a human-owned conversation. `owner_account_id` names the organisation the
-- workspace belongs to, which every teammate shares, so it cannot tell two people apart; this names
-- the person, and it is the one test for "claimed". Null while a handoff waits to be claimed, after a
-- hand-back, and once the owner's user is deleted.
--
-- `ON DELETE SET NULL` keeps a conversation human-owned when its owner's user is deleted: the AI
-- stays out of it, and the conversation waits for a teammate to claim it again.
--
-- No index. Reads join `users` from the ownership row, never the other way round. Deleting a
-- user makes Postgres scan this table for rows to null; user deletion is rare, so that scan is
-- accepted rather than paying for an index on every ownership write.
ALTER TABLE conversation_ownership
  ADD COLUMN IF NOT EXISTS owner_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL;

-- Conversations claimed before this column existed name only the organisation, so the teammate who
-- claimed each one is unknowable, and a claim nobody can be matched to would lock every teammate out
-- of it. Release them to "awaiting a human": the conversation stays human-owned (the AI stays out of
-- it) and the next teammate to act on it claims it.
UPDATE conversation_ownership
   SET owner_account_id = NULL,
       owner_display_name = NULL,
       taken_over_at = NULL,
       version = version + 1,
       updated_at = now()
 WHERE state = 'human_owned'
   AND owner_user_id IS NULL
   AND owner_account_id IS NOT NULL;
