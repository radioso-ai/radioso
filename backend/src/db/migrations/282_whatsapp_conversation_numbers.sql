-- Typed attributes (#1884), slice 4: which WhatsApp number each WhatsApp conversation is with.
--
-- A number has one contact row, which moves to its latest conversation when a message after the
-- conversation timeout starts a new one, so nothing kept the number of an earlier conversation. A
-- data subject found by their number must reach every conversation they had, and the Inbox shows
-- a number's attribute values on its conversations, so each conversation now records its number
-- here as soon as its first WhatsApp message is stored, before the turn answers it. The row cascades
-- with its conversation and with its workspace. It is how the WhatsApp finder reaches a number's
-- conversations, the way `slack_conversation_links` and `email_thread_links` are for theirs.
--
-- Backfill. Only the conversation each contact row points at, the number's latest, can be named:
-- conversations that came before it were never recorded against their number.
--
-- Locks. Creating the foreign keys takes SHARE ROW EXCLUSIVE on `conversations` and `workspaces`,
-- which holds their writes (a new conversation, a turn's touch) until this file commits; reads go
-- through. The backfill reads one row per WhatsApp number, so the hold is short. The wait for the
-- locks is bounded to three seconds, because writes queue behind a waiting lock; a deploy that hits
-- the bound rolls back and a retry is safe.
--
-- Rollback is app-only: the previous release neither writes nor reads this table, and its rows
-- still cascade with their conversations.
SET LOCAL lock_timeout = '3s';

CREATE TABLE connector_whatsapp_conversations (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  wa_id VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connector_whatsapp_conversations_workspace_wa
  ON connector_whatsapp_conversations (workspace_id, wa_id);

INSERT INTO connector_whatsapp_conversations (conversation_id, workspace_id, wa_id, created_at)
SELECT contact.conversation_id, contact.workspace_id, contact.wa_id, conversation.created_at
  FROM connector_whatsapp_contacts contact
  JOIN conversations conversation ON conversation.id = contact.conversation_id
ON CONFLICT (conversation_id) DO NOTHING;
