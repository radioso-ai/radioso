CREATE TABLE agent_bundle_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'applying', 'applied', 'failed', 'compensated')),
  -- This is provenance for a compensating workflow, so it intentionally survives
  -- the agent deletion that moves the job to `compensated`.
  agent_id UUID,
  unresolved JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_code TEXT CHECK (failure_code IN ('invalid_bundle', 'apply_failed')),
  cleanup_lease_token UUID,
  cleanup_lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  compensated_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX agent_bundle_imports_workspace_idempotency_active_idx
  ON agent_bundle_imports (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND state IN ('queued', 'applying', 'applied');

CREATE INDEX agent_bundle_imports_stale_applying_idx
  ON agent_bundle_imports (updated_at)
  WHERE state = 'applying' AND agent_id IS NOT NULL;
