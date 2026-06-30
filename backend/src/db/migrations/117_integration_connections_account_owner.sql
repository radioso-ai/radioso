-- Spec 092 amendment (org parity), Slice 2a: org ownership foundation.
-- An OAuth-backed integration belongs to an organization (account), not just a workspace.
-- This adds account_id to the generic integration_connections spine and to slack_installations,
-- backfilled from the owning workspace's account. It is additive and behavior-preserving:
-- workspace_id remains populated and authoritative until Slice 2b re-homes Slack routing to the
-- account. Email and other single-workspace providers keep operating by workspace as before.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

UPDATE integration_connections ic
  SET account_id = w.account_id
  FROM workspaces w
  WHERE w.id = ic.workspace_id AND ic.account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_integration_connections_account
  ON integration_connections (account_id);

ALTER TABLE slack_installations
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

UPDATE slack_installations si
  SET account_id = w.account_id
  FROM workspaces w
  WHERE w.id = si.workspace_id AND si.account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_slack_installations_account
  ON slack_installations (account_id);
