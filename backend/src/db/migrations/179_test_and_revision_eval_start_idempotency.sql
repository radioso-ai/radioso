-- A retried or double-clicked "start" request must return the execution/run it already
-- created rather than dispatching a second one. The client supplies the fence, mirroring
-- the idempotency_key already used to fence agent_publications.
ALTER TABLE agent_test_executions
  ADD COLUMN idempotency_key TEXT;

UPDATE agent_test_executions SET idempotency_key = id::text WHERE idempotency_key IS NULL;

ALTER TABLE agent_test_executions
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX agent_test_executions_idempotency_key_key
  ON agent_test_executions (workspace_id, agent_id, idempotency_key);

ALTER TABLE revision_eval_runs
  ADD COLUMN idempotency_key TEXT;

UPDATE revision_eval_runs SET idempotency_key = id::text WHERE idempotency_key IS NULL;

ALTER TABLE revision_eval_runs
  ALTER COLUMN idempotency_key SET NOT NULL;

CREATE UNIQUE INDEX revision_eval_runs_idempotency_key_key
  ON revision_eval_runs (workspace_id, agent_id, idempotency_key);
