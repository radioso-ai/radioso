ALTER TABLE users
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ NULL;

CREATE TABLE operator_mcp_clients (
  id UUID PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  registration_method TEXT NOT NULL CHECK (registration_method IN ('metadata_document', 'preregistered', 'dynamic')),
  application_type TEXT NOT NULL CHECK (application_type IN ('web', 'native')),
  display_name TEXT NOT NULL,
  client_uri TEXT NULL,
  redirect_uris JSONB NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none' CHECK (token_endpoint_auth_method = 'none'),
  metadata_digest TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revocation_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(redirect_uris) = 'array'),
  CHECK (btrim(display_name) <> '')
);

CREATE TABLE operator_mcp_client_metadata_snapshots (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES operator_mcp_clients(id) ON DELETE RESTRICT,
  client_version BIGINT NOT NULL CHECK (client_version > 0),
  metadata_digest TEXT NOT NULL,
  normalized_metadata JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('metadata_document', 'preregistered', 'compatibility')),
  validated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, client_version, metadata_digest),
  CHECK (jsonb_typeof(normalized_metadata) = 'object')
);

CREATE TABLE operator_mcp_authorization_transactions (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES operator_mcp_clients(id) ON DELETE RESTRICT,
  client_metadata_snapshot_id UUID NOT NULL REFERENCES operator_mcp_client_metadata_snapshots(id) ON DELETE RESTRICT,
  client_metadata_digest TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  requested_tool_scopes TEXT[] NOT NULL,
  requested_offline_access BOOLEAN NOT NULL DEFAULT FALSE,
  account_id UUID NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id UUID NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  membership_id UUID NULL REFERENCES account_memberships(id) ON DELETE CASCADE,
  approved_tool_scopes TEXT[] NULL,
  approved_offline_access BOOLEAN NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed', 'expired')),
  authorization_code_digest TEXT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ NULL,
  consumed_at TIMESTAMPTZ NULL,
  CHECK (cardinality(requested_tool_scopes) BETWEEN 1 AND 4),
  CHECK (requested_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose']::TEXT[]),
  CHECK (approved_tool_scopes IS NULL OR (
    cardinality(approved_tool_scopes) BETWEEN 1 AND 4
    AND approved_tool_scopes <@ requested_tool_scopes
  ))
);

CREATE INDEX operator_mcp_transactions_expiry_idx
  ON operator_mcp_authorization_transactions (expires_at, id);

CREATE TABLE operator_mcp_grants (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES operator_mcp_clients(id) ON DELETE RESTRICT,
  client_version BIGINT NOT NULL CHECK (client_version > 0),
  client_metadata_snapshot_id UUID NOT NULL REFERENCES operator_mcp_client_metadata_snapshots(id) ON DELETE RESTRICT,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Deliberately not a foreign key: this is the immutable tenure identity.
  -- Membership removal revokes the grant atomically but retains its audit and
  -- invocation history so a later invitation cannot revive the old lineage.
  membership_id UUID NOT NULL,
  resource TEXT NOT NULL,
  tool_scopes TEXT[] NOT NULL,
  offline_access BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'superseded', 'expired')),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  credential_epoch NUMERIC(39, 0) NOT NULL CHECK (credential_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,
  CHECK (cardinality(tool_scopes) BETWEEN 1 AND 4),
  CHECK (tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose']::TEXT[]),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX operator_mcp_grants_active_identity_idx
  ON operator_mcp_grants (user_id, client_id, workspace_id, resource)
  WHERE status = 'active';
CREATE INDEX operator_mcp_grants_workspace_created_idx
  ON operator_mcp_grants (workspace_id, created_at DESC, id DESC);

CREATE TABLE operator_mcp_access_credentials (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES operator_mcp_grants(id) ON DELETE CASCADE,
  token_digest TEXT NOT NULL UNIQUE,
  issued_grant_version BIGINT NOT NULL CHECK (issued_grant_version > 0),
  issued_client_version BIGINT NOT NULL CHECK (issued_client_version > 0),
  issued_client_metadata_snapshot_id UUID NOT NULL REFERENCES operator_mcp_client_metadata_snapshots(id) ON DELETE RESTRICT,
  issued_credential_epoch NUMERIC(39, 0) NOT NULL CHECK (issued_credential_epoch > 0),
  issued_tool_scopes TEXT[] NOT NULL,
  issued_offline_access BOOLEAN NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NULL,
  CHECK (cardinality(issued_tool_scopes) BETWEEN 1 AND 4),
  CHECK (issued_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose']::TEXT[])
);

CREATE INDEX operator_mcp_access_credentials_expiry_idx
  ON operator_mcp_access_credentials (expires_at, id);

CREATE TABLE operator_mcp_refresh_lineages (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES operator_mcp_grants(id) ON DELETE CASCADE,
  client_version BIGINT NOT NULL CHECK (client_version > 0),
  client_metadata_snapshot_id UUID NOT NULL REFERENCES operator_mcp_client_metadata_snapshots(id) ON DELETE RESTRICT,
  credential_epoch NUMERIC(39, 0) NOT NULL CHECK (credential_epoch > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  current_generation BIGINT NOT NULL DEFAULT 1 CHECK (current_generation > 0),
  issued_tool_scopes TEXT[] NOT NULL,
  offline_access BOOLEAN NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  revoked_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cardinality(issued_tool_scopes) BETWEEN 1 AND 4),
  CHECK (issued_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose']::TEXT[])
);

CREATE TABLE operator_mcp_refresh_generations (
  lineage_id UUID NOT NULL REFERENCES operator_mcp_refresh_lineages(id) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  token_digest TEXT NOT NULL UNIQUE,
  issued_tool_scopes TEXT[] NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (lineage_id, generation),
  CHECK (cardinality(issued_tool_scopes) BETWEEN 1 AND 4),
  CHECK (issued_tool_scopes <@ ARRAY['operator:read', 'operator:probe', 'operator:act', 'operator:propose']::TEXT[])
);

CREATE TABLE operator_mcp_deployment_credential_state (
  resource TEXT PRIMARY KEY,
  credential_epoch NUMERIC(39, 0) NOT NULL CHECK (credential_epoch > 0),
  key_fingerprint TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE operator_mcp_invocations (
  id UUID PRIMARY KEY,
  credential_id UUID NOT NULL REFERENCES operator_mcp_access_credentials(id) ON DELETE RESTRICT,
  grant_id UUID NOT NULL REFERENCES operator_mcp_grants(id) ON DELETE RESTRICT,
  grant_version BIGINT NOT NULL CHECK (grant_version > 0),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES operator_mcp_clients(id) ON DELETE RESTRICT,
  method TEXT NOT NULL CHECK (method IN ('ping', 'tools/list', 'tools/call')),
  descriptor_name TEXT NULL,
  shape TEXT NULL CHECK (shape IS NULL OR shape IN ('read', 'probe', 'act', 'propose')),
  operation_id TEXT NULL,
  input_digest TEXT NOT NULL,
  verification_cost INTEGER NOT NULL DEFAULT 0 CHECK (verification_cost BETWEEN 0 AND 6),
  budget_reserved_at TIMESTAMPTZ NULL,
  proof_nonce_digest TEXT NOT NULL UNIQUE,
  proof_consumed_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'running', 'completed', 'refused', 'failed')),
  safe_outcome_code TEXT NULL,
  result_reference TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL,
  retained_until TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX operator_mcp_invocations_operation_idx
  ON operator_mcp_invocations (grant_id, operation_id)
  WHERE operation_id IS NOT NULL;
CREATE INDEX operator_mcp_invocations_budget_idx
  ON operator_mcp_invocations (grant_id, budget_reserved_at)
  WHERE budget_reserved_at IS NOT NULL;

ALTER TABLE copilot_proposals
  ALTER COLUMN conversation_id DROP NOT NULL,
  ADD COLUMN operator_mcp_invocation_id UUID NULL
    REFERENCES operator_mcp_invocations(id) ON DELETE RESTRICT,
  ADD CONSTRAINT copilot_proposals_exactly_one_origin_check CHECK (
    (conversation_id IS NOT NULL) <> (operator_mcp_invocation_id IS NOT NULL)
  ),
  ADD CONSTRAINT copilot_proposals_message_requires_conversation_check CHECK (
    message_id IS NULL OR conversation_id IS NOT NULL
  );

CREATE INDEX copilot_proposals_operator_mcp_invocation_idx
  ON copilot_proposals (operator_mcp_invocation_id)
  WHERE operator_mcp_invocation_id IS NOT NULL;

ALTER TABLE copilot_replay_evidence
  ALTER COLUMN conversation_id DROP NOT NULL,
  ADD COLUMN operator_mcp_invocation_id UUID NULL
    REFERENCES operator_mcp_invocations(id) ON DELETE RESTRICT,
  ADD COLUMN proposal_id UUID NULL
    REFERENCES copilot_proposals(id) ON DELETE CASCADE,
  ADD CONSTRAINT copilot_replay_evidence_exactly_one_origin_check CHECK (
    (conversation_id IS NOT NULL) <> (operator_mcp_invocation_id IS NOT NULL)
  );

CREATE INDEX copilot_replay_evidence_operator_mcp_invocation_idx
  ON copilot_replay_evidence (operator_mcp_invocation_id)
  WHERE operator_mcp_invocation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_copilot_replay_evidence_origin()
RETURNS trigger AS $$
DECLARE
  proposal_conversation_id UUID;
  proposal_invocation_id UUID;
BEGIN
  IF NEW.proposal_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT conversation_id, operator_mcp_invocation_id
    INTO proposal_conversation_id, proposal_invocation_id
    FROM copilot_proposals
    WHERE id = NEW.proposal_id;
  IF NOT FOUND OR proposal_conversation_id IS DISTINCT FROM NEW.conversation_id
    OR proposal_invocation_id IS DISTINCT FROM NEW.operator_mcp_invocation_id THEN
    RAISE EXCEPTION 'copilot replay evidence origin must match proposal origin';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER copilot_replay_evidence_origin_guard
  BEFORE INSERT OR UPDATE OF proposal_id, conversation_id, operator_mcp_invocation_id
  ON copilot_replay_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_copilot_replay_evidence_origin();
