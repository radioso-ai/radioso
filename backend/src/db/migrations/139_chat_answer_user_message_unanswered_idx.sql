CREATE INDEX IF NOT EXISTS audit_events_chat_answer_user_message_unanswered_idx
  ON audit_events (
    workspace_id,
    (metadata_json ->> 'conversationId'),
    (metadata_json ->> 'userMessageId'),
    created_at DESC,
    id DESC
  )
  WHERE event_type = 'chat.answer'
    AND event_status IN ('failure', 'cancelled')
    AND metadata_json ->> 'assistantMessageId' IS NULL;
