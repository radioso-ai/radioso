-- Phase 1: Create workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_account_id ON workspaces (account_id);

-- Phase 2: Create default workspace for each existing account
INSERT INTO workspaces (id, account_id, name)
SELECT gen_random_uuid(), id, 'Default'
FROM accounts
ON CONFLICT DO NOTHING;

-- Phase 3: Create workspace_tokens table (replaces account_tokens)
CREATE TABLE IF NOT EXISTS workspace_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  encrypted_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_workspace_tokens_account_id ON workspace_tokens (account_id);

-- Migrate existing account_tokens to workspace_tokens
INSERT INTO workspace_tokens (id, workspace_id, account_id, token_prefix, token_hash, encrypted_token, created_at, last_used_at)
SELECT gen_random_uuid(), w.id, at.account_id, at.token_prefix, at.token_hash, at.encrypted_token, at.created_at, at.last_used_at
FROM account_tokens at
JOIN workspaces w ON w.account_id = at.account_id;

-- Phase 4: Add workspace_id to all workspace-scoped tables
ALTER TABLE documents ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE retrieval_settings ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE document_processing_jobs ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id);

-- Phase 5: Backfill workspace_id from account ownership
UPDATE documents SET workspace_id = w.id FROM workspaces w WHERE w.account_id = documents.account_id AND documents.workspace_id IS NULL;
UPDATE chunks SET workspace_id = w.id FROM workspaces w WHERE w.account_id = chunks.account_id AND chunks.workspace_id IS NULL;
UPDATE conversations SET workspace_id = w.id FROM workspaces w WHERE w.account_id = conversations.account_id AND conversations.workspace_id IS NULL;
UPDATE messages SET workspace_id = w.id FROM workspaces w WHERE w.account_id = messages.account_id AND messages.workspace_id IS NULL;
UPDATE document_processing_jobs SET workspace_id = w.id FROM workspaces w WHERE w.account_id = document_processing_jobs.account_id AND document_processing_jobs.workspace_id IS NULL;
UPDATE audit_events SET workspace_id = w.id FROM workspaces w WHERE w.account_id = audit_events.account_id AND audit_events.workspace_id IS NULL;

-- Backfill retrieval_settings: need to handle the PK change
-- First backfill workspace_id
UPDATE retrieval_settings SET workspace_id = w.id FROM workspaces w WHERE w.account_id = retrieval_settings.account_id AND retrieval_settings.workspace_id IS NULL;

-- Phase 6: Make workspace_id NOT NULL on workspace-scoped tables
ALTER TABLE documents ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE chunks ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE messages ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE document_processing_jobs ALTER COLUMN workspace_id SET NOT NULL;

-- Phase 7: Drop old account_id columns from workspace-scoped tables (keep on audit_events)
ALTER TABLE documents DROP COLUMN account_id;
ALTER TABLE chunks DROP COLUMN account_id;
ALTER TABLE conversations DROP COLUMN account_id;
ALTER TABLE messages DROP COLUMN account_id;
ALTER TABLE document_processing_jobs DROP COLUMN account_id;

-- Retrieval settings: change PK from account_id to workspace_id
ALTER TABLE retrieval_settings ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE retrieval_settings DROP CONSTRAINT retrieval_settings_pkey;
ALTER TABLE retrieval_settings ADD PRIMARY KEY (workspace_id);
ALTER TABLE retrieval_settings DROP COLUMN account_id;

-- Phase 8: Drop old account_tokens table
DROP TABLE IF EXISTS account_tokens;

-- Phase 9: Add indexes for workspace_id lookups
CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents (workspace_id);
CREATE INDEX IF NOT EXISTS idx_chunks_workspace_id ON chunks (workspace_id);
CREATE INDEX IF NOT EXISTS idx_conversations_workspace_id ON conversations (workspace_id);
