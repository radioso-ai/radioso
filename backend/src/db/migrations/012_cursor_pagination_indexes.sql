CREATE INDEX IF NOT EXISTS documents_workspace_created_id_idx
  ON documents (workspace_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS conversations_workspace_updated_id_idx
  ON conversations (workspace_id, updated_at DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS conversations_workspace_anon_updated_id_idx
  ON conversations (workspace_id, anonymous_session_id, updated_at DESC, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS messages_conversation_created_id_idx
  ON messages (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_workspace_type_created_id_idx
  ON audit_events (workspace_id, event_type, created_at DESC, id DESC);
