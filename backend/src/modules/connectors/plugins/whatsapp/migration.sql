CREATE TABLE IF NOT EXISTS connector_whatsapp_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id VARCHAR(32) NOT NULL,
  profile_name VARCHAR(255),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, wa_id)
);

CREATE TABLE IF NOT EXISTS connector_whatsapp_message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wamid VARCHAR(128) NOT NULL UNIQUE,
  direction VARCHAR(8) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wa_id VARCHAR(32) NOT NULL,
  message_type VARCHAR(32) NOT NULL,
  payload JSONB NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('received', 'processing', 'replied', 'failed')),
  error_details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connector_whatsapp_message_log_workspace_wa_created
  ON connector_whatsapp_message_log (workspace_id, wa_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connector_whatsapp_message_log_created_at
  ON connector_whatsapp_message_log (created_at);
