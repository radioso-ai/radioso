ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS mcp_assistant_access_enabled BOOLEAN NOT NULL DEFAULT false;
