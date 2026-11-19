-- Workspace event subscriptions (#1852): a URL an automation client (Zapier, n8n, a custom
-- receiver) registers to receive the workspace event log's events as signed POSTs, one event per
-- request, in log order. The client creates and removes its own subscription over the API; a
-- `410 Gone` from the target removes it too.
--
-- Secrets. The target URL can itself be a bearer capability (a Zapier hook URL), so it is stored
-- encrypted like the signing secret, under CONNECTOR_ENCRYPTION_KEY. Only its host is kept in
-- plain text, for the Settings list.
--
-- One subscription per target. `target_url_hash` is an HMAC of the normalized target URL keyed
-- from CONNECTOR_ENCRYPTION_KEY, never the URL itself. Subscribing the same URL again in a
-- workspace (a client retrying a create whose response it lost) replaces that row rather than
-- adding a second one that would deliver every event twice.
--
-- Delivery. `cursor_tx` / `cursor_position` is the subscription's place in the log, the same
-- (transaction, position) order the log's reader pages by: set to the snapshot horizon when the
-- subscription is created, and advanced past each event its target accepts. The delivery columns
-- carry the last attempt's outcome, the failure streak, and when the next attempt is due.
--
-- Owner. Every push re-checks the credential or teammate that created the subscription, so the
-- creator columns name it. They are nulled when the credential, service account or user row goes,
-- and a subscription whose creator is gone is disabled at its next push.
--
-- Locks. The foreign keys take SHARE ROW EXCLUSIVE on workspaces, api_credentials,
-- workspace_service_accounts and users until the migration commits: writes to them wait, reads do
-- not. The table is new and empty, so it takes milliseconds; the wait for each lock is bounded to
-- three seconds, and a retry is safe.
SET LOCAL lock_timeout = '3s';

CREATE TABLE workspace_event_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (label IN ('zapier', 'n8n', 'custom')),
  target_url_ciphertext TEXT NOT NULL,
  target_url_hash TEXT NOT NULL CHECK (target_url_hash ~ '^[0-9a-f]{64}$'),
  target_host TEXT NOT NULL CHECK (length(target_host) BETWEEN 1 AND 255),
  secret_ciphertext TEXT NOT NULL,
  event_types TEXT[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 50),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_reason TEXT NULL CHECK (disabled_reason IN ('delivery_failing', 'creator_revoked')),
  disabled_at TIMESTAMPTZ NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('service_account', 'personal_token', 'teammate')),
  created_by_credential_id UUID NULL REFERENCES api_credentials(id) ON DELETE SET NULL,
  created_by_service_account_id UUID NULL REFERENCES workspace_service_accounts(id) ON DELETE SET NULL,
  created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  cursor_tx XID8 NOT NULL,
  cursor_position BIGINT NOT NULL DEFAULT 0,
  last_delivery_at TIMESTAMPTZ NULL,
  last_delivery_outcome TEXT NULL CHECK (last_delivery_outcome IN ('delivered', 'failed')),
  last_delivery_status_code SMALLINT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  failing_since TIMESTAMPTZ NULL,
  next_attempt_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_event_subscriptions_disabled_check CHECK (
    (status = 'active' AND disabled_reason IS NULL AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_reason IS NOT NULL AND disabled_at IS NOT NULL)
  )
);

-- A workspace's list, its cap, and the post-commit wake's scoped search.
CREATE INDEX workspace_event_subscriptions_workspace_idx ON workspace_event_subscriptions (workspace_id, status);

-- One subscription per target URL in a workspace.
CREATE UNIQUE INDEX workspace_event_subscriptions_target_idx
  ON workspace_event_subscriptions (workspace_id, target_url_hash);

-- The periodic sweep's search for active subscriptions that are due, across every workspace.
CREATE INDEX workspace_event_subscriptions_due_idx
  ON workspace_event_subscriptions (next_attempt_at)
  WHERE status = 'active';
