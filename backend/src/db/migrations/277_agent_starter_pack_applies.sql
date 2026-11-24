-- A starter pack apply creates the selected directives and routine in one transaction, and
-- writes this row in that same transaction. A retried request (double click, client retry
-- after a timeout) finds the row its first attempt committed and gets that result back instead
-- of creating the items twice. If the transaction rolls back, the row rolls back with the items,
-- so a retry starts clean. The client supplies the key, as it does for agent publications, test
-- executions, and revision eval runs.
CREATE TABLE agent_starter_pack_applies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  -- SHA-256 of the normalized selected items, so reusing a key for different items is refused.
  request_fingerprint TEXT NOT NULL,
  result JSONB NOT NULL,
  actor_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX agent_starter_pack_applies_idempotency_key_key
  ON agent_starter_pack_applies (workspace_id, agent_id, idempotency_key);
