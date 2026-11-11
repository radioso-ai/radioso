-- A voice session an operator starts from the dashboard's Test Chat runs its turns on the private
-- test it was started from, never as a conversation (#1536). The session's row says so: the test's
-- id and the account the dashboard session acted for, beside the expiry the start already records,
-- which here bounds every turn rather than only the first.
--
-- Both are plain values, not foreign keys. A test can be deleted while its call still runs, and the
-- row must then keep saying that the session belongs to a test, so its turns are refused instead of
-- running as a conversation on the agent's published release.
--
-- Such a row never binds a conversation, never names a website visitor and always has an expiry;
-- the CHECK holds that, so even a turn that reached the conversation path by mistake could not bind
-- one. Existing rows have no test and are unchanged.
--
-- Locks. Adding nullable columns and a CHECK takes ACCESS EXCLUSIVE on voice_sessions, a small
-- table, and validates the CHECK by reading it. The wait is bounded to three seconds; a migration
-- that cannot get the lock rolls back whole and is safe to run again.
SET LOCAL lock_timeout = '3s';

ALTER TABLE voice_sessions
  ADD COLUMN test_execution_id UUID,
  ADD COLUMN started_account_id UUID,
  ADD CONSTRAINT voice_sessions_test_chat_session
    CHECK (
      test_execution_id IS NULL
      OR (conversation_id IS NULL AND started_public_session_id IS NULL AND start_expires_at IS NOT NULL)
    ),
  ADD CONSTRAINT voice_sessions_started_account_is_test_chat
    CHECK (started_account_id IS NULL OR test_execution_id IS NOT NULL);
