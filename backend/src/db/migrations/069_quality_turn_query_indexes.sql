CREATE INDEX IF NOT EXISTS messages_workspace_role_created_id_idx
  ON messages (workspace_id, role, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_chat_answer_assistant_message_lookup_idx
  ON audit_events (workspace_id, (metadata_json ->> 'assistantMessageId'), created_at DESC, id DESC)
  WHERE event_type = 'chat.answer';
