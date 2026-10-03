-- The last of three steps widening conversation_activity.kind (211, 212): drops the original CHECK, so
-- the validated v2 CHECK alone holds the vocabulary and the email channel's kinds can be written.
--
-- Locks. DROP CONSTRAINT takes ACCESS EXCLUSIVE on conversation_activity for the catalog change only,
-- bounded to a three-second wait as 211 is.
SET LOCAL lock_timeout = '3s';

ALTER TABLE conversation_activity
  DROP CONSTRAINT IF EXISTS conversation_activity_kind_check;
