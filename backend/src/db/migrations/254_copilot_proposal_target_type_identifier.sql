-- Ray's proposal target types are assembled at boot from the first-party list and the types
-- application modules contribute (#1138), and the application narrows every stored row against that
-- set. A list here would refuse a contributed type, and rewriting it for the next first-party type
-- would fail on any contributed row already stored, so the column keeps the structural rule every
-- target type follows: a lowercase identifier.
SET LOCAL lock_timeout = '3s';

ALTER TABLE copilot_proposals
  DROP CONSTRAINT copilot_proposals_target_type_check;

ALTER TABLE copilot_proposals
  ADD CONSTRAINT copilot_proposals_target_type_check
  CHECK (target_type ~ '^[a-z][a-z0-9_]{0,62}$');
