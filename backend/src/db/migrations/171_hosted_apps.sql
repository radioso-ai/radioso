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
  -- What a reconfigure proposes, staged beside the configuration that is still running.
  -- The working configuration above is never overwritten until the staging and test ports
  -- have accepted the candidate, so a failed reconfigure costs nothing.
  candidate_configuration JSONB,
  -- Names the candidate, so a staging implementation can tell one proposal from the next
  -- and discard the one it was asked to drop.
  candidate_revision TEXT,
  -- Set in the first transaction of a disable or a remove. Execution eligibility denies
  -- while it is set, so no new invocation is admitted during the teardown window.
  execution_denied_at TIMESTAMPTZ,
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
  -- The tenant the operation belongs to. An idempotency key is a client's name for its own
  -- retry, so it is unique within a workspace and nowhere wider: a globally unique key
  -- would let one workspace's key collide with another's and answer the second tenant with
  -- the first tenant's operation.
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES app_installations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'install', 'activate', 'reconfigure', 'disable', 'enable', 'remove', 'dispose_data'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'running', 'completed', 'failed', 'compensating', 'compensation_failed'
  )),
  -- Durable cursor: the last step this operation completed. NULL means no step
  -- has committed yet, so a resume starts from the first step of the kind.
  step TEXT,
  -- Durable cursor for the reverse direction: the last compensator that completed.
  -- A rollback interrupted halfway continues from here instead of replaying
  -- reversals that already ran.
  compensation_step TEXT,
  -- Which driver currently owns the next step, and until when. A driver claims the exact
  -- (operation, state, step) triple before it calls any port; a driver that loses the claim
  -- stops without an effect and without changing anything, which is what stops one driver's
  -- transient transport failure from compensating another driver's successful step.
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL,
  -- What the request asked for, normalized. The same key with a different
  -- fingerprint is a reused key, not a retry, and is refused rather than
  -- answered with the earlier operation.
  request_fingerprint TEXT NOT NULL,
  initiated_by JSONB NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key)
);

-- One operation may be in flight per installation. The service reads before it
-- inserts, but that read and this insert are not atomic, so this partial unique
-- index is what actually serializes two concurrent commands; the repository
-- translates its violation into `operation_in_progress`.
--
-- `compensation_failed` stays inside the fence on purpose. Rollback that could not finish
-- may have left a runtime alive under a known effect id, so the installation is not free
-- for a new command; only a repair removal may start, and it deprovisions that effect id
-- first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_lifecycle_operations_in_flight
  ON app_lifecycle_operations (installation_id)
  WHERE state IN ('running', 'compensating', 'compensation_failed');

-- Audit intents written in the same transaction as the state or cursor change they
-- describe. A sink that is down must not roll back a runtime that is already running, and
-- must not silently lose the record either, so the intent is durable and a dispatcher
-- delivers it after the commit and again at start-up.
CREATE TABLE IF NOT EXISTS app_audit_outbox (
  id UUID PRIMARY KEY,
  -- Null for a release-level event: admission and revocation belong to the host, not to
  -- one workspace.
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_app_audit_outbox_undelivered
  ON app_audit_outbox (created_at)
  WHERE delivered_at IS NULL;
