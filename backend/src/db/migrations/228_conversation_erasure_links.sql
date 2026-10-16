-- Conversation erasure (#1540): every row derived from a conversation goes when the conversation
-- does. These tables named a conversation without a foreign key, so deleting a workspace orphaned
-- their rows: a routine's extracted slot values, a pending decision, a clarification, a directive's
-- firing memory, a queued routine action. Their orphans are exactly what an erasure must not leave
-- behind, so they go first; then each column gets a cascading key. Each key is added NOT VALID here
-- and validated by the next migration, which takes a lighter lock.
--
-- `notification_delivery_outcomes` is the daily email cap's ledger: deleting a conversation must not
-- hand its emails back to the day's budget, so that row keeps its counts and loses the link.
--
-- `context_variables` named its workspace without a key, so a deleted workspace left its variables
-- behind, and with them every value a host pushed for a session or a verified customer. They cascade
-- from the workspace from here on.

DELETE FROM routine_states s
WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.session_id);

DELETE FROM clarification_states s
WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.session_id);

DELETE FROM directive_states s
WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = s.session_id);

DELETE FROM pending_decisions d
WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.conversation_id)
   OR NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = d.session_id);

DELETE FROM routine_action_requests r
WHERE r.conversation_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.conversation_id);

DELETE FROM context_variables v
WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = v.workspace_id);

ALTER TABLE notification_delivery_outcomes
  ALTER COLUMN conversation_id DROP NOT NULL;

UPDATE notification_delivery_outcomes o
SET conversation_id = NULL
WHERE o.conversation_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = o.conversation_id);

-- The cascades and the erasers look rows up by these columns.
CREATE INDEX IF NOT EXISTS pending_decisions_conversation_idx
  ON pending_decisions (conversation_id);
CREATE INDEX IF NOT EXISTS pending_decisions_session_idx
  ON pending_decisions (session_id);
CREATE INDEX IF NOT EXISTS routine_action_requests_conversation_idx
  ON routine_action_requests (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notification_delivery_outcomes_conversation_link_idx
  ON notification_delivery_outcomes (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_skill_activity_conversation_idx
  ON email_skill_activity (workspace_id, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_conversation_idx
  ON email_inbound_deliveries (conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_inbound_deliveries_planned_conversation_idx
  ON email_inbound_deliveries (planned_conversation_id) WHERE planned_conversation_id IS NOT NULL;
-- Deleting a message clears or removes its rows in these two tables, the largest a message's cascade
-- reaches; without an index each deleted message scans them whole.
CREATE INDEX IF NOT EXISTS usage_events_message_idx
  ON usage_events (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS topic_memberships_message_idx
  ON topic_memberships (message_id);

ALTER TABLE routine_states
  ADD CONSTRAINT routine_states_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE clarification_states
  ADD CONSTRAINT clarification_states_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE directive_states
  ADD CONSTRAINT directive_states_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE pending_decisions
  ADD CONSTRAINT pending_decisions_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT pending_decisions_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE routine_action_requests
  ADD CONSTRAINT routine_action_requests_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE notification_delivery_outcomes
  ADD CONSTRAINT notification_delivery_outcomes_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE context_variables
  ADD CONSTRAINT context_variables_workspace_id_fkey
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE NOT VALID;
