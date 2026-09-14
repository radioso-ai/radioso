-- Test-execution conversations are private operator evidence, not public chat history.
ALTER TABLE conversations
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'production'
  CHECK (purpose IN ('production', 'operator_test'));

CREATE INDEX idx_conversations_operator_test_purpose
  ON conversations (workspace_id, purpose)
  WHERE purpose = 'operator_test';
