-- Validates the keys 228 added. A row orphaned between the two migrations goes first, as 228's did.

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

UPDATE notification_delivery_outcomes o
SET conversation_id = NULL
WHERE o.conversation_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = o.conversation_id);

DELETE FROM context_variables v
WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = v.workspace_id);

ALTER TABLE routine_states VALIDATE CONSTRAINT routine_states_session_id_fkey;
ALTER TABLE clarification_states VALIDATE CONSTRAINT clarification_states_session_id_fkey;
ALTER TABLE directive_states VALIDATE CONSTRAINT directive_states_session_id_fkey;
ALTER TABLE pending_decisions VALIDATE CONSTRAINT pending_decisions_conversation_id_fkey;
ALTER TABLE pending_decisions VALIDATE CONSTRAINT pending_decisions_session_id_fkey;
ALTER TABLE routine_action_requests VALIDATE CONSTRAINT routine_action_requests_conversation_id_fkey;
ALTER TABLE notification_delivery_outcomes VALIDATE CONSTRAINT notification_delivery_outcomes_conversation_id_fkey;
ALTER TABLE context_variables VALIDATE CONSTRAINT context_variables_workspace_id_fkey;
