-- A census run records one identity classification per topic. Historical duplicate
-- rows can exist from repeated dissolution writes, so retain the first recorded row
-- before enforcing the invariant for future writes.

DELETE FROM topic_transitions AS duplicate
USING topic_transitions AS keeper
WHERE duplicate.run_id = keeper.run_id
  AND duplicate.topic_id = keeper.topic_id
  AND (duplicate.created_at, duplicate.id) > (keeper.created_at, keeper.id);

CREATE UNIQUE INDEX idx_topic_transitions_run_topic_unique
  ON topic_transitions (run_id, topic_id);
