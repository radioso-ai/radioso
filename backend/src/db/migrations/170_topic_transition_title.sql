-- New transition rows capture the topic title at write time. Existing transitions
-- remain null because their original title was never recorded; run hydration falls
-- back to the topic's current title for those rows.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '25s';

ALTER TABLE topic_transitions
  ADD COLUMN topic_title TEXT;
