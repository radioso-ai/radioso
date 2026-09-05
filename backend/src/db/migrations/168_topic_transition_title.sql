-- Transition history keeps the topic title visible at the time of the transition.
-- The repository reads this copy when hydrating old runs, so later reactivation and
-- renaming cannot rewrite what an earlier census reported.

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '25s';

ALTER TABLE topic_transitions
  ADD COLUMN topic_title TEXT;

UPDATE topic_transitions
SET topic_title = topics.title
FROM topics
WHERE topics.workspace_id = topic_transitions.workspace_id
  AND topics.id = topic_transitions.topic_id;

ALTER TABLE topic_transitions
  ALTER COLUMN topic_title SET NOT NULL;
