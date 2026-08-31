-- Personal API credentials and service-account credentials deliberately share a
-- verifier store. The secret is never stored: token_hash is sufficient for an
-- opaque, high-entropy bearer credential lookup.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspaces_id_account_id_key'
      AND conrelid = 'workspaces'::regclass
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_id_account_id_key UNIQUE (id, account_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_service_accounts (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  status TEXT NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled', 'disabled', 'archived')),
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (btrim(display_name) <> ''),
  CHECK ((status <> 'disabled') OR disabled_at IS NOT NULL),
  CHECK ((status <> 'archived') OR archived_at IS NOT NULL),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_service_accounts_workspace_active
  ON workspace_service_accounts (workspace_id, created_at DESC)
  WHERE status <> 'archived';

CREATE TABLE IF NOT EXISTS api_credentials (
  id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'service')),
  label TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role_ceiling TEXT CHECK (role_ceiling IN ('member', 'admin')),
  owner_user_id UUID,
  access_tenure_membership_id UUID,
  service_account_id UUID REFERENCES workspace_service_accounts(id) ON DELETE CASCADE,
  created_by_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID,
  revocation_reason TEXT CHECK (revocation_reason IN (
    'explicit', 'rotated', 'service_account_archived', 'membership_ended',
    'workspace_deleted', 'account_deleted', 'user_deleted'
  )),
  rotated_from_credential_id UUID REFERENCES api_credentials(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (btrim(label) <> ''),
  CHECK (
    (kind = 'personal' AND owner_user_id IS NOT NULL AND access_tenure_membership_id IS NOT NULL
      AND role_ceiling IS NOT NULL AND service_account_id IS NULL)
    OR
    (kind = 'service' AND service_account_id IS NOT NULL AND owner_user_id IS NULL
      AND access_tenure_membership_id IS NULL AND role_ceiling IS NULL)
  ),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_credentials_personal_active
  ON api_credentials (workspace_id, owner_user_id, created_at DESC)
  WHERE kind = 'personal' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_credentials_service_active
  ON api_credentials (service_account_id, created_at DESC)
  WHERE kind = 'service' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_credentials_workspace_created
  ON api_credentials (workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_api_credentials_expiry_warning_scan
  ON api_credentials (expires_at, id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS api_credential_expiry_warnings (
  credential_id UUID NOT NULL REFERENCES api_credentials(id) ON DELETE CASCADE,
  threshold_days INTEGER NOT NULL CHECK (threshold_days IN (30, 7, 1)),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (credential_id, threshold_days)
);

CREATE TABLE IF NOT EXISTS legacy_workspace_credential_tombstones (
  legacy_token_id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  account_id UUID NOT NULL,
  token_prefix TEXT NOT NULL,
  final_status TEXT NOT NULL DEFAULT 'destroyed' CHECK (final_status = 'destroyed'),
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  system_reason TEXT NOT NULL DEFAULT 'legacy_workspace_credential_destroyed'
);

-- This is intentionally destructive and runs in the migration transaction. A
-- retry sees either the old table intact (rollback) or this completed state;
-- the tombstone key makes the copy idempotent in environments that replay it.
DO $$
BEGIN
  IF to_regclass('workspace_tokens') IS NOT NULL THEN
    EXECUTE $copy$
      WITH destroyed AS (
        INSERT INTO legacy_workspace_credential_tombstones
          (legacy_token_id, workspace_id, account_id, token_prefix, final_status, migrated_at, system_reason)
        SELECT id, workspace_id, account_id, token_prefix,
               'destroyed', NOW(), 'legacy_workspace_credential_destroyed'
        FROM workspace_tokens
        ON CONFLICT (legacy_token_id) DO NOTHING
        RETURNING legacy_token_id, workspace_id, account_id, token_prefix, system_reason
      )
      INSERT INTO audit_events (id, account_id, workspace_id, event_type, event_status, metadata_json)
      SELECT gen_random_uuid(), account_id, workspace_id,
             'machine_access.legacy_workspace_credential.destroyed', 'success',
             jsonb_build_object(
               'legacyTokenId', legacy_token_id,
               'tokenPrefix', token_prefix,
               'principalKind', 'legacy_workspace_credential',
               'reason', system_reason,
               'systemInitiated', true
             )
      FROM destroyed
    $copy$;
  END IF;
END $$;

DROP TABLE IF EXISTS workspace_tokens;
