CREATE INDEX IF NOT EXISTS messages_workspace_conversation_created_id_idx
  ON messages (workspace_id, conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_events_chat_answer_conversation_lookup_idx
  ON audit_events (workspace_id, (metadata_json ->> 'conversationId'), created_at DESC, id DESC)
  WHERE event_type = 'chat.answer';

CREATE INDEX IF NOT EXISTS audit_events_chat_answer_assistant_lookup_idx
  ON audit_events (
    workspace_id,
    (metadata_json ->> 'conversationId'),
    (metadata_json ->> 'assistantMessageId'),
    created_at DESC,
    id DESC
  )
  WHERE event_type = 'chat.answer';

CREATE INDEX IF NOT EXISTS audit_events_document_search_search_id_lookup_idx
  ON audit_events (workspace_id, (metadata_json ->> 'searchId'), created_at DESC, id DESC)
  WHERE event_type = 'document.search';
