-- Ray's proposal target types are assembled at boot from the first-party list and the types
-- application modules contribute (#1138), and the application narrows every stored row against that
-- set. A list here would refuse a contributed type, and rewriting it for the next first-party type
-- would fail on any contributed row already stored, so the column keeps the structural rule every
-- target type follows: a lowercase identifier.
--
-- Locks. Migrations run at API boot while the previous revision still serves, and the whole file
-- is one transaction, so every lock it takes is held until it commits. Dropping the old check takes
-- ACCESS EXCLUSIVE on `copilot_proposals`, which only Ray's panel and the operator MCP read and
-- write. The new check is added NOT VALID, a catalog change that binds new rows at once, and then
-- validated, which reads `target_type` on every stored proposal under the lock the drop already
-- holds; every row already satisfies it, since each first-party type is a lowercase identifier.
-- The wait for the lock is bounded to three seconds; a deploy that hits it rolls back and a retry
-- is safe.
SET LOCAL lock_timeout = '3s';

ALTER TABLE copilot_proposals
  DROP CONSTRAINT copilot_proposals_target_type_check;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_target_type_check
  CHECK (target_type ~ '^[a-z][a-z0-9_]{0,62}$') NOT VALID;

ALTER TABLE copilot_proposals
  VALIDATE CONSTRAINT copilot_proposals_target_type_check;
