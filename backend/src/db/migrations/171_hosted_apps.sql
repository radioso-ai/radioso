-- Hosted App Runtime, Release A control plane.
--
-- Every table here is Radioso-owned and generic: an App declares logical
-- collections and contributions in its manifest and never gets a table of its
-- own. Manifest content lives in `app_releases.manifest`; nothing else stores a
-- copy of it, so an admission decision or a plan records identities, counts, and
-- reason codes rather than duplicating the document that produced them.

CREATE TABLE IF NOT EXISTS app_releases (
  id UUID PRIMARY KEY,
  app_id TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest JSONB NOT NULL,
  manifest_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  publisher_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'submitted', 'validating', 'admitted', 'rejected',
    'withdrawn', 'deprecated', 'revoked', 'quarantined'
  )),
  admission_policy_version TEXT NOT NULL,
  admission_decision JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, version)
);

CREATE INDEX IF NOT EXISTS idx_app_releases_installable
  ON app_releases (app_id, created_at DESC)
  WHERE state = 'admitted';

CREATE TABLE IF NOT EXISTS app_installations (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  active_release_id UUID REFERENCES app_releases(id),
  candidate_release_id UUID REFERENCES app_releases(id),
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'provisioning', 'staged', 'testing', 'ready',
    'active', 'disabled', 'failed', 'removing', 'removed'
  )),
  -- Non-secret values only. Secret material is a connection, never configuration.
  configuration JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  health JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live installation of an App per workspace. A removed row stays for audit
-- and data-disposition history, so the constraint excludes it rather than the
-- reinstall being blocked forever by a tombstone.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_installations_workspace_app_live
  ON app_installations (workspace_id, app_id)
  WHERE state <> 'removed';

CREATE TABLE IF NOT EXISTS app_installation_plans (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  release_id UUID NOT NULL REFERENCES app_releases(id) ON DELETE CASCADE,
  checksum TEXT NOT NULL,
  plan JSONB NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_app_installation_plans_workspace
  ON app_installation_plans (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_grants (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES app_installations(id) ON DELETE CASCADE,
  release_id UUID NOT NULL REFERENCES app_releases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('permission', 'destination', 'collection', 'contribution')),
  key TEXT NOT NULL,
  plan_id UUID REFERENCES app_installation_plans(id) ON DELETE SET NULL,
  approved_by UUID,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_grants_live
  ON app_grants (installation_id, release_id, kind, key)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS app_connections (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES app_installations(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('secret_fields', 'generated_secret')),
  -- Only the slot's non-sensitive fields. Everything sensitive is inside the ciphertext.
  public_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext TEXT,
  encryption_key_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at TIMESTAMPTZ,
  deletion_requested_at TIMESTAMPTZ,
  UNIQUE (installation_id, slot_id),
  CHECK ((secret_ciphertext IS NULL) = (encryption_key_id IS NULL))
);

CREATE TABLE IF NOT EXISTS app_lifecycle_operations (
  id UUID PRIMARY KEY,
  installation_id UUID NOT NULL REFERENCES app_installations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('install', 'disable', 'enable', 'remove', 'dispose_data')),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed', 'compensating')),
  -- Durable cursor: the last step this operation completed. NULL means no step
  -- has committed yet, so a resume starts from the first step of the kind.
  step TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  initiated_by JSONB NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_lifecycle_operations_resumable
  ON app_lifecycle_operations (installation_id, created_at DESC)
  WHERE state IN ('running', 'compensating');
