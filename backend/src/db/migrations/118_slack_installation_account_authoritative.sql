-- Spec 092 amendment (org parity), Slice 2b: Slack installation owner is authoritative.
-- workspace_id remains populated as the installer / credential-home workspace.

UPDATE slack_installations si
  SET account_id = w.account_id
  FROM workspaces w
  WHERE w.id = si.workspace_id AND si.account_id IS NULL;

ALTER TABLE slack_installations
  ALTER COLUMN account_id SET NOT NULL;
