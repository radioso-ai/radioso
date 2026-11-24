-- Typed attributes (#1884), slice 4: a WhatsApp number is a person key. Values kept for the person a
-- WhatsApp conversation is with are stored under the scope `whatsapp_contact`, keyed by the number as
-- the WhatsApp channel stores it (`connector_whatsapp_contacts.wa_id`: digits, country code first, no
-- `+`). It is its own scope type rather than a namespaced `customer` id, so a host's customer id can
-- never name a number's values, nor the reverse.
--
-- Erasure. The number's values last as long as its latest conversation: the WhatsApp eraser hands
-- the numbers whose latest conversation goes to the context-variables eraser in the same
-- transaction, and the retention sweep runs the same erasers. A data subject's export carries them.
--
-- Locks. The runner applies a file in one transaction, so the ACCESS EXCLUSIVE lock the ALTER takes
-- is held until it commits, and every chat turn reads `context_variable_values`. The CHECK is
-- swapped in NOT VALID, which binds new rows at once without scanning the old ones, so the lock is
-- held for milliseconds. 281 validates it after this commits, under a lock no read or write waits
-- for. Every existing row satisfies it: it only widens the set it replaces. The wait for the lock is
-- bounded to three seconds, because reads queue behind a waiting ACCESS EXCLUSIVE; a deploy that hits
-- the bound rolls back and a retry is safe.
--
-- Rollback is app-only: the previous release runs on this schema and writes no `whatsapp_contact`
-- value. It neither erases nor exports the ones already written, though, so a WhatsApp conversation
-- erased while it runs leaves its number's values behind. Before a rollback, or after rolling forward
-- again, delete the values of numbers no conversation is with any more:
--
--   DELETE FROM context_variable_values v
--    WHERE scope_type = 'whatsapp_contact'
--      AND NOT EXISTS (SELECT 1 FROM connector_whatsapp_contacts c
--                       WHERE c.workspace_id = v.workspace_id AND c.wa_id = v.scope_id);
SET LOCAL lock_timeout = '3s';

ALTER TABLE context_variable_values
  DROP CONSTRAINT context_variable_values_scope_type_check,
  ADD CONSTRAINT context_variable_values_scope_type_check
    CHECK (scope_type IN ('conversation', 'session', 'customer', 'whatsapp_contact', 'agent', 'workspace')) NOT VALID;
