-- A voice session an operator starts from the dashboard's Test Chat runs its turns on the private
-- test it was started from, never as a conversation (#1536). The session's row says so: the test's
-- id and the account the dashboard session acted for, beside the expiry the start already records,
-- which here bounds every turn rather than only the first. Radioso mints such a session's key in
-- Test Chat's own namespace, so a turn whose row is gone is refused as well.
--
-- Both are plain values, not foreign keys: a test can be deleted while its call still runs, and the
-- row then still names it, so its next turn is refused with the test gone.
--
-- Such a row never names a website visitor, always has an expiry, and never takes a conversation:
-- the CHECK refuses the session binding (`bind`) a conversation's first turn writes. It does not stop
-- that turn itself: on the conversation path chat creates the conversation and its message before
-- the binding, which is why the turn router keeps Test Chat sessions off that path.
--
-- Locks. The columns are added without a default, a catalog change; the CHECKs are added NOT VALID,
-- which skips the scan, and validated after it. The migration runs in one transaction, so the ACCESS
-- EXCLUSIVE lock the column additions take on voice_sessions is held through the validation: one scan
-- of a small table whose new columns are all NULL. The wait for the lock is bounded to three seconds; a
-- migration that cannot get it rolls back whole and is safe to run again.
SET LOCAL lock_timeout = '3s';

ALTER TABLE voice_sessions
  ADD COLUMN test_execution_id UUID,
  ADD COLUMN started_account_id UUID,
  ADD CONSTRAINT voice_sessions_test_chat_session
    CHECK (
      test_execution_id IS NULL
      OR (conversation_id IS NULL AND started_public_session_id IS NULL AND start_expires_at IS NOT NULL)
    ) NOT VALID,
  ADD CONSTRAINT voice_sessions_started_account_is_test_chat
    CHECK (started_account_id IS NULL OR test_execution_id IS NOT NULL) NOT VALID;

ALTER TABLE voice_sessions VALIDATE CONSTRAINT voice_sessions_test_chat_session;
ALTER TABLE voice_sessions VALIDATE CONSTRAINT voice_sessions_started_account_is_test_chat;
