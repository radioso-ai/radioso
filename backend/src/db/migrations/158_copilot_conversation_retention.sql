-- Retention sweep index for copilot conversations.
--
-- The existing index is (workspace_id, operator_user_id, updated_at DESC), which serves the
-- operator's own conversation list. The retention sweep asks the opposite question — every
-- conversation in the deployment last active before a cutoff, oldest first — and cannot use a
-- leading-column index it never constrains, so without this it degrades to a sequential scan on a
-- table that only ever grows.
--
-- Messages, proposals, and replay evidence all cascade from copilot_conversations, so no
-- companion index is needed for the rows the delete takes with it.
CREATE INDEX IF NOT EXISTS copilot_conversations_updated_at_idx
ON copilot_conversations
USING btree (updated_at);
