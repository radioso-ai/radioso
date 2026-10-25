-- A user's credential generation (#1497). Password reset and federated recovery advance it in the
-- transaction that revokes the user's sessions and provider links. A password or provider sign-in
-- reads it in the same statement as the proof it validates, then writes its session or provider
-- link only while the user still holds that generation, under a row lock that waits for an
-- in-flight recovery. A sign-in that read the user before a reset committed therefore leaves
-- nothing behind once the reset commits.
--
-- A NOT NULL column with a constant default is a catalog change on PostgreSQL 11 and later:
-- existing rows read the default without a rewrite or scan, and no index is added. The lock wait
-- is bounded to three seconds; a deploy that hits it rolls back whole and a retry is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credential_generation INTEGER NOT NULL DEFAULT 0;
